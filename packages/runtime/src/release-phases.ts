/**
 * Release phases of an app or worker deployment (#287): an optional pre-activation job (typically a
 * database migration) and an optional post-activation verification. Both run as one-off containers
 * from the deployment's candidate image with the environment the candidate itself receives, on the
 * project network, under the service's resource limits and a per-phase timeout.
 *
 * This module is the wire contract between the control plane and the agent, and the pure decisions
 * both sides take on it. It is shipped to the public agent mirror, so it must stay self-contained:
 * no imports outside this file.
 *
 * The one rule everything here serves: a job with side effects never runs twice for the same
 * attempt. The control plane records each attempt before the agent starts it, the agent names the
 * container after that attempt, and an attempt whose container cannot be found again is recorded
 * as `outcome_unknown` for an operator to resolve rather than re-run behind their back.
 */

export const RELEASE_PHASES = ["pre_activation", "verification"] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];

/** What happens to the new runtime when its verification fails. Never touches data or schema. */
export const VERIFICATION_FAILURE_POLICIES = ["keep", "rollback"] as const;
export type VerificationFailurePolicy = (typeof VERIFICATION_FAILURE_POLICIES)[number];

export const RELEASE_JOB_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
] as const;
export type ReleaseJobStatus = (typeof RELEASE_JOB_STATUSES)[number];

/** The statuses an attempt can end in. `pending` and `running` are never reported by the agent. */
export const RELEASE_JOB_OUTCOMES = [
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
] as const satisfies readonly ReleaseJobStatus[];
export type ReleaseJobOutcome = (typeof RELEASE_JOB_OUTCOMES)[number];

export const RELEASE_JOB_RESOLUTIONS = ["retry", "mark_succeeded"] as const;
export type ReleaseJobResolution = (typeof RELEASE_JOB_RESOLUTIONS)[number];

export const RELEASE_COMMAND_MAX_LENGTH = 8_000;

export const RELEASE_JOB_TIMEOUT_LIMITS = {
  pre_activation: { minSeconds: 10, maxSeconds: 3_600, defaultSeconds: 600 },
  verification: { minSeconds: 5, maxSeconds: 900, defaultSeconds: 120 },
} as const satisfies Record<
  ReleasePhase,
  { minSeconds: number; maxSeconds: number; defaultSeconds: number }
>;

export const WORKER_VERIFICATION_ROLLBACK_UNSUPPORTED_MESSAGE =
  "Worker services keep a deployment whose verification fails; roll back explicitly from the deployment list";

export interface PreActivationJobConfig {
  command: string;
  timeoutSeconds: number;
}

export interface VerificationJobConfig {
  command: string;
  timeoutSeconds: number;
  onFailure: VerificationFailurePolicy;
}

/**
 * A service's release configuration, and the snapshot a deployment carries of it. Absent phases are
 * `null`; a configuration with neither phase is stored as no configuration at all.
 */
export interface ServiceReleaseConfig {
  preActivation: PreActivationJobConfig | null;
  verification: VerificationJobConfig | null;
}

/** The release phases a deployment carries to the agent when its deploy work is leased. */
export interface DeploymentReleasePlan extends ServiceReleaseConfig {
  /**
   * Set when an earlier lease of this deployment recorded a failed verification and returned
   * traffic to the previous deployment. The release is known to be bad, so the agent finishes that
   * rollback and stops instead of cutting over to it again, unless the previous deployment cannot
   * serve. Only an active lease can record a result, so this cannot change
   * while the lease that carries it holds the work.
   */
  verificationRolledBack?: boolean;
}

export type ReleaseServiceType = "app" | "worker";

function describeReleaseCommandProblem(label: string, command: string): string | null {
  if (command.trim().length === 0) {
    return `${label} command is required; remove the ${label.toLowerCase()} to disable it`;
  }
  if (command.length > RELEASE_COMMAND_MAX_LENGTH) {
    return `${label} command must be ${RELEASE_COMMAND_MAX_LENGTH.toLocaleString("en-US")} characters or less`;
  }
  if (command.includes("\u0000")) {
    return `${label} command must not contain NUL characters`;
  }
  return null;
}

