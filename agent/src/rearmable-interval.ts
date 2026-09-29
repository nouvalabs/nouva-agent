export interface IntervalTimers {
  setInterval: (callback: () => void, periodMs: number) => unknown;
  clearInterval: (timer: unknown) => void;
}

export interface RearmableInterval {
  /**
   * Runs the tick every `periodMs` from now on. The same period leaves the running timer alone so
   * a heartbeat repeating the config does not reset its phase. A period that is not a positive
   * finite number is ignored and the current one kept: a malformed config must not stop the loop.
   */
  update: (periodMs: number) => void;
  /** Stops ticking until the next `update`. */
  stop: () => void;
  periodMs: () => number | null;
}

const systemTimers: IntervalTimers = {
  setInterval: (callback, periodMs) => setInterval(callback, periodMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

/** A fixed-rate loop whose period follows runtime config the control plane can change. */
export function createRearmableInterval(
  tick: () => void,
  timers: IntervalTimers = systemTimers
): RearmableInterval {
  let timer: unknown = null;
  let currentPeriodMs: number | null = null;

  const stop = () => {
    if (currentPeriodMs !== null) {
      timers.clearInterval(timer);
    }
    timer = null;
    currentPeriodMs = null;
  };

  return {
    update(periodMs) {
      if (!Number.isFinite(periodMs) || periodMs <= 0 || periodMs === currentPeriodMs) {
        return;
      }
      stop();
      timer = timers.setInterval(tick, periodMs);
      currentPeriodMs = periodMs;
    },
    stop,
    periodMs: () => currentPeriodMs,
  };
}
