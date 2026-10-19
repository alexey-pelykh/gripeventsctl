// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The clock seam. Everything in `@gripeventsctl/core` that reads the time, waits, or bounds a wait
 * takes a `Clock`, so a test runs on a manual clock without patching globals. `systemClock` is the
 * real one.
 */
export interface Clock {
  /** The current time. */
  now(): Date;
  /**
   * Resolves after `ms` milliseconds. Where `signal` is given and aborts first, rejects with the signal's reason at
   * once and holds no timer (issue #11: a cancelled call ends its 429 wait and its page pause early).
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** A signal that aborts after `ms` milliseconds. */
  timeoutSignal(ms: number): AbortSignal;
}

/**
 * The error a cancelled wait rejects with: the signal's own reason where it is an `Error` (the `AbortError` of a bare
 * `abort()` is one), else an `Error` carrying the reason as its `cause`, so a rejection is always an `Error`.
 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("the call was cancelled", { cause: reason });
}

/** Throw `abortError(signal)` where `signal` is given and aborted; the check before a wait or a send. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

/**
 * Frozen, because a method declared on an interface is writable at compile time and the package entry hands this
 * object to every importer: `GripClient` falls back to it when no clock is injected, and runs every 429 wait, every
 * pause between pages and the spacing of profile reads on its `sleep`, and bounds every request on its
 * `timeoutSignal`. No importer can replace either at run time.
 */
export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal === undefined) {
        setTimeout(resolve, ms);
        return;
      }
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  timeoutSignal: (ms: number) => AbortSignal.timeout(ms),
});

/** `date` as an ISO 8601 UTC string at second precision, `YYYY-MM-DDTHH:MM:SSZ`: the form the config file holds. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
