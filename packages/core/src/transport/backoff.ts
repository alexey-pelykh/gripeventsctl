// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The HTTP 429 backoff schedule. On a 429 the client waits, then retries the same request
 * unchanged: same method, URL, headers and body. Three retries at most; after the third retry
 * answers 429 the `throttled` kind is raised. Nothing rotates between attempts.
 *
 * The one observation behind the numbers (`docs/api/interest.md` § Throttling (HTTP 429),
 * 2026-10-07): about 47 interest POSTs in under two minutes tripped the limit, and the same POST
 * went through 56 seconds later. A re-measurement at the next event changes this file only.
 */

/** A `Retry-After` header is honoured up to this many seconds. */
export const RETRY_AFTER_CAP_S = 300;

/** The waits, in seconds, before retry 1, 2 and 3 when the answer carries no `Retry-After`. */
export const SCHEDULE_S: readonly number[] = [60, 120, 240];

/** The number of retries after the first 429: the length of the schedule. */
export const MAX_RETRIES = SCHEDULE_S.length;

/**
 * The delta-seconds form of a `Retry-After` header, as a positive integer. An HTTP-date, zero, a
 * negative value and anything unparseable yield `undefined`, and the schedule step applies.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * The wait, in seconds, before retry number `attempt` (1-based): the `Retry-After` value capped at
 * `RETRY_AFTER_CAP_S` when the answer carries one in delta-seconds form, else the schedule step.
 * `undefined` once the schedule has ended, whatever the header says: the caller then raises
 * `throttled`.
 */
export function backoffWaitS(attempt: number, retryAfter?: string | null): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > SCHEDULE_S.length) return undefined;
  const step = SCHEDULE_S[attempt - 1];
  if (step === undefined) return undefined;
  const fromHeader = parseRetryAfter(retryAfter);
  return fromHeader === undefined ? step : Math.min(fromHeader, RETRY_AFTER_CAP_S);
}
