import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  countRecentRestarts,
  hasOutlastedRestartLoop,
  readRestartCount,
} from "./container-restarts.js";

const NOW = 1_790_725_500_000;
const MINUTE_MS = 60_000;

/** Docker's event log, with the container's exits `msAgo` before `NOW`. */
function eventLog(exits: number[] | Error) {
  return {
    countContainerExits: mock(async (containerId: string, sinceMs: number, untilMs: number) => {
      if (exits instanceof Error) throw exits;
      return containerId === "ctr_1"
        ? exits.filter((msAgo) => NOW - msAgo >= sinceMs && NOW - msAgo <= untilMs).length
        : 0;
    }),
  };
}

const inspection = (RestartCount: number) => ({ Id: "ctr_1", RestartCount });

describe("countRecentRestarts", () => {
  test.each([
    ["exits of the last five minutes", 6, [15_000, 35_000, 4 * MINUTE_MS + 50_000], 3],
    ["no exit older than five minutes", 6, [15_000, 5 * MINUTE_MS + 10_000], 1],
    // A stop by hand logs an exit too, but the start by hand after it clears the restart count.
    ["no more exits than restarts since the last start by hand", 1, [15_000, 45_000], 1],
  ])("counts %s", async (_, restartCount, exits, expected) => {
    await expect(
      countRecentRestarts(eventLog(exits), "nouva-worker-1", inspection(restartCount), NOW)
    ).resolves.toBe(expected);
  });

  test("does not read the event log of a container that never restarted", async () => {
    const docker = eventLog([15_000]);

    await expect(countRecentRestarts(docker, "nouva-worker-1", inspection(0), NOW)).resolves.toBe(
      0
    );
    expect(docker.countContainerExits).not.toHaveBeenCalled();
  });

  test("counts none when the event log cannot be read", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      countRecentRestarts(
        eventLog(new Error("Docker API timed out")),
        "nouva-worker-1",
        inspection(6),
        NOW
      )
    ).resolves.toBe(0);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[nouva-agent] could not read recent exits of container nouva-worker-1",
      "Docker API timed out"
    );
    consoleWarn.mockRestore();
  });
});

describe("hasOutlastedRestartLoop", () => {
  /** Up and running, its current run started `msAgo` before `NOW`. */
  const upFor = (msAgo: number) => ({
    Running: true,
    Status: "running",
    // Docker reports the start to the nanosecond.
    StartedAt: new Date(NOW - msAgo).toISOString().replace("Z", "123456Z"),
  });

  // Three restarts in five minutes, steadily, leave a process up for 100 seconds at most, and two
  // leave it up for 150.
  test.each([
    ["as long as a loop of three allows", 3, 100_000, true],
    ["less than a loop of three allows", 3, 99_000, false],
    ["as long as a loop of two allows", 2, 150_000, true],
    ["less than a loop of two allows", 2, 149_000, false],
  ])("judges a container up for %s", (_, loopThreshold, upForMs, expected) => {
    expect(
      hasOutlastedRestartLoop({ Id: "ctr_1", State: upFor(upForMs) }, NOW, loopThreshold)
    ).toBe(expected);
  });

  test("does not take the start a container waiting out its restart back-off reports", () => {
    // It is the start of the run that just ended, however long that run was.
    const state = { ...upFor(200_000), Status: "restarting" };

    expect(hasOutlastedRestartLoop({ Id: "ctr_1", State: state }, NOW, 3)).toBe(false);
  });

  test("finds no recovery in a start Docker does not report", () => {
    const state = { Running: true, Status: "running" };

    expect(hasOutlastedRestartLoop({ Id: "ctr_1", State: state }, NOW, 3)).toBe(false);
    expect(
      hasOutlastedRestartLoop({ Id: "ctr_1", State: { ...state, StartedAt: "" } }, NOW, 3)
    ).toBe(false);
  });
});

test("readRestartCount reads a missing or malformed restart count as none", () => {
  expect(readRestartCount({ Id: "ctr_1", RestartCount: 4 })).toBe(4);
  expect(readRestartCount({ Id: "ctr_1" })).toBe(0);
  expect(readRestartCount({ Id: "ctr_1", RestartCount: Number.NaN })).toBe(0);
  expect(readRestartCount(null)).toBe(0);
});