function describeTimeoutProblem(
  label: string,
  phase: ReleasePhase,
  seconds: number
): string | null {
  const limits = RELEASE_JOB_TIMEOUT_LIMITS[phase];
  if (!Number.isInteger(seconds) || seconds < limits.minSeconds || seconds > limits.maxSeconds) {
    return `${label} timeout must be a whole number of seconds from ${limits.minSeconds} through ${limits.maxSeconds}`;
  }
  return null;
}

/**
 * Checks the rules a schema cannot express. Returns the first problem, or `null` when the
 * configuration may be stored for a service of `serviceType`.
 */
export function validateServiceReleaseConfig(
  config: ServiceReleaseConfig,
  serviceType: ReleaseServiceType
): string | null {
  if (config.preActivation) {
    const problem =
      describeReleaseCommandProblem("Pre-activation job", config.preActivation.command) ??
      describeTimeoutProblem(
        "Pre-activation job",
        "pre_activation",
        config.preActivation.timeoutSeconds
      );
    if (problem) {
      return problem;
    }
  }

  if (config.verification) {
    const problem =
      describeReleaseCommandProblem("Verification", config.verification.command) ??
      describeTimeoutProblem("Verification", "verification", config.verification.timeoutSeconds);
    if (problem) {
      return problem;
    }
    if (!VERIFICATION_FAILURE_POLICIES.includes(config.verification.onFailure)) {
      return "Verification failure policy must be keep or rollback";
    }
    // A worker has no idle previous runtime to return to: its old replicas are retired before the
    // new ones start, so "rollback" would mean an unrequested redeploy of an older release.
    if (serviceType === "worker" && config.verification.onFailure === "rollback") {
      return WORKER_VERIFICATION_ROLLBACK_UNSUPPORTED_MESSAGE;
    }
  }

  return null;
}

/** Trims commands and folds a configuration with no phase into `null`. */
export function normalizeServiceReleaseConfig(
  config: ServiceReleaseConfig | null
): ServiceReleaseConfig | null {
  if (!config || (!config.preActivation && !config.verification)) {
    return null;
  }
  return {
    preActivation: config.preActivation
      ? {
          command: config.preActivation.command.trim(),
          timeoutSeconds: config.preActivation.timeoutSeconds,
        }
      : null,
    verification: config.verification
      ? {
          command: config.verification.command.trim(),
          timeoutSeconds: config.verification.timeoutSeconds,
          onFailure: config.verification.onFailure,
        }
      : null,
  };
}

// === Agent <-> control plane protocol ===

export interface ReleaseJobLeaseProof {
  serverId: string;
  leaseId: string;
}

export type ReleaseJobClaimRequest = ReleaseJobLeaseProof & {
  /**
   * Deployments of the service, this one included, whose release job containers the agent still
   * sees running. The control plane may consider such a job settled (its deployment was superseded,
   * or an operator resolved it after the agent lost track of it) while the command is in fact still
   * going.
   */
  runningJobDeploymentIds?: string[];
};

/**
 * The control plane's answer before the agent touches Docker for a phase.
 *
 * - `run`: attempt `attempt` is now recorded as running; start a new container for it.
 * - `resume`: attempt `attempt` was claimed earlier and never reported. Find its container and
 *   report what it did; never start a new one.
 * - `skip`: the phase already succeeded (possibly marked so by an operator).
 * - `halt`: the phase ended without success and needs an operator; the deployment must not go on.
 * - `wait`: another deployment of the service has a pre-activation job that is not settled, or an
 *   earlier attempt of this one still runs. The work was put back in the queue and its lease
 *   released; stop without reporting anything.
 */
export type ReleaseJobClaimResponse =
  | { decision: "run"; attempt: number }
  | { decision: "resume"; attempt: number }
  | { decision: "skip"; attempt: number }
  | { decision: "wait"; attempt: number; message: string }
  | {
      decision: "halt";
      attempt: number;
      status: Exclude<ReleaseJobOutcome, "succeeded">;
      message: string;
    };

export interface ReleaseJobReport {
  attempt: number;
  outcome: ReleaseJobOutcome;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string;
  /**
   * Verification only: what the agent did about the result. `null` for a pre-activation job and for
   * a verification that succeeded. The report carries no free text; the control plane words the
   * status message itself, so nothing a job printed can reach it.
   */
  appliedPolicy: VerificationFailurePolicy | null;
}

