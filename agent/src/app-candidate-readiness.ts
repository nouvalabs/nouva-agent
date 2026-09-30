import type { DockerContainerInspection } from "./docker-api.js";

/**
 * Runtime failure evidence accumulated across readiness polls. App candidates run under an
 * `unless-stopped` restart policy, so the kernel killing the process is followed by Docker starting
 * it again: an inspection taken a moment later can report a freshly running container with the
 * previous exit erased. Readiness therefore carries forward what it has already observed instead of
 * deciding from the latest inspection alone.
 */
export interface CandidateRuntimeEvidence {
  readonly outOfMemory: boolean;
  /**
   * Automatic restarts the restart policy performed. Docker clears this counter whenever a
   * container is started by hand, so it only ever covers the supervision window readiness observes:
   * a fresh candidate, or a live container the rollback path just started again. A live container
   * that kept running also counts the restarts it had moments before the window (`recentRestarts`).
   */
  readonly restarts: number;
  readonly exitCode: number | null;
  readonly memoryLimitBytes: number | null;
  readonly memorySwapLimitBytes: number | null;
}

export const NO_CANDIDATE_RUNTIME_EVIDENCE: CandidateRuntimeEvidence = {
  outOfMemory: false,
  restarts: 0,
  exitCode: null,
  memoryLimitBytes: null,
  memorySwapLimitBytes: null,
};

export type CandidateReadinessFailureCause =
  | "out_of_memory"
  | "restart_loop"
  | "exited"
  | "unhealthy";

export type CandidateReadinessStep =
  | { readonly kind: "ready" }
  | {
      readonly kind: "failed";
      readonly cause: CandidateReadinessFailureCause;
      readonly message: string;
    }
  | { readonly kind: "probe"; readonly ipAddress: string; readonly unreachableMessage: string }
  | { readonly kind: "wait"; readonly message: string };

export interface CandidateReadinessAssessment {
  readonly evidence: CandidateRuntimeEvidence;
  readonly step: CandidateReadinessStep;
}

/**
 * A single restart can race a healthy start (an image that re-execs itself, a container Docker
 * restarted while the deployment was still wiring up), so readiness only calls it a loop once the
 * process has failed to stay up twice.
 */
export const RESTART_LOOP_THRESHOLD = 2;

const TERMINAL_STATUSES = new Set(["exited", "dead", "removing"]);

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readPositiveByteLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Docker reports an unbounded `MemorySwap` allowance as -1 rather than omitting the field. */
const UNLIMITED_SWAP = -1;

function readSwapByteLimit(value: unknown): number | null {
  return value === UNLIMITED_SWAP ? UNLIMITED_SWAP : readPositiveByteLimit(value);
}

/**
 * A zero exit code only means something once the process is known to be down: while the container
 * runs, Docker reports the field as zero regardless of how the previous run ended.
 */
function readReportedExitCode(state: DockerContainerInspection["State"]): number | null {
  const exitCode = state?.ExitCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) {
    return null;
  }

  const status = state?.Status?.toLowerCase();
  const terminated =
    status === "restarting" || (status !== undefined && TERMINAL_STATUSES.has(status));
  return terminated || exitCode !== 0 ? exitCode : null;
}

/**
 * Evidence only ever gains detail, so a later poll reporting a clean exit — Docker zeroes the field
 * as soon as the restart policy starts the process again — must not erase the failing code that
 * explains why the candidate is looping.
 */
function mergeExitCode(previous: number | null, reported: number | null): number | null {
  if (reported === null || (reported === 0 && previous !== null)) {
    return previous;
  }

  return reported;
}

/**
 * Whether this inspection shows the container killed for memory. Without `outOfMemoryAtStart` the
 * flag counts as reported. With it, the flag may describe a kill the container survived, so it only
 * counts when the container was not found up with it at the start and is seen going down with it:
 * restarts from before this supervision window do not show that.
 */
