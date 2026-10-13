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

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};

/** `date` as an ISO 8601 UTC string at second precision, `YYYY-MM-DDTHH:MM:SSZ`: the form the config file holds. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