export type ReleaseJobReportRequest = ReleaseJobLeaseProof & ReleaseJobReport;

export interface ReleaseJobRecordState {
  status: ReleaseJobStatus;
  attempt: number;
  statusMessage: string | null;
  /** The lease whose claim started the current attempt. */
  claimedLeaseId: string | null;
}

export type ReleaseJobClaimDecision = {
  response: ReleaseJobClaimResponse;
  /** The row update the control plane commits before answering, or `null` for none. */
  transition: { status: "running"; attempt: number } | null;
};

export function describeReleaseJobOutcome(input: {
  phase: ReleasePhase;
  outcome: Exclude<ReleaseJobOutcome, "succeeded">;
  attempt: number;
  exitCode: number | null;
  timeoutSeconds: number;
}): string {
  const label = input.phase === "pre_activation" ? "Pre-activation job" : "Verification";
  switch (input.outcome) {
    case "failed":
      // Every job that ran exits with a code; a failure without one is a job that never started.
      return input.exitCode === null
        ? `${label} could not be started`
        : `${label} failed with exit code ${input.exitCode}`;
    case "timed_out":
      return `${label} timed out after ${input.timeoutSeconds}s`;
    case "outcome_unknown":
      return input.phase === "pre_activation"
        ? `${label} attempt ${input.attempt} was started but its result was lost; it was not run again. Check its effect, then retry it or mark it succeeded`
        : `${label} attempt ${input.attempt} was started but its result was lost; it was not run again`;
  }
}

export function decideReleaseJobClaim(
  record: ReleaseJobRecordState,
  claimingLeaseId: string
): ReleaseJobClaimDecision {
  switch (record.status) {
    case "pending": {
      const attempt = record.attempt + 1;
      return { response: { decision: "run", attempt }, transition: { status: "running", attempt } };
    }
    case "running":
      // A lease claims a phase once, so the lease that started this attempt asking again means it
      // never got the answer and has started nothing: it gets the same answer, not a resume that
      // would find no container and call the attempt lost.
      return record.claimedLeaseId === claimingLeaseId
        ? { response: { decision: "run", attempt: record.attempt }, transition: null }
        : { response: { decision: "resume", attempt: record.attempt }, transition: null };
    case "succeeded":
      return { response: { decision: "skip", attempt: record.attempt }, transition: null };
    case "failed":
    case "timed_out":
    case "outcome_unknown":
      return {
        response: {
          decision: "halt",
          attempt: record.attempt,
          status: record.status,
          message: record.statusMessage ?? `Release job ended as ${record.status}`,
        },
        transition: null,
      };
  }
}

/**
 * A pre-activation job that a new attempt must not overlap: two migrations of one service never
 * run at once, none starts while an earlier one's effect is unknown, and a deployment's own earlier
 * attempt is never started over or skipped while its container still runs.
 */
export type ReleaseJobBlocker = {
  deploymentId: string;
  /**
   * `running`: claimed and not yet reported. `outcome_unknown`: waits for an operator.
   * `container_running`: the agent sees its container still running, whatever was recorded.
   * `own_attempt_running`: the same, for an earlier attempt of this deployment's own job.
   */
  reason: "running" | "outcome_unknown" | "container_running" | "own_attempt_running";
};

/** How long queued work waits before asking again whether a blocking job has settled. */
export const RELEASE_JOB_WAIT_DELAY_MS = 30_000;

/** Picks the blocker an operator has to act on first; `null` when the job may run. */
export function selectReleaseJobBlocker(
  blockers: readonly ReleaseJobBlocker[]
): ReleaseJobBlocker | null {
  const order: ReleaseJobBlocker["reason"][] = [
    "outcome_unknown",
    "own_attempt_running",
    "container_running",
    "running",
  ];
  for (const reason of order) {
    const blocker = blockers.find((candidate) => candidate.reason === reason);
    if (blocker) {
      return blocker;
    }
  }
  return null;
}

export function describeReleaseJobWait(blocker: ReleaseJobBlocker): string {
  const deployment = `deployment ${blocker.deploymentId.slice(0, 8)}`;
  switch (blocker.reason) {
    case "outcome_unknown":
      return `Waiting on the pre-activation job of ${deployment}, whose outcome is unknown. Check its effect and mark it succeeded to let this deployment continue`;
    case "container_running":
      return `Waiting on the pre-activation job of ${deployment}, whose container is still running on the server`;
    case "running":
      return `Waiting on the pre-activation job of ${deployment}, which is still running`;
    case "own_attempt_running":
      return "Waiting on an earlier attempt of this deployment's pre-activation job, whose container is still running on the server";
  }
}

