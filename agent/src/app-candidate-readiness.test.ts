import { describe, expect, test } from "bun:test";
import {
  assessCandidateReadiness,
  type CandidateRuntimeEvidence,
  NO_CANDIDATE_RUNTIME_EVIDENCE,
} from "./app-candidate-readiness.js";
import type { DockerContainerInspection } from "./docker-api.js";

const CONTAINER_NAME = "nouva-app-svc_1-dep_1";
const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

function inspect(
  overrides: Partial<DockerContainerInspection> & {
    state?: NonNullable<DockerContainerInspection["State"]>;
  } = {}
): DockerContainerInspection {
  const { state, ...rest } = overrides;
  return {
    Id: "ctr_candidate",
    Name: CONTAINER_NAME,
    State: { Running: true, Status: "running", ...state },
    HostConfig: { Memory: MEMORY_LIMIT_BYTES, MemorySwap: MEMORY_LIMIT_BYTES },
    NetworkSettings: { Networks: { "nouva-local": { IPAddress: "172.19.0.10" } } },
    ...rest,
  };
}

function assess(
  inspection: DockerContainerInspection,
  evidence: CandidateRuntimeEvidence = NO_CANDIDATE_RUNTIME_EVIDENCE
) {
  return assessCandidateReadiness({
    containerName: CONTAINER_NAME,
    appPort: 8080,
    inspection,
    evidence,
  });
}

