import {
  classifyReleaseJobExit,
  decideReleaseJobRecovery,
  describeReleaseJobOutcome,
  describeReportedReleaseJob,
  type ReleaseJobClaimResponse,
  type ReleaseJobContainerObservation,
  type ReleaseJobOutcome,
  type ReleaseJobReport,
  type ReleasePhase,
  type VerificationFailurePolicy,
} from "@repo/runtime/release-phases";
import type { BuildLogEmitter } from "./build-logs.js";
import type { DockerApiClient, DockerContainerInspection } from "./docker-api.js";
import type { DockerResourceSettings } from "./docker-resource-limits.js";
import type { AppRolloutResult } from "./protocol.js";

/**
 * Runs one release phase of a deployment (#287) — the pre-activation job or the verification — in a
 * one-off container of the candidate image, under a claim the control plane records.
 *
 * Every attempt has a deterministic container name, and the container is kept until the control
 * plane has acknowledged its outcome. A restarted agent that is told to resume an attempt can
 * therefore read the result from the container instead of running the command again; when the
 * container is gone it reports the outcome as unknown and leaves the decision to an operator.
 */

export type ReleaseJobDocker = Pick<
  DockerApiClient,
  | "containerLogEntries"
  | "createContainer"
  | "inspectContainer"
  | "listContainersByLabels"
  | "removeContainer"
  | "startContainer"
  | "stopContainer"
>;

/** The control plane's side of a phase, bound to one leased work item. */
export interface ReleaseJobControlPlane {
  claim(
    phase: ReleasePhase,
    context: { runningJobDeploymentIds: string[] }
  ): Promise<ReleaseJobClaimResponse>;
  report(phase: ReleasePhase, report: ReleaseJobReport): Promise<void>;
}

export interface ReleaseJobClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What a release job container runs as: the candidate's image, network, env and limits. */
export interface ReleaseJobTarget {
  serviceId: string;
  deploymentId: string;
  image: string;
  networkName: string;
  /** The environment the candidate runtime gets, including anything the agent pins, like PORT. */
  envVars: Record<string, string>;
  /** Base ownership labels; the runner adds its own `nouva.release.*` labels. */
  labels: Record<string, string>;
  /** Docker resource settings of the service, so a job cannot outgrow what the service may use. */
  resourceSettings: DockerResourceSettings;
  redactLogLine: (line: string) => string;
  /** Makes `image` available to Docker, pulling it from the local registry when needed. */
  prepareImage: () => Promise<void>;
}

export interface ReleasePhaseRequest {
  phase: ReleasePhase;
  command: string;
  timeoutSeconds: number;
  /** Extra variables only this phase sees, e.g. the candidate URL for a verification. */
  phaseEnv?: Record<string, string>;
  /** Verification only: the policy the agent will apply to a result that is not a success. */
  resolveAppliedPolicy?: (
    outcome: ReleaseJobOutcome
  ) => VerificationFailurePolicy | null | Promise<VerificationFailurePolicy | null>;
  /** Verification only: the configured policy, to word the local failure message. */
  configuredPolicy?: VerificationFailurePolicy | null;
}

export type ReleasePhaseResult =
  | { kind: "succeeded"; attempt: number }
  | {
      kind: "unsuccessful";
      attempt: number;
      outcome: Exclude<ReleaseJobOutcome, "succeeded">;
      message: string;
      /**
       * Verification only: the policy this run reported for the result. `null` for a pre-activation
       * job and for a verification settled before this run, whose policy was applied back then.
       */
      appliedPolicy: VerificationFailurePolicy | null;
    };

export interface ReleasePhaseRunner {
  run(target: ReleaseJobTarget, request: ReleasePhaseRequest): Promise<ReleasePhaseResult>;
}