export type ReleaseJobReportDecision =
  | { kind: "record" }
  | { kind: "duplicate" }
  | { kind: "reject"; message: string };

/**
 * Whether a report may be written. Only the attempt the control plane last handed out, while it is
 * still running, can be recorded; repeating an already recorded report is acknowledged without a
 * write so a lost acknowledgement can be retried safely.
 */
export function decideReleaseJobReport(
  record: Pick<ReleaseJobRecordState, "status" | "attempt">,
  report: Pick<ReleaseJobReport, "attempt" | "outcome">
): ReleaseJobReportDecision {
  if (report.attempt !== record.attempt) {
    return {
      kind: "reject",
      message: `Release job attempt ${report.attempt} is not the current attempt ${record.attempt}`,
    };
  }
  if (record.status === "running") {
    return { kind: "record" };
  }
  if (record.status === report.outcome) {
    return { kind: "duplicate" };
  }
  return {
    kind: "reject",
    message: `Release job attempt ${record.attempt} is already recorded as ${record.status}`,
  };
}

// === Agent-side decisions ===

export type ReleaseJobContainerObservation =
  | { state: "missing" }
  | { state: "created" }
  | { state: "running" }
  | { state: "exited"; exitCode: number; startedAt: string | null; finishedAt: string | null };

export type ReleaseJobRecovery =
  /** The container exists but never started, so the command has certainly not run. */
  | { action: "start" }
  | { action: "wait" }
  | { action: "record"; outcome: "succeeded" | "failed" | "timed_out"; exitCode: number }
  | { action: "declare_unknown" };

