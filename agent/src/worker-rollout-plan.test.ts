import { describe, expect, test } from "bun:test";
import { planWorkerRollout } from "./worker-rollout-plan.js";

const candidate = "nouva-worker-svc_1-dep_new-0";
const previous = { name: "nouva-worker-svc_1-dep_old-0", deploymentId: "dep_old", live: true };

function plan(overrides: Partial<Parameters<typeof planWorkerRollout>[0]> = {}) {
  return planWorkerRollout({
    rolloutPolicy: "overlap",
    hasVolume: false,
    deploymentId: "dep_new",
    candidateNames: [candidate],
    containers: [previous],
    ...overrides,
  });
}

describe("worker rollout ordering", () => {
  test("overlap starts the replacement first and retires the old version once it is ready", () => {
    expect(plan()).toEqual({
      order: "candidate_first",
      strategy: "candidate_ready_cutover",
      reason: "overlap_policy",
      retireAfterReady: [previous.name],
    });
  });

  test("no_overlap stops the old version before the replacement starts", () => {
    expect(plan({ rolloutPolicy: "no_overlap" })).toEqual({
      order: "stop_first",
      strategy: "stop_first_cutover",
      reason: "no_overlap_policy",
      resetCandidates: [],
      stopBeforeStart: [previous.name],
    });
  });

  test("a rollback to an older deployment follows the same no_overlap order", () => {
    expect(
      plan({
        rolloutPolicy: "no_overlap",
        deploymentId: "dep_old",
        candidateNames: [previous.name],
        containers: [{ name: candidate, deploymentId: "dep_new", live: true }],
      })
    ).toEqual(expect.objectContaining({ order: "stop_first", stopBeforeStart: [candidate] }));
  });

  test("a no_overlap retry resets the candidate an interrupted attempt left running", () => {
    expect(
      plan({
        rolloutPolicy: "no_overlap",
        containers: [previous, { name: candidate, deploymentId: "dep_new", live: true }],
      })
    ).toEqual({
      order: "stop_first",
      strategy: "stop_first_cutover",
      reason: "no_overlap_policy",
      resetCandidates: [candidate],
      stopBeforeStart: [previous.name],
    });
  });

  test("an overlap retry adopts the candidate it already started", () => {
    expect(
      plan({ containers: [previous, { name: candidate, deploymentId: "dep_new", live: true }] })
    ).toEqual(
      expect.objectContaining({ order: "candidate_first", retireAfterReady: [previous.name] })
    );
  });

  test("a volume forces stop-first even when the policy allows overlap", () => {
    expect(plan({ hasVolume: true })).toEqual({
      order: "stop_first",
      strategy: "single_writer_snapshot_cutover",
      reason: "single_writer_volume",
      resetCandidates: [],
      stopBeforeStart: [previous.name],
    });
  });

  test("a no_overlap scale-down keeps the running replicas and retires only the surplus", () => {
    const replica = (index: number) => `nouva-worker-svc_1-dep_new-${index}`;
    expect(
      plan({
        rolloutPolicy: "no_overlap",
        candidateNames: [replica(0)],
        containers: [0, 1, 2].map((index) => ({
          name: replica(index),
          deploymentId: "dep_new",
          live: true,
        })),
      })
    ).toEqual({
      order: "candidate_first",
      strategy: "candidate_ready_cutover",
      reason: "no_previous_version",
      retireAfterReady: [replica(1), replica(2)],
    });
  });

  test("scaling to zero retires everything and starts nothing", () => {
    expect(plan({ rolloutPolicy: "no_overlap", hasVolume: true, candidateNames: [] })).toEqual({
      order: "candidate_first",
      strategy: "candidate_ready_cutover",
      reason: "scaled_to_zero",
      retireAfterReady: [previous.name],
    });
  });

  test("a first deploy has nothing to retire", () => {
    expect(plan({ rolloutPolicy: "no_overlap", hasVolume: true, containers: [] })).toEqual({
      order: "candidate_first",
      strategy: "candidate_ready_cutover",
      reason: "no_previous_version",
      retireAfterReady: [],
    });
  });

  test("a stopped leftover of an older version does not turn a scale-up into a restart", () => {
    const replica = (index: number) => `nouva-worker-svc_1-dep_new-${index}`;
    const running = [0, 1].map((index) => ({
      name: replica(index),
      deploymentId: "dep_new",
      live: true,
    }));
    const leftover = { ...previous, live: false };
    expect(
      plan({
        rolloutPolicy: "no_overlap",
        candidateNames: [0, 1, 2].map(replica),
        containers: [...running, leftover],
      })
    ).toEqual({
      order: "candidate_first",
      strategy: "candidate_ready_cutover",
      reason: "no_previous_version",
      retireAfterReady: [previous.name],
    });
    expect(plan({ hasVolume: true, containers: [...running.slice(0, 1), leftover] })).toEqual(
      expect.objectContaining({ order: "candidate_first", retireAfterReady: [previous.name] })
    );
  });

  test("a stopped version the control plane still records as live keeps the rollout stop-first", () => {
    const interrupted = { ...previous, live: true };
    expect(plan({ rolloutPolicy: "no_overlap", containers: [interrupted] })).toEqual(
      expect.objectContaining({ order: "stop_first", stopBeforeStart: [previous.name] })
    );
    expect(plan({ hasVolume: true, containers: [interrupted] })).toEqual(
      expect.objectContaining({
        strategy: "single_writer_snapshot_cutover",
        stopBeforeStart: [previous.name],
      })
    );
  });

  test("an unlabelled container counts as an older version", () => {
    expect(
      plan({
        rolloutPolicy: "no_overlap",
        containers: [{ name: "legacy", deploymentId: null, live: true }],
      })
    ).toEqual(expect.objectContaining({ order: "stop_first", stopBeforeStart: ["legacy"] }));
  });
});