const POLL_INTERVAL_MS = 1_000;
const STOP_GRACE_SECONDS = 5;
const LOG_TAIL_LINES = 1_000;
// Long enough to ride out a control-plane restart or blue/green switch; the lease is renewed
// meanwhile, and past it the work is given back rather than failed (see `callControlPlane`).
const CONTROL_PLANE_RETRY_BUDGET_MS = 120_000;
const CONTROL_PLANE_RETRY_INITIAL_DELAY_MS = 2_000;
const CONTROL_PLANE_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Raised when a pre-activation job did not definitely succeed. It carries a rollout result so the
 * control plane knows the previous deployment is still the one serving.
 */
export class ReleaseJobHaltError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, rollout: AppRolloutResult | { liveRuntimePreserved: boolean }) {
    super(message);
    this.name = "ReleaseJobHaltError";
    this.result = { rollout };
  }
}

/**
 * Raised when the work has to stop without a terminal report, so the control plane hands it out
 * again instead of failing it: either it answered a claim with `wait` (and already put the work back
 * in the queue), or the outcome of a pre-activation attempt could not be delivered (and the lease
 * is left to expire, after which the next lease resumes the attempt from its kept container).
 */
export class ReleaseJobDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseJobDeferredError";
  }
}

const PHASE_LABEL: Record<ReleasePhase, string> = {
  pre_activation: "pre-activation",
  verification: "verification",
};

export function buildReleaseJobContainerName(input: {
  serviceId: string;
  deploymentId: string;
  phase: ReleasePhase;
  attempt: number;
}): string {
  const phase = input.phase === "pre_activation" ? "pre" : "verify";
  return `nouva-release-${input.serviceId.slice(0, 8)}-${input.deploymentId.slice(0, 8)}-${phase}-${input.attempt}`;
}

function observeContainer(
  inspection: DockerContainerInspection | null
): ReleaseJobContainerObservation {
  if (!inspection) {
    return { state: "missing" };
  }
  const status = inspection.State?.Status;
  if (inspection.State?.Running || status === "running" || status === "restarting") {
    return { state: "running" };
  }
  if (status === "created") {
    return { state: "created" };
  }
  return {
    state: "exited",
    exitCode: inspection.State?.ExitCode ?? 1,
    startedAt: inspection.State?.StartedAt ?? null,
    finishedAt: inspection.State?.FinishedAt ?? null,
  };
}