function readOutOfMemory(
  inspection: DockerContainerInspection,
  observedRestarts: number,
  outOfMemoryAtStart: boolean | undefined
): boolean {
  const state = inspection.State;
  if (state?.OOMKilled !== true) return false;
  if (outOfMemoryAtStart === undefined) return true;
  const wentDown =
    observedRestarts > 0 || state.Running !== true || state.Status?.toLowerCase() === "restarting";
  return !outOfMemoryAtStart && wentDown;
}

function recordEvidence(
  previous: CandidateRuntimeEvidence,
  inspection: DockerContainerInspection,
  restartBaseline: number,
  recentRestarts: number,
  outOfMemoryAtStart: boolean | undefined
): CandidateRuntimeEvidence {
  const reportedRestarts = readNonNegativeInteger(inspection.RestartCount) ?? 0;
  const restarts = Math.max(
    previous.restarts,
    recentRestarts + Math.max(0, reportedRestarts - restartBaseline)
  );
  return {
    outOfMemory:
      previous.outOfMemory ||
      readOutOfMemory(inspection, restarts - recentRestarts, outOfMemoryAtStart),
    restarts,
    exitCode: mergeExitCode(previous.exitCode, readReportedExitCode(inspection.State)),
    memoryLimitBytes:
      readPositiveByteLimit(inspection.HostConfig?.Memory) ?? previous.memoryLimitBytes,
    memorySwapLimitBytes:
      readSwapByteLimit(inspection.HostConfig?.MemorySwap) ?? previous.memorySwapLimitBytes,
  };
}

function formatByteSize(bytes: number): string {
  const mebibytes = bytes / 1024 / 1024;
  const [value, unit] =
    mebibytes >= 1024 ? [mebibytes / 1024, "GiB"] : ([mebibytes, "MiB"] as const);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
}

function formatRestarts(restarts: number): string {
  return `${restarts} restart${restarts === 1 ? "" : "s"}`;
}

function describeMemoryLimits(evidence: CandidateRuntimeEvidence): string[] {
  const { memoryLimitBytes, memorySwapLimitBytes } = evidence;
  if (memoryLimitBytes === null) {
    return [];
  }

  const limits = [`memory limit ${formatByteSize(memoryLimitBytes)}`];
  if (memorySwapLimitBytes === UNLIMITED_SWAP) {
    limits.push("swap unlimited");
  } else if (memorySwapLimitBytes === memoryLimitBytes) {
    limits.push("swap disabled");
  } else if (memorySwapLimitBytes !== null && memorySwapLimitBytes > memoryLimitBytes) {
    limits.push(`memory and swap limit ${formatByteSize(memorySwapLimitBytes)}`);
  }
  return limits;
}

function describeOutOfMemory(
  subject: string,
  containerName: string,
  evidence: CandidateRuntimeEvidence
): string {
  const details = describeMemoryLimits(evidence);
  if (evidence.restarts > 0) {
    details.push(formatRestarts(evidence.restarts));
  }
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `${subject} ${containerName} ran out of memory and was killed${suffix}; raise the service memory limit and redeploy`;
}

function describeRestartLoop(
  subject: string,
  containerName: string,
  evidence: CandidateRuntimeEvidence
): string {
  const details = [formatRestarts(evidence.restarts)];
  if (evidence.exitCode !== null) {
    details.push(`last exit code ${evidence.exitCode}`);
  }
  return `${subject} ${containerName} keeps restarting (${details.join(", ")}); the process is exiting instead of serving traffic`;
}

function describeTerminalStatus(
  subject: string,
  containerName: string,
  status: string,
  evidence: CandidateRuntimeEvidence
): string {
  const exit = evidence.exitCode === null ? "" : `, exit code ${evidence.exitCode}`;
  return `${subject} ${containerName} is not running (${status}${exit})`;
}

/** Callers that supervise something other than an app candidate relabel the reported subject. */
const DEFAULT_READINESS_SUBJECT = "Candidate container";

