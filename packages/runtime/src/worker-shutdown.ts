/**
 * How a continuous worker's process is retired when a rollout replaces it (#284).
 *
 * This module is the agent wire contract for the policy and for the shutdown outcomes the agent
 * reports back. It imports nothing so the public agent mirror can ship it as is; the control plane
 * stores the same vocabulary in `@repo/db/schema`, and a test keeps the two lists identical.
 */

/**
 * Signals a worker may ask to be stopped with. Deliberately excludes SIGKILL and SIGSTOP, which a
 * process cannot handle: SIGKILL is what the agent sends once the grace period runs out.
 */
export const WORKER_SHUTDOWN_SIGNALS = [
  "SIGTERM",
  "SIGINT",
  "SIGQUIT",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2",
] as const;
export type WorkerShutdownSignal = (typeof WORKER_SHUTDOWN_SIGNALS)[number];

/**
 * `overlap` starts the replacement and waits for it to be ready before retiring the old process,
 * so a queue consumer never stops consuming. `no_overlap` confirms the old process has stopped
 * before the replacement starts, so a singleton scheduler never runs twice.
 */
export const WORKER_ROLLOUT_POLICIES = ["overlap", "no_overlap"] as const;
export type WorkerRolloutPolicy = (typeof WORKER_ROLLOUT_POLICIES)[number];

export const MIN_WORKER_SHUTDOWN_GRACE_PERIOD_SECONDS = 1;
export const MAX_WORKER_SHUTDOWN_GRACE_PERIOD_SECONDS = 3_600;

export interface WorkerShutdownPolicy {
  /**
   * `null` keeps the image's own stop signal (its `STOPSIGNAL`, or SIGTERM when it declares none),
   * which is what every worker got before the policy existed. Docker uses that signal for a stop,
   * a restart, a daemon shutdown and a host reboot, so overriding it by default would change how
   * an image built around SIGQUIT or SIGINT drains.
   */
  signal: WorkerShutdownSignal | null;
  gracePeriodSeconds: number;
  rolloutPolicy: WorkerRolloutPolicy;
}

/**
 * What every worker gets unless it says otherwise, including every worker created before the
 * policy existed. `overlap` keeps the rollout order and the image's stop signal keeps the signal
 * those workers already had; a 30-second grace period replaces the forced removal they used to
 * get, which is the behavior change #284 is for.
 */
export const DEFAULT_WORKER_SHUTDOWN_POLICY: WorkerShutdownPolicy = Object.freeze({
  signal: null,
  gracePeriodSeconds: 30,
  rolloutPolicy: "overlap",
});

export function isWorkerShutdownSignal(value: unknown): value is WorkerShutdownSignal {
  return (WORKER_SHUTDOWN_SIGNALS as readonly unknown[]).includes(value);
}

/**
 * A signal name a shutdown report may carry. Wider than `WORKER_SHUTDOWN_SIGNALS` because a worker
 * that keeps its image's signal is stopped with whatever the image declares (httpd uses SIGWINCH),
 * but still a bare signal name, which cannot carry environment material.
 */
export function isWorkerStopSignalName(value: unknown): value is string {
  return typeof value === "string" && /^SIG[A-Z][A-Z0-9+]{0,15}$/.test(value);
}

export function isWorkerRolloutPolicy(value: unknown): value is WorkerRolloutPolicy {
  return (WORKER_ROLLOUT_POLICIES as readonly unknown[]).includes(value);
}

export function isWorkerShutdownGracePeriodSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_WORKER_SHUTDOWN_GRACE_PERIOD_SECONDS &&
    value <= MAX_WORKER_SHUTDOWN_GRACE_PERIOD_SECONDS
  );
}

/** Returns the policy when `value` is a complete, valid one, and `null` otherwise. */
export function parseWorkerShutdownPolicy(value: unknown): WorkerShutdownPolicy | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !(record.signal === null || isWorkerShutdownSignal(record.signal)) ||
    !isWorkerShutdownGracePeriodSeconds(record.gracePeriodSeconds) ||
    !isWorkerRolloutPolicy(record.rolloutPolicy)
  ) {
    return null;
  }
  return {
    signal: record.signal,
    gracePeriodSeconds: record.gracePeriodSeconds,
    rolloutPolicy: record.rolloutPolicy,
  };
}

/**
 * How one container's shutdown ended:
 * - `exited`: it stopped on its own within the grace period after the configured signal;
 * - `forced`: it was still running when the grace period ran out and was killed with SIGKILL;
 * - `already_stopped`: it was not running when the agent came to stop it (for example on a retry
 *   after the agent restarted mid-rollout, when the earlier attempt's outcome is no longer known);
 * - `hung`: it survived SIGKILL for the agent's bounded wait, so the agent cannot claim it stopped;
 * - `unconfirmed`: a Docker call failed part-way (the restart-policy update, the kill, or an
 *   inspect while waiting), so the agent does not know whether it stopped.
 */
export const WORKER_SHUTDOWN_OUTCOMES = [
  "exited",
  "forced",
  "already_stopped",
  "hung",
  "unconfirmed",
] as const;
export type WorkerShutdownOutcome = (typeof WORKER_SHUTDOWN_OUTCOMES)[number];

/**
 * Why a rollout stopped a container:
 * - `previous`: it ran an older deployment the rollout replaces;
 * - `surplus`: it ran the rollout's own deployment at a replica index the new count drops;
 * - `candidate`: it was started for the rollout's deployment and then stopped — a leftover from an
 *   interrupted attempt, or a candidate that failed readiness.
 */