describe("assessCandidateReadiness", () => {
  test("probes TCP while a container without a health check has an address", () => {
    expect(assess(inspect()).step).toEqual({
      kind: "probe",
      ipAddress: "172.19.0.10",
      unreachableMessage: `Candidate container ${CONTAINER_NAME} is not accepting TCP traffic on 8080`,
    });
  });

  test("keeps waiting while a starting health check has not settled", () => {
    const assessment = assess(inspect({ state: { Health: { Status: "starting" } } }));

    expect(assessment.step).toEqual({
      kind: "wait",
      message: `Candidate container ${CONTAINER_NAME} health status is starting`,
    });
  });

  test("waits without an address until the container joins the network", () => {
    expect(assess(inspect({ NetworkSettings: {} })).step).toEqual({
      kind: "wait",
      message: `Candidate container ${CONTAINER_NAME} has no routable IP address yet`,
    });
  });

  test("reports a healthy container as ready", () => {
    expect(assess(inspect({ state: { Health: { Status: "healthy" } } })).step).toEqual({
      kind: "ready",
    });
  });

  test("fails on an unhealthy container", () => {
    expect(assess(inspect({ state: { Health: { Status: "unhealthy" } } })).step).toEqual({
      kind: "failed",
      cause: "unhealthy",
      message: `Candidate container ${CONTAINER_NAME} became unhealthy`,
    });
  });

  test("names the memory limit when the kernel killed the container", () => {
    const assessment = assess(
      inspect({
        RestartCount: 3,
        state: { Running: true, Status: "running", OOMKilled: true },
      })
    );

    expect(assessment.step).toEqual({
      kind: "failed",
      cause: "out_of_memory",
      message: `Candidate container ${CONTAINER_NAME} ran out of memory and was killed (memory limit 128 MiB, swap disabled, 3 restarts); raise the service memory limit and redeploy`,
    });
  });

  test("keeps the out-of-memory evidence after Docker restarts the process", () => {
    const killed = assess(
      inspect({
        RestartCount: 1,
        state: { Running: false, Status: "restarting", OOMKilled: true, ExitCode: 137 },
      })
    );
    const restarted = assess(
      inspect({ RestartCount: 2, state: { Running: true, Status: "running" } }),
      killed.evidence
    );

    expect(restarted.step).toEqual({
      kind: "failed",
      cause: "out_of_memory",
      message: `Candidate container ${CONTAINER_NAME} ran out of memory and was killed (memory limit 128 MiB, swap disabled, 2 restarts); raise the service memory limit and redeploy`,
    });
  });

  test("reports an unbounded swap allowance rather than dropping it", () => {
    const assessment = assess(
      inspect({
        HostConfig: { Memory: MEMORY_LIMIT_BYTES, MemorySwap: -1 },
        state: { Running: true, Status: "running", OOMKilled: true },
      })
    );

    expect(assessment.step).toMatchObject({
      message: `Candidate container ${CONTAINER_NAME} ran out of memory and was killed (memory limit 128 MiB, swap unlimited); raise the service memory limit and redeploy`,
    });
  });

  test("reports the combined memory and swap allowance when swap is available", () => {
    const assessment = assess(
      inspect({
        HostConfig: { Memory: MEMORY_LIMIT_BYTES, MemorySwap: 512 * 1024 * 1024 },
        state: { Running: true, Status: "running", OOMKilled: true },
      })
    );

    expect(assessment.step).toMatchObject({
      message: `Candidate container ${CONTAINER_NAME} ran out of memory and was killed (memory limit 128 MiB, memory and swap limit 512 MiB); raise the service memory limit and redeploy`,
    });
  });

  test("reports the exit code once a container has exited repeatedly", () => {
    const firstExit = assess(
      inspect({
        RestartCount: 1,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 1 },
      })
    );
    expect(firstExit.step.kind).toBe("wait");

    const secondExit = assess(
      inspect({
        RestartCount: 2,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 1 },
      }),
      firstExit.evidence
    );

    expect(secondExit.step).toEqual({
      kind: "failed",
      cause: "restart_loop",
      message: `Candidate container ${CONTAINER_NAME} keeps restarting (2 restarts, last exit code 1); the process is exiting instead of serving traffic`,
    });
  });

  test("remembers the exit code that a later running inspection erases", () => {
    const exited = assess(
      inspect({
        RestartCount: 1,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 3 },
      })
    );
    const restarted = assess(
      inspect({ RestartCount: 2, state: { Running: true, Status: "running", ExitCode: 0 } }),
      exited.evidence
    );

    expect(restarted.step).toMatchObject({
      cause: "restart_loop",
      message: `Candidate container ${CONTAINER_NAME} keeps restarting (2 restarts, last exit code 3); the process is exiting instead of serving traffic`,
    });
  });

  test("keeps the failing exit code when a later restarting poll reports zero", () => {
    const killed = assess(
      inspect({
        RestartCount: 1,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 137 },
      })
    );
    const zeroed = assess(
      inspect({
        RestartCount: 2,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 0 },
      }),
      killed.evidence
    );

    expect(zeroed.step).toMatchObject({
      cause: "restart_loop",
      message: `Candidate container ${CONTAINER_NAME} keeps restarting (2 restarts, last exit code 137); the process is exiting instead of serving traffic`,
    });
  });

  test("reports a clean exit when the process never failed with a code", () => {
    const first = assess(
      inspect({
        RestartCount: 1,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 0 },
      })
    );
    const second = assess(
      inspect({
        RestartCount: 2,
        NetworkSettings: {},
        state: { Running: false, Status: "restarting", ExitCode: 0 },
      }),
      first.evidence
    );

    expect(second.step).toMatchObject({
      cause: "restart_loop",
      message: `Candidate container ${CONTAINER_NAME} keeps restarting (2 restarts, last exit code 0); the process is exiting instead of serving traffic`,
    });
  });

  /**
   * Docker zeroes `RestartCount` when a container is started by hand (verified on Docker 29.1.3: a
   * container left at RestartCount=5 by a crash loop reports 0 immediately after `docker start`).
   * Rollback restarts the live container, so readiness always begins its count at zero and a
   * container's earlier crash history can never be mistaken for a loop in this deployment.
   */
  test("treats a manually started container as unrestarted", () => {
    const assessment = assess(
      inspect({ RestartCount: 0, state: { Running: true, Status: "running", ExitCode: 0 } })
    );

    expect(assessment.evidence.restarts).toBe(0);
    expect(assessment.step.kind).toBe("probe");
  });

  test("still probes a container that restarted once and came back up", () => {
    const restarted = assess(
      inspect({ RestartCount: 1, state: { Running: true, Status: "running", ExitCode: 0 } })
    );

    expect(restarted.step.kind).toBe("probe");
  });

  test("appends the exit code to a terminal container", () => {
    const assessment = assess(
      inspect({ state: { Running: false, Status: "exited", ExitCode: 1 } })
    );

    expect(assessment.step).toEqual({
      kind: "failed",
      cause: "exited",
      message: `Candidate container ${CONTAINER_NAME} is not running (exited, exit code 1)`,
    });
  });

  test("leaves the terminal message unchanged when Docker reports no exit code", () => {
    const assessment = assess(inspect({ state: { Running: false, Status: "exited" } }));

    expect(assessment.step).toEqual({
      kind: "failed",
      cause: "exited",
      message: `Candidate container ${CONTAINER_NAME} is not running (exited)`,
    });
  });
});

