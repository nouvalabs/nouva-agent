import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "./agent-work-reporting.js";
import {
  isAgentUpdateAlreadyApplied,
  recordAgentUpdateCompletionAttempt,
  resolveUpdateAgentImageRef,
  shouldStartAgentUpdater,
  startAgentUpdaterAfterDrain,
  toUpdateAgentPayload,
} from "./update-agent.js";

describe("update agent payload compatibility", () => {
  test("accepts the legacy imageTag payload", () => {
    const payload = toUpdateAgentPayload({
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });

    expect(payload).toEqual({
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });
    expect(resolveUpdateAgentImageRef(payload)).toBe("ghcr.io/nouvalabs/nouva-agent:v0.2.0");
  });

  test("prefers imageRef for digest-pinned rollout payloads", () => {
    const payload = toUpdateAgentPayload({
      releaseId: "rel_123",
      version: "v0.2.0",
      imageRef: "ghcr.io/nouvalabs/nouva-agent@sha256:deadbeef",
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });

    expect(payload).toEqual({
      releaseId: "rel_123",
      version: "v0.2.0",
      imageRef: "ghcr.io/nouvalabs/nouva-agent@sha256:deadbeef",
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });
    expect(resolveUpdateAgentImageRef(payload)).toBe(
      "ghcr.io/nouvalabs/nouva-agent@sha256:deadbeef"
    );
  });

  test("rejects missing image references", () => {
    expect(() => toUpdateAgentPayload({ releaseId: "rel_123" })).toThrow(
      "Agent update payload is missing imageRef/imageTag"
    );
  });
});

describe("re-leased agent updates", () => {
  const target = {
    version: "v0.4.41",
    imageRef: "ghcr.io/nouvalabs/nouva-agent@sha256:beef",
  };

  test("is already applied when the running agent has the target image and version", () => {
    expect(
      isAgentUpdateAlreadyApplied({ image: target.imageRef, version: "v0.4.41" }, target)
    ).toBe(true);
    expect(
      isAgentUpdateAlreadyApplied(
        { image: target.imageRef, version: "v0.4.41" },
        { ...target, version: "0.4.41" }
      )
    ).toBe(true);
  });

  test("still updates when either the image or the version differs", () => {
    expect(
      isAgentUpdateAlreadyApplied(
        { image: "ghcr.io/nouvalabs/nouva-agent@sha256:old", version: "v0.4.41" },
        target
      )
    ).toBe(false);
    expect(
      isAgentUpdateAlreadyApplied({ image: target.imageRef, version: "v0.4.40" }, target)
    ).toBe(false);
  });

  test("still updates a payload without a version, since a mutable tag proves nothing", () => {
    expect(
      isAgentUpdateAlreadyApplied(
        { image: "ghcr.io/nouvalabs/nouva-agent:latest", version: "v0.4.40" },
        { imageTag: "ghcr.io/nouvalabs/nouva-agent:latest" }
      )
    ).toBe(false);
  });
});

describe("agent update completion delivery", () => {
  const apiError = (status: number) =>
    new ApiRequestError({ method: "POST", pathName: "/complete", status, message: "x" });

  test("starts the updater once the completion is delivered", () => {
    const delivery = recordAgentUpdateCompletionAttempt("pending", null);
    expect(shouldStartAgentUpdater(delivery)).toBe(true);
  });

  test("does not start the updater before anything was reported", () => {
    expect(shouldStartAgentUpdater("pending")).toBe(false);
  });

  test("does not start the updater when the control plane refuses the completion", () => {
    const delivery = recordAgentUpdateCompletionAttempt("pending", apiError(409));
    expect(delivery).toBe("rejected");
    expect(shouldStartAgentUpdater(delivery)).toBe(false);
  });

  test("starts the updater when the completion may have been committed", () => {
    const afterTimeout = recordAgentUpdateCompletionAttempt("pending", new Error("timeout"));
    expect(shouldStartAgentUpdater(afterTimeout)).toBe(true);
    // A retry answered 409 may be conflicting with the first, already committed, attempt.
    const afterRetry = recordAgentUpdateCompletionAttempt(afterTimeout, apiError(409));
    expect(afterRetry).toBe("unconfirmed");
    expect(shouldStartAgentUpdater(afterRetry)).toBe(true);
    expect(recordAgentUpdateCompletionAttempt("pending", apiError(503))).toBe("unconfirmed");
  });
});

describe("startAgentUpdaterAfterDrain", () => {
  function createClock() {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }

  test("waits for in-flight work to finish before starting the updater", async () => {
    const clock = createClock();
    const events: string[] = [];
    let remainingPolls = 3;

    await startAgentUpdaterAfterDrain({
      isWorkActive: () => {
        events.push("check");
        return remainingPolls-- > 0;
      },
      startUpdater: async () => {
        events.push("start");
      },
      drainTimeoutMs: 60_000,
      pollIntervalMs: 1000,
      ...clock,
      log: () => {},
    });

    expect(events).toEqual(["check", "check", "check", "check", "start"]);
    expect(clock.now()).toBe(3000);
  });

  test("starts the updater at the drain deadline when work never finishes", async () => {
    const clock = createClock();
    const logs: string[] = [];
    let started = false;

    await startAgentUpdaterAfterDrain({
      isWorkActive: () => true,
      startUpdater: async () => {
        started = true;
      },
      drainTimeoutMs: 5000,
      pollIntervalMs: 1000,
      ...clock,
      log: (message) => logs.push(message),
    });

    expect(started).toBe(true);
    expect(clock.now()).toBe(5000);
    expect(logs).toHaveLength(1);
  });

  test("propagates a failure to start the updater", async () => {
    const clock = createClock();
    await expect(
      startAgentUpdaterAfterDrain({
        isWorkActive: () => false,
        startUpdater: async () => {
          throw new Error("docker unavailable");
        },
        drainTimeoutMs: 5000,
        pollIntervalMs: 1000,
        ...clock,
        log: () => {},
      })
    ).rejects.toThrow("docker unavailable");
  });
});
