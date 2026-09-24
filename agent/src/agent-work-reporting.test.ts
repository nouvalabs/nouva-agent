import { expect, mock, test } from "bun:test";
import { ApiRequestError, executeAndReportAgentWork } from "./agent-work-reporting.js";

const apiError = (status: number) =>
  new ApiRequestError({ status, method: "POST", pathName: "/complete", message: "secret" });

test("accepted completion with a lost reply retries the same receipt while keeping its lease and runtime", async () => {
  const events: string[] = [];
  const receipt = { kind: "complete" as const, result: { containerId: "candidate" } };
  const prepare = mock(async () => receipt);
  const rejectResult = mock(async () => ({
    kind: "fail" as const,
    result: null,
    errorMessage: "rejected",
  }));
  const send = mock(async () => {
    events.push("send");
    if (events.length === 1) throw new TypeError("reply lost after commit");
  });
  await executeAndReportAgentWork({
    work: { id: "work_1", kind: "deploy_app" },
    prepare,
    send,
    rejectResult,
    stopLease: async () => {
      events.push("stop");
    },
    redactError: () => "redacted",
    sleep: async () => {
      events.push("wait");
    },
    log: () => {},
  });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls).toEqual([[receipt], [receipt]]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(rejectResult).not.toHaveBeenCalled();
  expect(events).toEqual(["send", "wait", "send", "stop"]);
});

test.each([404, 409, 422, 401])("terminal HTTP %i is not retried", async (status) => {
  const send = mock(async () => {
    throw apiError(status);
  });
  const rejectResult = mock(async () => ({
    kind: "fail" as const,
    result: null,
    errorMessage: "rejected",
  }));
  const stopLease = mock(async () => {});
  const logs: string[] = [];
  await executeAndReportAgentWork({
    work: { id: "w", kind: "deploy_app" },
    prepare: async () => ({ kind: "complete", result: {} }),
    send,
    rejectResult,
    stopLease,
    redactError: () => "[REDACTED]",
    log: (message) => {
      logs.push(message);
    },
    sleep: async () => {
      throw new Error("unexpected retry");
    },
  });
  expect(send).toHaveBeenCalledTimes(status === 422 ? 2 : 1);
  expect(rejectResult).toHaveBeenCalledTimes(status === 422 ? 1 : 0);
  expect(stopLease).toHaveBeenCalledTimes(1);
  expect(logs.join(" ")).not.toContain("secret");
});

test("exhausted transient completion retries preserve runtime and stop renewal after the last request", async () => {
  const delays: number[] = [];
  const send = mock(async () => {
    throw apiError(502);
  });
  const rejectResult = mock(async () => ({
    kind: "fail" as const,
    result: null,
    errorMessage: "rejected",
  }));
  const stopLease = mock(async () => {
    expect(send).toHaveBeenCalledTimes(4);
  });
  const logs: string[] = [];
  await executeAndReportAgentWork({
    work: { id: "w", kind: "deploy_app" },
    prepare: async () => ({ kind: "complete", result: {} }),
    send,
    rejectResult,
    stopLease,
    redactError: () => "[REDACTED]",
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (message) => {
      logs.push(message);
    },
  });
  expect(delays).toEqual([1000, 2000, 4000]);
  expect(rejectResult).not.toHaveBeenCalled();
  expect(logs).toEqual(["[nouva-agent] work w (deploy_app) complete report failed: [REDACTED]"]);
});

test("a rejection after an ambiguous reply never tears down a possibly committed runtime", async () => {
  let attempts = 0;
  const rejectResult = mock(async () => ({
    kind: "fail" as const,
    result: null,
    errorMessage: "rejected",
  }));
  await executeAndReportAgentWork({
    work: { id: "w", kind: "deploy_app" },
    prepare: async () => ({ kind: "complete", result: {} }),
    send: async () => {
      throw apiError(++attempts === 1 ? 502 : 422);
    },
    rejectResult,
    stopLease: async () => {},
    redactError: () => "redacted",
    sleep: async () => {},
    log: () => {},
  });
  expect(attempts).toBe(2);
  expect(rejectResult).not.toHaveBeenCalled();
});

test("execution and failure-report errors always produce redacted ID/kind terminal lines and stop the lease", async () => {
  for (const prepareThrows of [false, true]) {
    const logs: string[] = [];
    const stopLease = mock(async () => {});
    await executeAndReportAgentWork({
      work: { id: "work_delete", kind: "delete_volume" },
      prepare: async () => {
        if (prepareThrows) throw new Error("secret");
        return { kind: "fail", result: null, errorMessage: "safe failure" };
      },
      send: async () => {
        throw apiError(502);
      },
      rejectResult: async () => {
        throw new Error("must not rollback");
      },
      stopLease,
      redactError: () => "[REDACTED]",
      sleep: async () => {},
      log: (message) => {
        logs.push(message);
      },
    });
    expect(logs.join(" ")).toContain("work_delete (delete_volume)");
    expect(logs.join(" ")).toContain("failed");
    expect(logs.join(" ")).not.toContain("secret");
    expect(stopLease).toHaveBeenCalledTimes(1);
  }
});

test("work the control plane took back is not reported, and its lease renewal stops", async () => {
  const send = mock(async () => {});
  const stopLease = mock(async () => {});
  const logs: string[] = [];
  await executeAndReportAgentWork({
    work: { id: "w", kind: "deploy_app" },
    prepare: async () => ({ kind: "released", reason: "Waiting on deployment dep_olde" }),
    send,
    rejectResult: async () => ({ kind: "fail", result: null, errorMessage: "rejected" }),
    stopLease,
    redactError: () => "[REDACTED]",
    log: (message) => {
      logs.push(message);
    },
  });
  expect(send).not.toHaveBeenCalled();
  expect(stopLease).toHaveBeenCalledTimes(1);
  expect(logs).toEqual([
    "[nouva-agent] work w (deploy_app) returned to the queue: Waiting on deployment dep_olde",
  ]);
});
