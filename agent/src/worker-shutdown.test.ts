import { describe, expect, mock, test } from "bun:test";
import type { DockerContainerInspection } from "./docker-api.js";
import { DockerApiError } from "./docker-api.js";
import {
  describeWorkerShutdownReport,
  resolveWorkerStopSignal,
  stopWorkerContainerGracefully,
  WORKER_SHUTDOWN_KILL_CONFIRM_MS,
} from "./worker-shutdown.js";

type SignalBehavior = "exits" | "ignores" | "survives_sigkill";

/**
 * A fake container whose process reacts to signals the way `behavior` says: `exits` stops after
 * `exitAfterMs` of fake time, `ignores` only dies on SIGKILL, `survives_sigkill` never dies.
 */
function createContainer(behavior: SignalBehavior, options: { exitAfterMs?: number } = {}) {
  let now = 0;
  let signalledAt: number | null = null;
  let killed = false;
  let restartPolicy = "unless-stopped";
  const clock = {
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };
  const isRunning = () => {
    if (behavior === "survives_sigkill") return true;
    if (killed) return false;
    return !(
      behavior === "exits" &&
      signalledAt !== null &&
      now - signalledAt >= (options.exitAfterMs ?? 0)
    );
  };
  const docker = {
    inspectContainer: mock(
      async (): Promise<DockerContainerInspection> => ({
        Id: "ctr_1",
        Name: "/nouva-worker-svc_1-dep_old-0",
        State: {
          Running: isRunning(),
          Status: isRunning() ? "running" : "exited",
          ExitCode: isRunning() ? 0 : killed ? 137 : 0,
        },
      })
    ),
    killContainer: mock(async (_identifier: string, signal: string) => {
      if (signal === "SIGKILL") killed = true;
      else signalledAt = now;
      return true;
    }),
    updateContainerRestartPolicy: mock(async (_identifier: string, policy: string) => {
      restartPolicy = policy;
    }),
  };
  return { clock, docker, restartPolicy: () => restartPolicy };
}

const policy = { signal: "SIGTERM" as const, gracePeriodSeconds: 30 };

describe("graceful worker shutdown", () => {
  test("reports a clean exit when the worker finishes within its grace period", async () => {
    const container = createContainer("exits", { exitAfterMs: 12_000 });

    const report = await stopWorkerContainerGracefully(container.docker, {
      identifier: "ctr_1",
      role: "previous",
      containerName: "nouva-worker-svc_1-dep_old-0",
      policy,
      clock: container.clock,
    });

    expect(report).toEqual({
      containerName: "nouva-worker-svc_1-dep_old-0",
      role: "previous",
      signal: "SIGTERM",
      gracePeriodSeconds: 30,
      outcome: "exited",
      exitCode: 0,
      elapsedMs: 12_000,
    });
    expect(container.docker.killContainer).toHaveBeenCalledTimes(1);
    expect(container.restartPolicy()).toBe("no");
  });

  test("sends the configured signal, not SIGTERM", async () => {
    const container = createContainer("exits");

    await stopWorkerContainerGracefully(container.docker, {
      identifier: "ctr_1",
      role: "previous",
      containerName: "worker",
      policy: { signal: "SIGQUIT", gracePeriodSeconds: 5 },
      clock: container.clock,
    });

    expect(container.docker.killContainer).toHaveBeenCalledWith("ctr_1", "SIGQUIT");
  });

  test("force-kills a worker that outlives its grace period and says so", async () => {
    const container = createContainer("ignores");

    const report = await stopWorkerContainerGracefully(container.docker, {
      identifier: "ctr_1",
      role: "previous",
      containerName: "worker",
      policy,
      clock: container.clock,
    });

    expect(report).toEqual(
      expect.objectContaining({ outcome: "forced", exitCode: 137, elapsedMs: 30_000 })
    );
    expect(container.docker.killContainer.mock.calls.map((call) => call[1])).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(describeWorkerShutdownReport(report)).toBe(
      "Worker worker did not exit within 30s of SIGTERM and was force-killed (exit code 137)"
    );
  });

  test("gives up on a container that survives SIGKILL after a bounded wait", async () => {
    const container = createContainer("survives_sigkill");

    const report = await stopWorkerContainerGracefully(container.docker, {
      identifier: "ctr_1",
      role: "previous",
      containerName: "worker",
      policy,
      clock: container.clock,
    });

    expect(report).toEqual(
      expect.objectContaining({
        outcome: "hung",
        exitCode: null,
        elapsedMs: 30_000 + WORKER_SHUTDOWN_KILL_CONFIRM_MS,
      })
    );
  });

  test("does not signal a container that is not running", async () => {
    const container = createContainer("exits");
    container.docker.inspectContainer.mockImplementation(async () => ({
      Id: "ctr_1",
      Name: "/worker",
      State: { Running: false, Status: "exited", ExitCode: 0 },
    }));

    const report = await stopWorkerContainerGracefully(container.docker, {
      identifier: "ctr_1",
      role: "previous",
      containerName: "worker",
      policy,
      clock: container.clock,
    });

    expect(report.outcome).toBe("already_stopped");
    expect(container.docker.killContainer).not.toHaveBeenCalled();
    expect(container.docker.updateContainerRestartPolicy).not.toHaveBeenCalled();
  });

  test("treats a container removed mid-shutdown as already stopped", async () => {
    const container = createContainer("ignores");
    container.docker.updateContainerRestartPolicy.mockImplementation(async () => {
      throw new DockerApiError(404, "POST", "/containers/ctr_1/update", "no such container");
    });

    const report = await stopWorkerContainerGracefully(container.docker, {
      identifier: "ctr_1",
      role: "previous",
      containerName: "worker",
      policy,
      clock: container.clock,
    });

    expect(report.outcome).toBe("already_stopped");
    expect(container.docker.killContainer).not.toHaveBeenCalled();
  });
});

describe("resolveWorkerStopSignal", () => {
  test("uses a chosen signal over the container's own", () => {
    expect(resolveWorkerStopSignal("SIGINT", "SIGQUIT")).toBe("SIGINT");
  });

  test.each([
    ["SIGQUIT", "SIGQUIT"],
    ["QUIT", "SIGQUIT"],
    ["sigwinch", "SIGWINCH"],
    ["3", "SIGQUIT"],
    ["28", "SIGWINCH"],
    ["", "SIGTERM"],
    [undefined, "SIGTERM"],
    ["99", "SIGTERM"],
    ["SIG TERM; x", "SIGTERM"],
  ])("keeps the image's stop signal %p as %p", (containerSignal, expected) => {
    expect(resolveWorkerStopSignal(null, containerSignal)).toBe(expected);
  });
});