function readStartedAtMs(inspection: DockerContainerInspection | null): number | null {
  const value = inspection?.State?.StartedAt;
  if (!value || value.startsWith("0001-")) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createReleasePhaseRunner(dependencies: {
  docker: ReleaseJobDocker;
  controlPlane: ReleaseJobControlPlane;
  clock: ReleaseJobClock;
  onBuildLog?: BuildLogEmitter;
}): ReleasePhaseRunner {
  const { docker, controlPlane, clock, onBuildLog } = dependencies;

  // The control plane drops a progress entry without a percent. Release jobs run while the
  // deployment is starting, where the build log already stands at 90.
  const progress = (message: string) =>
    onBuildLog?.({
      type: "progress",
      stage: "deploying",
      percent: 90,
      message,
      timestamp: clock.now(),
    });

  /**
   * Removes the exited containers this deployment's earlier attempts of a phase left behind. A
   * running one is never removed: its command may be halfway through, and the claim that let the
   * phase go on was answered knowing it was not running when the agent asked.
   */
  async function removeSettledAttempts(target: ReleaseJobTarget, phase: ReleasePhase) {
    const leftovers = await docker.listContainersByLabels({
      "nouva.kind": "release_job",
      "nouva.deployment.id": target.deploymentId,
      "nouva.release.phase": phase,
    });
    for (const container of leftovers) {
      if (observeContainer(container).state !== "running") {
        await docker.removeContainer(container.Id, true);
      }
    }
  }

  function listServiceJobs(target: ReleaseJobTarget) {
    return docker.listContainersByLabels({
      "nouva.kind": "release_job",
      "nouva.service.id": target.serviceId,
    });
  }

  function listOtherDeploymentsJobs(target: ReleaseJobTarget) {
    return listServiceJobs(target).then((containers) =>
      containers.filter(
        (container) => container.Config?.Labels?.["nouva.deployment.id"] !== target.deploymentId
      )
    );
  }

  /**
   * The deployments whose job containers are still running, for the claim to wait on: any job of
   * another deployment of the service, and an earlier attempt of this deployment's own phase. A
   * container past its own deadline is stopped first, exactly as its runner would have done had it
   * still been around; a job still inside its deadline is never touched, whoever it belongs to.
   */
  async function readRunningJobs(target: ReleaseJobTarget, phase: ReleasePhase): Promise<string[]> {
    const running = new Set<string>();
    for (const container of await listServiceJobs(target)) {
      if (observeContainer(container).state !== "running") {
        continue;
      }
      const ownPhase =
        container.Config?.Labels?.["nouva.deployment.id"] === target.deploymentId &&
        container.Config?.Labels?.["nouva.release.phase"] === phase;
      const otherDeployment =
        container.Config?.Labels?.["nouva.deployment.id"] !== target.deploymentId;
      if (!ownPhase && !otherDeployment) {
        continue;
      }
      const labels = container.Config?.Labels ?? {};
      const timeoutSeconds = Number(labels["nouva.release.timeout_seconds"]);
      const startedAtMs = readStartedAtMs(container);
      if (
        Number.isFinite(timeoutSeconds) &&
        timeoutSeconds > 0 &&
        startedAtMs !== null &&
        clock.now() >= startedAtMs + timeoutSeconds * 1_000
      ) {
        await docker.stopContainer(container.Id, STOP_GRACE_SECONDS);
        if (observeContainer(await docker.inspectContainer(container.Id)).state !== "running") {
          continue;
        }
      }
      const deploymentId = labels["nouva.deployment.id"];
      if (deploymentId) {
        running.add(deploymentId);
      }
    }
    return [...running];
  }

  /**
   * Removes the exited job containers other deployments of the service left behind, for example
   * after a report that never landed. Only called once the control plane let this deployment run a
   * phase, which for a pre-activation job means no other deployment's is unsettled: none of those
   * containers is still evidence an attempt could be resumed from. Verifications are never resumed,
   * so an exited one can always go.
   */
  async function removeOtherDeploymentsExitedJobs(target: ReleaseJobTarget, phase: ReleasePhase) {
    for (const container of await listOtherDeploymentsJobs(target)) {
      const containerPhase = container.Config?.Labels?.["nouva.release.phase"];
      if (phase === "verification" && containerPhase !== "verification") {
        continue;
      }
      if (observeContainer(container).state === "running") {
        continue;
      }
      await docker.removeContainer(container.Id, true);
    }
  }

  /**
   * A verification whose outcome was not acknowledged is never resumed: the deployment keeps
   * serving and the control plane settles the attempt as unknown. Its container would otherwise
   * keep running, past its timeout, with the service's env on the project network.
   */
  async function discardUnreportedVerification(containerName: string) {
    try {
      await docker.removeContainer(containerName, true);
    } catch (error) {
      // Best effort: the error that interrupted the verification is the one worth propagating,
      // and the next deployment of the service sweeps what is left.
      console.warn(`[nouva-agent] could not remove verification container ${containerName}`, error);
    }
  }

  async function createJobContainer(
    target: ReleaseJobTarget,
    request: ReleasePhaseRequest,
    containerName: string,
    attempt: number
  ) {
    const env = {
      ...target.envVars,
      ...request.phaseEnv,
      NOUVA_RELEASE_PHASE: request.phase,
      NOUVA_DEPLOYMENT_ID: target.deploymentId,
    };
    await docker.createContainer({
      name: containerName,
      image: target.image,
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      // Not a login shell: -l sources /etc/profile, which resets PATH and drops the image's own
      // tool paths (mise, a virtualenv, bun), so the command would not be found.
      entrypoint: ["/bin/sh", "-c"],
      cmd: [request.command],
      labels: {
        ...target.labels,
        "nouva.kind": "release_job",
        "nouva.service.id": target.serviceId,
        "nouva.deployment.id": target.deploymentId,
        "nouva.release.phase": request.phase,
        "nouva.release.attempt": String(attempt),
        // Lets another deployment stop this job at its deadline should this runner be gone.
        "nouva.release.timeout_seconds": String(request.timeoutSeconds),
      },
      hostConfig: {
        // A job never mounts the service volume: the candidate is not live yet, and a migration
        // belongs in the database it connects to, not in files beside the running release.
        AutoRemove: false,
        RestartPolicy: { Name: "no" },
        ...target.resourceSettings,
      },
      networkingConfig: { EndpointsConfig: { [target.networkName]: {} } },
    });
  }

  /** Waits for the container to exit, stopping it at the deadline. */
  async function awaitExit(containerName: string, deadlineMs: number) {
    for (;;) {
      const inspection = await docker.inspectContainer(containerName);
      const observation = observeContainer(inspection);
      if (observation.state === "exited" || observation.state === "missing") {
        return { observation, stoppedByDeadline: false };
      }
      if (clock.now() >= deadlineMs) {
        await docker.stopContainer(containerName, STOP_GRACE_SECONDS);
        return {
          observation: observeContainer(await docker.inspectContainer(containerName)),
          stoppedByDeadline: true,
        };
      }
      await clock.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadlineMs - clock.now())));
    }
  }

  async function shipLogs(target: ReleaseJobTarget, phase: ReleasePhase, containerName: string) {
    if (!onBuildLog) {
      return;
    }
    try {
      const entries = await docker.containerLogEntries(containerName, { tail: LOG_TAIL_LINES });
      for (const entry of entries) {
        onBuildLog({
          type: entry.type,
          stage: "deploying",
          line: `[${PHASE_LABEL[phase]}] ${target.redactLogLine(entry.line)}`,
          timestamp: clock.now(),
        });
      }
    } catch (error) {
      // Logs are a courtesy; the outcome is what the deployment depends on.
      console.warn(`[nouva-agent] could not read ${PHASE_LABEL[phase]} job logs`, error);
    }
  }

  /**
   * Repeats an idempotent control-plane call through network failures and 5xx answers, backing
   * off, for about as long as a control-plane restart takes. What is thrown when it gives up is
   * `giveUp`'s to decide; `retried` says whether an earlier try may have landed.
   */
  async function callControlPlane<T>(
    call: () => Promise<T>,
    giveUp: (error: unknown, retried: boolean) => unknown
  ): Promise<T> {
    const giveUpAtMs = clock.now() + CONTROL_PLANE_RETRY_BUDGET_MS;
    let delayMs = CONTROL_PLANE_RETRY_INITIAL_DELAY_MS;
    for (let retried = false; ; retried = true) {
      try {
        return await call();
      } catch (error) {
        if (!isRetryableControlPlaneError(error) || clock.now() + delayMs > giveUpAtMs) {
          throw giveUp(error, retried);
        }
        await clock.sleep(delayMs);
        delayMs = Math.min(delayMs * 2, CONTROL_PLANE_RETRY_MAX_DELAY_MS);
      }
    }
  }

  /**
   * Failing pre-activation work for an unreachable control plane would settle its attempt as
   * unknown and hold every later deployment of the service behind it. Given back instead, the work
   * is leased again once this lease expires, and that lease claims the phase again: an attempt that
   * started is resumed from its kept container.
   */
  function deferWhileUnreachable(phase: ReleasePhase, error: unknown, action: string): unknown {
    if (phase === "verification" || !isRetryableControlPlaneError(error)) {
      return error;
    }
    return new ReleaseJobDeferredError(
      `Could not ${action} the ${PHASE_LABEL[phase]} job with the control plane; the deployment will pick it up again`
    );
  }

  function claimPhase(phase: ReleasePhase, runningJobDeploymentIds: string[]) {
    // Repeating a claim is safe: the lease that started an attempt gets the same answer back.
    return callControlPlane(
      () => controlPlane.claim(phase, { runningJobDeploymentIds }),
      (error, retried) => {
        // A claim answered `wait` puts the work back in the queue and ends this lease, so a repeat
        // of one whose answer was lost finds the lease gone.
        if (retried && (error as { status?: unknown } | null)?.status === 409) {
          return new ReleaseJobDeferredError(
            `The control plane returned this deployment to the queue while claiming the ${PHASE_LABEL[phase]} job`
          );
        }
        return deferWhileUnreachable(phase, error, "claim");
      }
    );
  }

  function reportOutcome(phase: ReleasePhase, report: ReleaseJobReport) {
    // The report is idempotent, so a lost acknowledgement is safe to repeat.
    return callControlPlane(
      () => controlPlane.report(phase, report),
      (error) => deferWhileUnreachable(phase, error, "report the outcome of")
    );
  }

  /**
   * Starts an attempt and says whether it did. Only an attempt whose command started can have had
   * an effect or observed anything; see `attemptAndReport` for what one that never did becomes.
   */
  async function startAttempt(
    containerName: string,
    start: () => Promise<void>
  ): Promise<{ started: true; atMs: number } | { started: false; error: unknown }> {
    try {
      await start();
      return { started: true, atMs: clock.now() };
    } catch (error) {
      let inspection: DockerContainerInspection | null;
      try {
        inspection = await docker.inspectContainer(containerName);
      } catch {
        // Whether the command started cannot be told, so the start failure stands as it is.
        throw error;
      }
      const startedAtMs = readStartedAtMs(inspection);
      if (observeContainer(inspection).state === "running" || startedAtMs !== null) {
        return { started: true, atMs: startedAtMs ?? clock.now() };
      }
      return { started: false, error };
    }
  }

  /** Runs or resumes the claimed attempt until it exits, and reports its outcome. */
  async function attemptAndReport(
    target: ReleaseJobTarget,
    request: ReleasePhaseRequest,
    claim: { decision: "run" | "resume"; attempt: number },
    containerName: string
  ) {
    let startedAtMs: number | null = null;
    let exit: Awaited<ReturnType<typeof awaitExit>> | null = null;
    let start: Awaited<ReturnType<typeof startAttempt>> | null = null;
    if (claim.decision === "run") {
      progress(`Running the ${PHASE_LABEL[request.phase]} job (attempt ${claim.attempt})`);
      start = await startAttempt(containerName, async () => {
        await removeSettledAttempts(target, request.phase);
        await createJobContainer(target, request, containerName, claim.attempt);
        await docker.startContainer(containerName);
      });
    } else {
      const inspection = await docker.inspectContainer(containerName);
      const recovery = decideReleaseJobRecovery(
        observeContainer(inspection),
        request.timeoutSeconds
      );
      progress(`Resuming the ${PHASE_LABEL[request.phase]} job (attempt ${claim.attempt})`);
      if (recovery.action === "start") {
        start = await startAttempt(containerName, () => docker.startContainer(containerName));
      } else if (recovery.action === "wait") {
        startedAtMs = readStartedAtMs(inspection) ?? clock.now();
      } else if (recovery.action === "record") {
        exit = { observation: observeContainer(inspection), stoppedByDeadline: false };
      } else {
        exit = { observation: { state: "missing" }, stoppedByDeadline: false };
      }
    }

    if (start?.started === false) {
      // A job that never started fails without a command having run. A verification that never ran
      // observed nothing, and nothing unobserved may roll traffic back, so it keeps the deployment.
      const appliedPolicy = request.phase === "verification" ? ("keep" as const) : null;
      await reportOutcome(request.phase, {
        attempt: claim.attempt,
        outcome: "failed",
        exitCode: null,
        startedAt: null,
        finishedAt: new Date(clock.now()).toISOString(),
        appliedPolicy,
      });
      return {
        outcome: "failed" as const,
        exitCode: null,
        appliedPolicy,
        startFailure: start.error instanceof Error ? start.error.message : String(start.error),
      };
    }
    if (start) {
      startedAtMs = start.atMs;
    }
    if (!exit) {
      exit = await awaitExit(containerName, (startedAtMs ?? 0) + request.timeoutSeconds * 1_000);
    }

    const { observation, stoppedByDeadline } = exit;
    const outcome: ReleaseJobOutcome =
      observation.state === "exited"
        ? classifyReleaseJobExit({
            exitCode: observation.exitCode,
            startedAt: observation.startedAt,
            finishedAt: observation.finishedAt,
            timeoutSeconds: request.timeoutSeconds,
            stoppedByDeadline,
          })
        : "outcome_unknown";
    const exitCode = observation.state === "exited" ? observation.exitCode : null;
    if (observation.state === "exited") {
      await shipLogs(target, request.phase, containerName);
    }

    const appliedPolicy =
      outcome === "succeeded" ? null : ((await request.resolveAppliedPolicy?.(outcome)) ?? null);
    await reportOutcome(request.phase, {
      attempt: claim.attempt,
      outcome,
      exitCode,
      startedAt:
        observation.state === "exited" && observation.startedAt ? observation.startedAt : null,
      finishedAt: new Date(clock.now()).toISOString(),
      appliedPolicy,
    });
    return { outcome, exitCode, appliedPolicy, startFailure: null };
  }

  return {
    async run(target, request) {
      // Before the claim, so a missing image never uses up an attempt.
      await target.prepareImage();
      const claim = await claimPhase(request.phase, await readRunningJobs(target, request.phase));
      if (claim.decision === "wait") {
        progress(claim.message);
        throw new ReleaseJobDeferredError(claim.message);
      }
      const containerName = buildReleaseJobContainerName({
        serviceId: target.serviceId,
        deploymentId: target.deploymentId,
        phase: request.phase,
        attempt: claim.attempt,
      });

      if (claim.decision === "skip" || claim.decision === "halt") {
        // A settled phase is never resumed, so what its attempts left behind can go.
        await removeSettledAttempts(target, request.phase);
      }
      if (claim.decision === "skip") {
        progress(`The ${PHASE_LABEL[request.phase]} job already succeeded; not running it again`);
        return { kind: "succeeded", attempt: claim.attempt };
      }
      if (claim.decision === "halt") {
        return {
          kind: "unsuccessful",
          attempt: claim.attempt,
          outcome: claim.status,
          message: claim.message,
          appliedPolicy: null,
        };
      }

      if (claim.decision === "run") {
        await removeOtherDeploymentsExitedJobs(target, request.phase);
      }
      let reported: Awaited<ReturnType<typeof attemptAndReport>>;
      try {
        reported = await attemptAndReport(target, request, claim, containerName);
      } catch (error) {
        // An unacknowledged pre-activation attempt keeps its container: a re-leased deploy resumes
        // it from there, and without it could only report the outcome as unknown.
        if (request.phase === "verification") {
          await discardUnreportedVerification(containerName);
        }
        throw error;
      }
      // Only now that the outcome is recorded may the evidence go. The deployment already depends
      // on that outcome, so a container Docker will not remove is left for a later sweep instead
      // of failing it.
      try {
        await docker.removeContainer(containerName, true);
      } catch (error) {
        console.warn(
          `[nouva-agent] could not remove release job container ${containerName}`,
          error
        );
      }

      const { outcome, exitCode, appliedPolicy, startFailure } = reported;
      if (outcome === "succeeded") {
        progress(`The ${PHASE_LABEL[request.phase]} job succeeded`);
        return { kind: "succeeded", attempt: claim.attempt };
      }
      const base =
        describeReportedReleaseJob({
          phase: request.phase,
          outcome,
          attempt: claim.attempt,
          exitCode,
          timeoutSeconds: request.timeoutSeconds,
          configuredPolicy: request.configuredPolicy ?? null,
          appliedPolicy,
        }) ??
        describeReleaseJobOutcome({
          phase: request.phase,
          outcome,
          attempt: claim.attempt,
          exitCode,
          timeoutSeconds: request.timeoutSeconds,
        });
      const described = startFailure
        ? `${base} Start error: ${target.redactLogLine(startFailure)}`
        : base;
      progress(described);
      return {
        kind: "unsuccessful",
        attempt: claim.attempt,
        outcome,
        message: described,
        appliedPolicy,
      };
    },
  };
}

/** Network failures and 5xx are worth repeating; a 4xx answer will not change. */
function isRetryableControlPlaneError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500;
}
