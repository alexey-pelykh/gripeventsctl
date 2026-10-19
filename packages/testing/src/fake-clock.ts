// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** The error a cancelled sleep rejects with: the signal's reason where it is an `Error`, else an `Error` carrying it. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("the call was cancelled", { cause: reason });
}

/** The clock seam of `@gripeventsctl/core`, restated here because this package depends on no workspace package. */
export interface Clock {
  now(): Date;
  /** Resolves after `ms`; where `signal` aborts first, rejects with its reason at once and holds no sleeper. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
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
 * its due time (or rejects at once with the reason of the signal it was given, when that aborts first),
 * `timeoutSignal()` aborts the same way. Nothing in it waits on real time.
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
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (ms <= 0) {
          resolve();
          return;
        }
        if (signal === undefined) {
          sleepers.push({ due: current + ms, resolve });
          return;
        }
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        const onAbort = (): void => {
          const index = sleepers.indexOf(sleeper);
          if (index !== -1) sleepers.splice(index, 1);
          reject(abortError(signal));
        };
        const sleeper = {
          due: current + ms,
          resolve: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        signal.addEventListener("abort", onAbort, { once: true });
        sleepers.push(sleeper);
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