function resolveContainerIpAddress(inspection: DockerContainerInspection): string | null {
  const networks = inspection.NetworkSettings?.Networks;
  if (!networks) {
    return null;
  }

  for (const network of Object.values(networks)) {
    if (typeof network?.IPAddress === "string" && network.IPAddress.length > 0) {
      return network.IPAddress;
    }
  }

  return null;
}

/**
 * Decides what readiness should do next for one inspected candidate, and returns the evidence to
 * feed back into the next poll. A dead process is reported as such — out of memory, a restart loop,
 * a terminal exit — rather than being left to time out as an unreachable port, which tells the user
 * to fix a port when the process cannot stay alive.
 */
export function assessCandidateReadiness(input: {
  containerName: string;
  appPort: number;
  inspection: DockerContainerInspection;
  evidence: CandidateRuntimeEvidence;
  subject?: string;
  /**
   * Restarts the container had already accumulated before this supervision window began. Docker
   * reports `RestartCount` for the container's whole life, so a live container that is restarted in
   * place — rather than replaced — would otherwise be judged by restarts it recovered from long ago.
   */
  restartBaseline?: number;
  /**
   * Of the restarts in `restartBaseline`, how many happened moments before this supervision window
   * began. They still count toward a restart loop: a release that serves for a while between
   * crashes is up for most of its loop, so this window alone rarely sees it go down.
   */
  recentRestarts?: number;
  /**
   * For a container that was already running when this supervision window began: whether its
   * first inspection found it up with Docker's `OOMKilled` flag set, a memory kill it survived.
   * Such a flag says nothing about whether it serves: Docker 24 and later raise it when any
   * process in the container is killed for memory, a worker the container outlives included, and
   * earlier versions keep it across restart-policy restarts. Given, a memory kill counts only when
   * this was `false` and the flag is then seen with the container going down. Left out, as for a
   * new candidate, the flag counts as soon as it is reported.
   */
  outOfMemoryAtStart?: boolean;
}): CandidateReadinessAssessment {
  const evidence = recordEvidence(
    input.evidence,
    input.inspection,
    input.restartBaseline ?? 0,
    input.recentRestarts ?? 0,
    input.outOfMemoryAtStart
  );
  const { containerName } = input;
  const subject = input.subject ?? DEFAULT_READINESS_SUBJECT;
  const state = input.inspection.State;
  const status = state?.Status?.toLowerCase();

  if (evidence.outOfMemory) {
    return {
      evidence,
      step: {
        kind: "failed",
        cause: "out_of_memory",
        message: describeOutOfMemory(subject, containerName, evidence),
      },
    };
  }

  if (status !== undefined && TERMINAL_STATUSES.has(status)) {
    return {
      evidence,
      step: {
        kind: "failed",
        cause: "exited",
        message: describeTerminalStatus(subject, containerName, status, evidence),
      },
    };
  }

  if (evidence.restarts >= RESTART_LOOP_THRESHOLD) {
    return {
      evidence,
      step: {
        kind: "failed",
        cause: "restart_loop",
        message: describeRestartLoop(subject, containerName, evidence),
      },
    };
  }

  const health = state?.Health;
  if (health) {
    const healthStatus = health.Status?.toLowerCase() || "unknown";
    if (healthStatus === "healthy") {
      return { evidence, step: { kind: "ready" } };
    }

    if (healthStatus === "unhealthy") {
      return {
        evidence,
        step: {
          kind: "failed",
          cause: "unhealthy",
          message: `${subject} ${containerName} became unhealthy`,
        },
      };
    }

    return {
      evidence,
      step: {
        kind: "wait",
        message: `${subject} ${containerName} health status is ${healthStatus}`,
      },
    };
  }

  const ipAddress = resolveContainerIpAddress(input.inspection);
  if (ipAddress === null) {
    return {
      evidence,
      step: {
        kind: "wait",
        message: `${subject} ${containerName} has no routable IP address yet`,
      },
    };
  }

  return {
    evidence,
    step: {
      kind: "probe",
      ipAddress,
      unreachableMessage: `${subject} ${containerName} is not accepting TCP traffic on ${input.appPort}`,
    },
  };
}
