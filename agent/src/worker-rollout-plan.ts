import type { WorkerRolloutPolicy } from "@repo/runtime/worker-shutdown";

/** A worker container the service already has when a rollout starts. */
export interface ExistingWorkerContainer {
  name: string;
  /** The `nouva.deployment.id` label, or `null` for a container that has none. */
  deploymentId: string | null;
  /**
   * Whether the container is part of the service's live runtime: running, or stopped but recorded
   * by the control plane as the live version (an earlier attempt of this rollout stopped it and
   * was interrupted). A stopped container of any other version is a leftover that decides nothing.
   */
  live: boolean;
}

export type WorkerRolloutPlan =
  | {
      /**
       * Start (or adopt) the candidates, wait for them to be ready, then retire every other
       * container gracefully. Old and new processes run side by side for the readiness window.
       */
      order: "candidate_first";
      strategy: "candidate_ready_cutover";
      reason: "overlap_policy" | "no_previous_version" | "scaled_to_zero";
      retireAfterReady: string[];
    }
  | {
      /**
       * Confirm every other container has stopped before any candidate starts. A candidate left
       * behind by an interrupted attempt is reset first, because it may have started while an old
       * process was still running and nothing can prove otherwise.
       */
      order: "stop_first";
      strategy: "stop_first_cutover" | "single_writer_snapshot_cutover";
      reason: "no_overlap_policy" | "single_writer_volume";
      resetCandidates: string[];
      stopBeforeStart: string[];
    };

/**
 * Decides the order in which a worker rollout starts the new processes and retires the old ones.
 *
 * A volume-backed worker is always stop-first: its volume must never have two writers, whatever the
 * rollout policy says. A `no_overlap` worker is stop-first only when an older version is actually
 * running; a scale change that keeps the same deployment has nothing to overlap with, so it adopts
 * the running replicas instead of restarting them. Only live containers decide the order: a stopped
 * leftover of an older version must not turn a scale change into a restart.
 *
 * The same decision covers first deploys, redeploys, rollbacks (a rollback is a rollout to an older
 * deployment) and retries after an interrupted attempt, which see the containers that attempt left.
 */
export function planWorkerRollout(input: {
  rolloutPolicy: WorkerRolloutPolicy;
  hasVolume: boolean;
  deploymentId: string;
  candidateNames: readonly string[];
  containers: readonly ExistingWorkerContainer[];
}): WorkerRolloutPlan {
  const candidateNames = new Set(input.candidateNames);
  const existingCandidates = input.containers.filter((container) =>
    candidateNames.has(container.name)
  );
  const others = input.containers.filter((container) => !candidateNames.has(container.name));
  const otherNames = others.map((container) => container.name);

  if (input.candidateNames.length === 0) {
    return {
      order: "candidate_first",
      strategy: "candidate_ready_cutover",
      reason: "scaled_to_zero",
      retireAfterReady: otherNames,
    };
  }

  const liveOthers = others.filter((container) => container.live);
  if (input.hasVolume && liveOthers.length > 0) {
    return {
      order: "stop_first",
      strategy: "single_writer_snapshot_cutover",
      reason: "single_writer_volume",
      resetCandidates: existingCandidates.map((container) => container.name),
      stopBeforeStart: otherNames,
    };
  }

  const olderVersionExists = liveOthers.some(
    (container) => container.deploymentId !== input.deploymentId
  );
  if (input.rolloutPolicy === "no_overlap" && olderVersionExists) {
    return {
      order: "stop_first",
      strategy: "stop_first_cutover",
      reason: "no_overlap_policy",
      resetCandidates: existingCandidates.map((container) => container.name),
      stopBeforeStart: otherNames,
    };
  }

  return {
    order: "candidate_first",
    strategy: "candidate_ready_cutover",
    reason:
      input.rolloutPolicy === "overlap" && olderVersionExists
        ? "overlap_policy"
        : "no_previous_version",
    retireAfterReady: otherNames,
  };
}
