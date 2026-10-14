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
  /** Resolves after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /** A signal that aborts after `ms` milliseconds. */
  timeoutSignal(ms: number): AbortSignal;
}

/**
 * Frozen, because a method declared on an interface is writable at compile time and the package entry hands this
 * object to every importer: `GripClient` falls back to it when no clock is injected, and runs every 429 wait, every
 * pause between pages and the spacing of profile reads on its `sleep`, and bounds every request on its
 * `timeoutSignal`. No importer can replace either at run time.
 */
export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  timeoutSignal: (ms: number) => AbortSignal.timeout(ms),
});

/** `date` as an ISO 8601 UTC string at second precision, `YYYY-MM-DDTHH:MM:SSZ`: the form the config file holds. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
