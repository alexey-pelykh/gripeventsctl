// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** The clock seam of `@gripeventsctl/core`, restated here because this package depends on no workspace package. */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

export interface FakeClock extends Clock {
  /** Move the clock to `time`; sleeps and timeouts due by then fire. */
  set(time: Date | string | number): void;
  /** Move the clock forward by `ms`; sleeps and timeouts due by then fire. */
  advance(ms: number): Promise<void>;
}

export const FAKE_CLOCK_START = "2026-10-12T12:00:00Z";

/**
 * A manual clock: `now()` is what the test set, `sleep()` resolves when the test advances past
 * its due time, `timeoutSignal()` aborts the same way. Nothing in it waits on real time.
 */
export function fakeClock(start: Date | string | number = FAKE_CLOCK_START): FakeClock {
  let current = new Date(start).getTime();
  const sleepers: { due: number; resolve: () => void }[] = [];
  const timeouts: { due: number; controller: AbortController }[] = [];

  function fire(): void {
    for (const sleeper of sleepers.filter((entry) => entry.due <= current)) {
      sleepers.splice(sleepers.indexOf(sleeper), 1);
      sleeper.resolve();
    }
    for (const timeout of timeouts.filter((entry) => entry.due <= current)) {
      timeouts.splice(timeouts.indexOf(timeout), 1);
      timeout.controller.abort(new Error(`fake clock: timed out after ${String(timeout.due - current)} ms`));
    }
  }

  return {
    now: () => new Date(current),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        if (ms <= 0) {
          resolve();
          return;
        }
        sleepers.push({ due: current + ms, resolve });
      }),
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      timeouts.push({ due: current + ms, controller });
      return controller.signal;
    },
    set(time) {
      current = new Date(time).getTime();
      fire();
    },
    async advance(ms) {
      current += ms;
      fire();
      // Let the continuations of the sleeps that fired run before the test goes on.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}