describe("assessCandidateReadiness of a container that was already running", () => {
  function assessRunning(
    inspection: DockerContainerInspection,
    outOfMemoryAtStart: boolean,
    evidence: CandidateRuntimeEvidence = NO_CANDIDATE_RUNTIME_EVIDENCE
  ) {
    return assessCandidateReadiness({
      containerName: CONTAINER_NAME,
      appPort: 8080,
      inspection,
      evidence,
      restartBaseline: 0,
      outOfMemoryAtStart,
    });
  }

  test("still probes a container that carried the memory-kill flag from before", () => {
    const assessment = assessRunning(inspect({ state: { OOMKilled: true } }), true);

    expect(assessment.evidence.outOfMemory).toBe(false);
    expect(assessment.step.kind).toBe("probe");
  });

  test("still probes a container that outlives a process killed for memory", () => {
    // Docker 24 and later raise the flag while the container keeps running.
    const assessment = assessRunning(inspect({ state: { OOMKilled: true } }), false);

    expect(assessment.evidence.outOfMemory).toBe(false);
    expect(assessment.step.kind).toBe("probe");
  });

  test.each([
    ["restarting", inspect({ state: { Status: "restarting", OOMKilled: true, ExitCode: 137 } })],
    ["restarted", inspect({ RestartCount: 1, state: { OOMKilled: true } })],
    ["exited", inspect({ state: { Running: false, Status: "exited", OOMKilled: true } })],
  ])("reports a memory kill it sees the container %s with", (_outcome, inspection) => {
    const assessment = assessRunning(inspection, false);

    expect(assessment.evidence.outOfMemory).toBe(true);
    expect(assessment.step).toEqual(
      expect.objectContaining({ kind: "failed", cause: "out_of_memory" })
    );
  });

  test.each([
    ["two restarts moments before the check", 2, 5],
    ["one restart moments before the check and one it sees", 1, 6],
  ])("reports a restart loop from %s", (_restarts, recentRestarts, restartCount) => {
    const assessment = assessCandidateReadiness({
      containerName: CONTAINER_NAME,
      appPort: 8080,
      inspection: inspect({ RestartCount: restartCount }),
      evidence: NO_CANDIDATE_RUNTIME_EVIDENCE,
      restartBaseline: 5,
      recentRestarts,
      outOfMemoryAtStart: false,
    });

    expect(assessment.evidence.restarts).toBe(2);
    expect(assessment.step).toEqual(
      expect.objectContaining({ kind: "failed", cause: "restart_loop" })
    );
  });

  test("still probes a container that restarted moments before the check and then outlives a process killed for memory", () => {
    // Only a restart the check sees shows the container going down with the flag.
    const assessment = assessCandidateReadiness({
      containerName: CONTAINER_NAME,
      appPort: 8080,
      inspection: inspect({ RestartCount: 5, state: { OOMKilled: true } }),
      evidence: NO_CANDIDATE_RUNTIME_EVIDENCE,
      restartBaseline: 5,
      recentRestarts: 1,
      outOfMemoryAtStart: false,
    });

    expect(assessment.evidence.outOfMemory).toBe(false);
    expect(assessment.step.kind).toBe("probe");
  });

  test("judges a container down with a flag it carried from before by how it went down", () => {
    const assessment = assessRunning(
      inspect({ state: { Running: false, Status: "exited", OOMKilled: true, ExitCode: 1 } }),
      true
    );

    expect(assessment.step).toEqual(expect.objectContaining({ kind: "failed", cause: "exited" }));
  });
});
