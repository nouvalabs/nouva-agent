import type { DockerApiClient, DockerContainerInspection } from "./docker-api.js";

/**
 * How far back a readiness check of a container that kept running counts restarts it did not see.
 * A release that serves for a while and then crashes is up for most of its loop: Docker restarts a
 * process that ran for over ten seconds after only 100 ms, and any other after at most a minute.
 * Finding it up and reachable then says nothing, and its recent restarts are the only evidence of
 * the loop. Restarts older than five minutes are history the container recovered from. The
 * lookback is best effort: Docker's event log holds only its latest few hundred events across all
 * containers, and each health check logs three, so on a host running a few workers it may reach
 * back only two or three minutes. A short log can only miss restarts, never report a loop that
 * did not happen.
 */
const RECENT_EXIT_WINDOW_MS = 5 * 60_000;

export function readRestartCount(inspection: DockerContainerInspection | null): number {
  const restarts = inspection?.RestartCount;
  return typeof restarts === "number" && Number.isFinite(restarts) && restarts > 0 ? restarts : 0;
}

/**
 * The restarts Docker's restart policy performed in the window before `until`. Its restart count
 * covers the container's whole life, so the recent ones are the exits its event log records in the
 * window. A stop by hand also logs an exit, but the start by hand that follows clears the restart
 * count, which therefore caps them.
 */
export async function countRecentRestarts(
  docker: Pick<DockerApiClient, "countContainerExits">,
  containerName: string,
  inspection: DockerContainerInspection,
  until: number
): Promise<number> {
  const restarts = readRestartCount(inspection);
  if (restarts === 0) return 0;
  try {
    const exits = await docker.countContainerExits(
      inspection.Id,
      until - RECENT_EXIT_WINDOW_MS,
      until
    );
    return Math.min(restarts, exits);
  } catch (error) {
    // No evidence against the container: it is judged, as before, by the restarts the check sees.
    console.warn(
      `[nouva-agent] could not read recent exits of container ${containerName}`,
      error instanceof Error ? error.message : error
    );
    return 0;
  }
}

/**
 * Whether the container has been up since at least the window divided by `loopThreshold` before
 * `until`. A steady loop reaching `loopThreshold` restarts in the window would have brought it down
 * again by then, and a slower one never reaches the threshold, so its recent restarts were a burst
 * it recovered from, as when a worker loses its queue for a moment. That holds only until it goes
 * down again: from then on they are the loop it is in.
 */
export function hasOutlastedRestartLoop(
  inspection: DockerContainerInspection,
  until: number,
  loopThreshold: number
): boolean {
  const state = inspection.State;
  // One waiting out its restart back-off reports the start of the run that just ended, and a start
  // Docker does not report (read as NaN) is no evidence that it recovered.
  return (
    state?.Running === true &&
    state.Status?.toLowerCase() === "running" &&
    Date.parse(state.StartedAt ?? "") <= until - RECENT_EXIT_WINDOW_MS / loopThreshold
  );
}
