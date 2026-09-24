import {
  isWorkerStopSignalName,
  type WorkerShutdownOutcome,
  type WorkerShutdownPolicy,
  type WorkerShutdownReport,
  type WorkerShutdownRole,
} from "@repo/runtime/worker-shutdown";
import { type DockerApiClient, DockerApiError } from "./docker-api.js";

export const WORKER_SHUTDOWN_POLL_INTERVAL_MS = 500;
/**
 * How long the agent waits for SIGKILL to take effect before it reports the container as hung.
 * SIGKILL cannot be handled, so a container still running after this is stuck in the kernel or
 * the runtime (uninterruptible I/O, a wedged shim), not in the worker's code, and waiting longer
 * would only hold the rollout and its lease.
 */
export const WORKER_SHUTDOWN_KILL_CONFIRM_MS = 15_000;

export type WorkerShutdownDocker = Pick<
  DockerApiClient,
  "inspectContainer" | "killContainer" | "updateContainerRestartPolicy"
>;

export interface WorkerShutdownClock {
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

export const SYSTEM_WORKER_SHUTDOWN_CLOCK: WorkerShutdownClock = {
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The Linux numbers Docker accepts for STOPSIGNAL, for the signals an image plausibly declares. */
const SIGNAL_NAMES_BY_NUMBER: Readonly<Record<string, string>> = {
  "1": "SIGHUP",
  "2": "SIGINT",
  "3": "SIGQUIT",
  "9": "SIGKILL",
  "10": "SIGUSR1",
  "12": "SIGUSR2",
  "15": "SIGTERM",
  "28": "SIGWINCH",
};

/**
 * The signal a stop sends: the policy's when it names one, otherwise the container's own
 * `Config.StopSignal` — the image's STOPSIGNAL, which Docker copies onto the container — so a
 * rollout stops the old process the same way `docker stop` would. A container without one, or
 * with a form this cannot name, gets Docker's own default, SIGTERM.
 */
export function resolveWorkerStopSignal(
  policySignal: WorkerShutdownPolicy["signal"],
  containerStopSignal: string | undefined
): string {
  if (policySignal) {
    return policySignal;
  }
  const raw = (containerStopSignal ?? "").trim().toUpperCase();
  const named = /^\d+$/.test(raw)
    ? SIGNAL_NAMES_BY_NUMBER[raw]
    : raw.startsWith("SIG")
      ? raw
      : `SIG${raw}`;
  return isWorkerStopSignalName(named) ? named : "SIGTERM";
}

async function readRunningState(
  docker: WorkerShutdownDocker,
  identifier: string
): Promise<{ running: boolean; exitCode: number | null; stopSignal: string | undefined }> {
  const inspection = await docker.inspectContainer(identifier);
  if (!inspection) {
    return { running: false, exitCode: null, stopSignal: undefined };
  }
  return {
    running: inspection.State?.Running === true,
    exitCode: typeof inspection.State?.ExitCode === "number" ? inspection.State.ExitCode : null,
    stopSignal: inspection.Config?.StopSignal,
  };
}

/** Polls until the container stops or `deadline` passes; returns the exit code once stopped. */
async function waitUntilStopped(
  docker: WorkerShutdownDocker,
  identifier: string,
  deadline: number,
  clock: WorkerShutdownClock
): Promise<{ stopped: true; exitCode: number | null } | { stopped: false }> {
  for (;;) {
    const state = await readRunningState(docker, identifier);
    if (!state.running) {
      return { stopped: true, exitCode: state.exitCode };
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      return { stopped: false };
    }
    await clock.wait(Math.min(WORKER_SHUTDOWN_POLL_INTERVAL_MS, remaining));
  }
}

/**
 * Stops one worker container the way its policy asks, and reports how it went instead of throwing
 * on a slow or stuck process — the caller decides whether that outcome blocks the rollout.
 *
 * The restart policy is switched to `no` first. Otherwise a worker that exits cleanly on SIGTERM
 * would be restarted by the daemon under `unless-stopped`, which a `kill` does not suppress the way
 * `docker stop` does, and the old version would come back while the new one runs.
 *
 * The whole call is bounded by the grace period plus `WORKER_SHUTDOWN_KILL_CONFIRM_MS`.
 */
export async function stopWorkerContainerGracefully(
  docker: WorkerShutdownDocker,
  input: {
    identifier: string;
    containerName: string;
    role: WorkerShutdownRole;
    policy: Pick<WorkerShutdownPolicy, "signal" | "gracePeriodSeconds">;
    clock?: WorkerShutdownClock;
  }
): Promise<WorkerShutdownReport> {
  const clock = input.clock ?? SYSTEM_WORKER_SHUTDOWN_CLOCK;
  const startedAt = clock.now();
  const initial = await readRunningState(docker, input.identifier);
  const signal = resolveWorkerStopSignal(input.policy.signal, initial.stopSignal);
  const report = (outcome: WorkerShutdownOutcome, exitCode: number | null) => ({
    containerName: input.containerName,
    role: input.role,
    signal,
    gracePeriodSeconds: input.policy.gracePeriodSeconds,
    outcome,
    exitCode,
    elapsedMs: Math.max(0, clock.now() - startedAt),
  });

  if (!initial.running) {
    return report("already_stopped", initial.exitCode);
  }

  try {
    await docker.updateContainerRestartPolicy(input.identifier, "no");
  } catch (error) {
    // The container disappearing between the inspect and the update is the outcome we want.
    if (error instanceof DockerApiError && error.status === 404) {
      return report("already_stopped", null);
    }
    throw error;
  }

  await docker.killContainer(input.identifier, signal);
  const graceful = await waitUntilStopped(
    docker,
    input.identifier,
    startedAt + input.policy.gracePeriodSeconds * 1_000,
    clock
  );
  if (graceful.stopped) {
    return report("exited", graceful.exitCode);
  }

  await docker.killContainer(input.identifier, "SIGKILL");
  const forced = await waitUntilStopped(
    docker,
    input.identifier,
    clock.now() + WORKER_SHUTDOWN_KILL_CONFIRM_MS,
    clock
  );
  return forced.stopped ? report("forced", forced.exitCode) : report("hung", null);
}

/** One log line per shutdown, for the deployment's build log. */
export function describeWorkerShutdownReport(report: WorkerShutdownReport): string {
  const seconds = (report.elapsedMs / 1_000).toFixed(1);
  const exit = report.exitCode === null ? "" : ` (exit code ${report.exitCode})`;
  switch (report.outcome) {
    case "already_stopped":
      return `Worker ${report.containerName} was already stopped`;
    case "exited":
      return `Worker ${report.containerName} exited ${seconds}s after ${report.signal}${exit}`;
    case "forced":
      return (
        `Worker ${report.containerName} did not exit within ${report.gracePeriodSeconds}s of ` +
        `${report.signal} and was force-killed${exit}`
      );
    case "hung":
      return `Worker ${report.containerName} is still running after SIGKILL`;
    case "unconfirmed":
      return `Worker ${report.containerName} could not be confirmed stopped (Docker returned an error)`;
  }
}