export const WORKER_SHUTDOWN_ROLES = ["previous", "surplus", "candidate"] as const;
export type WorkerShutdownRole = (typeof WORKER_SHUTDOWN_ROLES)[number];

export interface WorkerShutdownReport {
  containerName: string;
  role: WorkerShutdownRole;
  /** The signal actually sent: the policy's, or the image's own when the policy keeps it. */
  signal: string;
  gracePeriodSeconds: number;
  outcome: WorkerShutdownOutcome;
  exitCode: number | null;
  elapsedMs: number;
}

function parseWorkerShutdownReport(value: unknown): WorkerShutdownReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.containerName !== "string" ||
    record.containerName.length === 0 ||
    !(WORKER_SHUTDOWN_ROLES as readonly unknown[]).includes(record.role) ||
    !isWorkerStopSignalName(record.signal) ||
    !isWorkerShutdownGracePeriodSeconds(record.gracePeriodSeconds) ||
    !(WORKER_SHUTDOWN_OUTCOMES as readonly unknown[]).includes(record.outcome) ||
    !(record.exitCode === null || Number.isInteger(record.exitCode)) ||
    typeof record.elapsedMs !== "number" ||
    !Number.isFinite(record.elapsedMs) ||
    record.elapsedMs < 0
  ) {
    return null;
  }
  return {
    containerName: record.containerName,
    role: record.role as WorkerShutdownRole,
    signal: record.signal,
    gracePeriodSeconds: record.gracePeriodSeconds,
    outcome: record.outcome as WorkerShutdownOutcome,
    exitCode: record.exitCode as number | null,
    elapsedMs: Math.round(record.elapsedMs),
  };
}

/** Reads the shutdown reports out of an agent's rollout result, dropping anything malformed. */
export function parseWorkerShutdownReports(value: unknown): WorkerShutdownReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const report = parseWorkerShutdownReport(entry);
    return report ? [report] : [];
  });
}

/**
 * The shutdown fields of a worker rollout result (`policy`, `shutdowns`), rebuilt from their closed
 * vocabularies. Both ends of the agent protocol use this instead of redacting those fields: a
 * signal, role or outcome cannot carry environment material, and redacting one because a customer
 * variable happens to equal "SIGTERM" or "previous" would reject the result of a rollout that has
 * already replaced the old containers. Container names are free text, so they still go through
 * `redactContainerName`. Only the fields `rollout` has are returned.
 */
export function sanitizeWorkerRolloutShutdownFields(
  rollout: Readonly<Record<string, unknown>>,
  redactContainerName: (containerName: string) => unknown
): {
  policy?: WorkerShutdownPolicy | null;
  shutdowns?: Array<Omit<WorkerShutdownReport, "containerName"> & { containerName: unknown }>;
} {
  return {
    ...(Object.hasOwn(rollout, "policy")
      ? { policy: parseWorkerShutdownPolicy(rollout.policy) }
      : {}),
    ...(Object.hasOwn(rollout, "shutdowns")
      ? {
          shutdowns: parseWorkerShutdownReports(rollout.shutdowns).map((report) => ({
            ...report,
            containerName: redactContainerName(report.containerName),
          })),
        }
      : {}),
  };
}

const ROLE_NOUNS: Record<WorkerShutdownRole, readonly [string, string]> = {
  previous: ["Previous worker", "Previous workers"],
  surplus: ["Retired replica", "Retired replicas"],
  candidate: ["Leftover candidate", "Leftover candidates"],
};

/** "Previous worker a and leftover candidate b", naming each container by why it was stopped. */
function describeContainers(reports: WorkerShutdownReport[]): string {
  const groups = WORKER_SHUTDOWN_ROLES.flatMap((role) => {
    const names = reports
      .filter((report) => report.role === role)
      .map((report) => report.containerName);
    return names.length > 0 ? [{ role, names }] : [];
  });
  return groups
    .map(({ role, names }, index) => {
      const [singular, plural] = ROLE_NOUNS[role];
      const noun = names.length === 1 ? singular : plural;
      return `${index === 0 ? noun : noun.toLowerCase()} ${names.join(", ")}`;
    })
    .join(" and ");
}

/**
 * The warning a completed rollout should surface, or `null` when every retired process stopped
 * within its grace period. A forced kill is not a failed rollout — the replacement is running —
 * but it means a job may have been interrupted, which the operator needs to see.
 */
export function describeWorkerShutdownWarning(reports: WorkerShutdownReport[]): string | null {
  const hung = reports.filter((report) => report.outcome === "hung");
  const unconfirmed = reports.filter((report) => report.outcome === "unconfirmed");
  const forced = reports.filter((report) => report.outcome === "forced");
  const sentences: string[] = [];
  if (hung.length > 0) {
    sentences.push(
      `${describeContainers(hung)} did not stop even after SIGKILL and may still be ` +
        "running on the server; remove it there or redeploy to retry."
    );
  }
  if (unconfirmed.length > 0) {
    sentences.push(
      `${describeContainers(unconfirmed)} could not be confirmed stopped because Docker ` +
        "returned an error, and may still be running on the server; remove it there or " +
        "redeploy to retry."
    );
  }
  if (forced.length > 0) {
    const [first] = forced;
    sentences.push(
      `${describeContainers(forced)} did not exit within ${first?.gracePeriodSeconds}s ` +
        `of ${first?.signal} and ${forced.length === 1 ? "was" : "were"} force-killed; ` +
        "an in-flight job may have been interrupted. Raise the shutdown grace period if jobs " +
        "need longer to finish."
    );
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}
