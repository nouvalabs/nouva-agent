import { describe, expect, test } from "bun:test";
import { createRearmableInterval, type IntervalTimers } from "./rearmable-interval.js";

/** Fake clock: `advance` fires every due interval tick in order. */
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { callback: () => void; periodMs: number; nextAt: number }>();
  const timers: IntervalTimers = {
    setInterval: (callback, periodMs) => {
      const id = nextId++;
      intervals.set(id, { callback, periodMs, nextAt: now + periodMs });
      return id;
    },
    clearInterval: (timer) => {
      intervals.delete(timer as number);
    },
  };
  return {
    timers,
    activeCount: () => intervals.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...intervals.values()]
          .filter((interval) => interval.nextAt <= end)
          .sort((a, b) => a.nextAt - b.nextAt)[0];
        if (!due) break;
        now = due.nextAt;
        due.nextAt += due.periodMs;
        due.callback();
      }
      now = end;
    },
  };
}

describe("createRearmableInterval", () => {
  test("ticks at the configured period", () => {
    const clock = createFakeTimers();
    let ticks = 0;
    const loop = createRearmableInterval(() => ticks++, clock.timers);

    loop.update(10_000);
    clock.advance(30_000);

    expect(ticks).toBe(3);
  });

  test("picks up a changed period from later config", () => {
    const clock = createFakeTimers();
    let ticks = 0;
    const loop = createRearmableInterval(() => ticks++, clock.timers);

    loop.update(10_000);
    clock.advance(10_000);
    loop.update(2_000);
    clock.advance(10_000);

    expect(ticks).toBe(1 + 5);
    expect(loop.periodMs()).toBe(2_000);
    expect(clock.activeCount()).toBe(1);
  });

  test("keeps the running timer when the period is unchanged", () => {
    const clock = createFakeTimers();
    let ticks = 0;
    const loop = createRearmableInterval(() => ticks++, clock.timers);

    loop.update(10_000);
    clock.advance(9_000);
    // A heartbeat repeating the same config must not push the next tick back.
    loop.update(10_000);
    clock.advance(1_000);

    expect(ticks).toBe(1);
  });

  test("ignores a malformed period instead of stopping the loop", () => {
    const clock = createFakeTimers();
    let ticks = 0;
    const loop = createRearmableInterval(() => ticks++, clock.timers);

    loop.update(5_000);
    loop.update(Number.NaN);
    loop.update(0);
    loop.update(-1);
    clock.advance(10_000);

    expect(ticks).toBe(2);
    expect(loop.periodMs()).toBe(5_000);
  });

  test("stops until the next update", () => {
    const clock = createFakeTimers();
    let ticks = 0;
    const loop = createRearmableInterval(() => ticks++, clock.timers);

    loop.update(5_000);
    loop.stop();
    clock.advance(20_000);
    expect(ticks).toBe(0);
    expect(clock.activeCount()).toBe(0);

    loop.update(5_000);
    clock.advance(5_000);
    expect(ticks).toBe(1);
  });
});