function readTimestampMs(value: string | null): number | null {
  if (!value || value.startsWith("0001-")) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Classifies a finished container by how long it ran, when Docker recorded that. A run that lasted
 * its timeout was stopped at its deadline, whatever it exited with: a command may exit 0 on the
 * stop signal without having finished. One that exited sooner ended on its own, even when the agent
 * then issued a stop because the exit landed between its last look and the deadline. Only without
 * timestamps does the agent's own record of stopping it decide.
 */
export function classifyReleaseJobExit(input: {
  exitCode: number;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutSeconds: number;
  stoppedByDeadline?: boolean;
}): "succeeded" | "failed" | "timed_out" {
  const startedAt = readTimestampMs(input.startedAt);
  const finishedAt = readTimestampMs(input.finishedAt);
  if (startedAt !== null && finishedAt !== null) {
    if (finishedAt - startedAt >= input.timeoutSeconds * 1_000) {
      return "timed_out";
    }
    return input.exitCode === 0 ? "succeeded" : "failed";
  }
  if (input.stoppedByDeadline) {
    return "timed_out";
  }
  return input.exitCode === 0 ? "succeeded" : "failed";
}

/**
 * What to do about an attempt the control plane says was claimed but never reported. The container
 * is kept until its outcome is acknowledged, so a missing container means the agent cannot tell
 * whether the command ran — and that is exactly the case that must not be re-run automatically.
 */
export function decideReleaseJobRecovery(
  observation: ReleaseJobContainerObservation,
  timeoutSeconds: number
): ReleaseJobRecovery {
  switch (observation.state) {
    case "created":
      return { action: "start" };
    case "running":
      return { action: "wait" };
    case "exited":
      return {
        action: "record",
        outcome: classifyReleaseJobExit({
          exitCode: observation.exitCode,
          startedAt: observation.startedAt,
          finishedAt: observation.finishedAt,
          timeoutSeconds,
        }),
        exitCode: observation.exitCode,
      };
    case "missing":
      return { action: "declare_unknown" };
  }
}

export type PreActivationGate = { proceed: true } | { proceed: false; message: string };

/** A deployment is activated only after its pre-activation job has definitely succeeded. */
export function decidePreActivationGate(input: {
  outcome: ReleaseJobOutcome;
  message: string;
}): PreActivationGate {
  if (input.outcome === "succeeded") {
    return { proceed: true };
  }
  return {
    proceed: false,
    message: `${input.message}. The new deployment was not activated.`,
  };
}

export type VerificationConsequence =
  | { action: "none" }
  | { action: "keep"; reason: string }
  | { action: "rollback" };

/**
 * What a verification result does to the runtime that is already serving. Rollback returns traffic
 * to the previous runtime only; it never implies reverting a migration or restoring data, and it
 * needs a definite failure — an unknown outcome keeps the new runtime and says so.
 */
export function decideVerificationConsequence(input: {
  outcome: ReleaseJobOutcome;
  policy: VerificationFailurePolicy;
  rollbackAvailable: boolean;
}): VerificationConsequence {
  if (input.outcome === "succeeded") {
    return { action: "none" };
  }
  if (input.outcome === "outcome_unknown") {
    return {
      action: "keep",
      reason: "The verification result is unknown, so the new deployment keeps serving",
    };
  }
  if (input.policy === "keep") {
    return {
      action: "keep",
      reason: "The service keeps the new deployment when verification fails",
    };
  }
  if (!input.rollbackAvailable) {
    return {
      action: "keep",
      reason:
        "The previous deployment cannot take traffic back, so the new deployment keeps serving",
    };
  }
  return { action: "rollback" };
}

// === Operator resolution ===

export type ReleaseJobResolutionDecision =
  | { ok: true; nextStatus: "pending" | "succeeded" }
  | { ok: false; message: string };

/**
 * An operator's answer to a pre-activation job that stopped a deployment. `retry` runs the job again
 * as a new attempt; `mark_succeeded` records that the operator checked its effect and lets the
 * deployment continue without running it again, which is offered only when the outcome is unknown.
 */
export function decideReleaseJobResolution(
  record: { phase: ReleasePhase; status: ReleaseJobStatus },
  resolution: ReleaseJobResolution
): ReleaseJobResolutionDecision {
  if (record.phase !== "pre_activation") {
    return {
      ok: false,
      message: "Only a pre-activation job can be resolved; redeploy to verify again",
    };
  }
  if (resolution === "retry") {
    if (
      record.status === "failed" ||
      record.status === "timed_out" ||
      record.status === "outcome_unknown"
    ) {
      return { ok: true, nextStatus: "pending" };
    }
    return { ok: false, message: `A ${record.status} pre-activation job cannot be retried` };
  }
  if (record.status === "outcome_unknown") {
    return { ok: true, nextStatus: "succeeded" };
  }
  return {
    ok: false,
    message: "Only a pre-activation job whose outcome is unknown can be marked succeeded",
  };
}

/**
 * The status message of an attempt that was still running when its deployment's work ended: the
 * agent never reported it, so nobody knows whether the command finished or what it did.
 */
export function describeInterruptedReleaseJob(input: {
  phase: ReleasePhase;
  attempt: number;
}): string {
  const base = describeReleaseJobOutcome({
    phase: input.phase,
    outcome: "outcome_unknown",
    attempt: input.attempt,
    exitCode: null,
    timeoutSeconds: 0,
  });
  return `${base}. Its result was never reported.`;
}

/**
 * The status message the control plane stores for a reported attempt, worded from the report's
 * closed fields only. `null` for a success.
 */
export function describeReportedReleaseJob(input: {
  phase: ReleasePhase;
  outcome: ReleaseJobOutcome;
  attempt: number;
  exitCode: number | null;
  timeoutSeconds: number;
  configuredPolicy: VerificationFailurePolicy | null;
  appliedPolicy: VerificationFailurePolicy | null;
}): string | null {
  if (input.outcome === "succeeded") {
    return null;
  }
  const base = describeReleaseJobOutcome({ ...input, outcome: input.outcome });
  if (input.phase === "pre_activation") {
    return `${base}. The new deployment was not activated.`;
  }
  if (input.appliedPolicy === "rollback") {
    return `${base}. Traffic was returned to the previous deployment; no data or schema was rolled back.`;
  }
  const neverStarted = input.outcome === "failed" && input.exitCode === null;
  if (
    input.configuredPolicy === "rollback" &&
    input.outcome !== "outcome_unknown" &&
    !neverStarted
  ) {
    return `${base}. The previous deployment could not take traffic back, so the new deployment keeps serving.`;
  }
  return `${base}. The new deployment keeps serving.`;
}
