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

/**
 * The waits, in seconds, before retry 1, 2 and 3 when the answer carries no `Retry-After`. Frozen, because
 * `readonly` binds at compile time only and every module that imports the schedule shares this one array: no importer
 * can change the 429 waits at run time.
 */
export const SCHEDULE_S: readonly number[] = Object.freeze([60, 120, 240]);

/** The number of retries after the first 429: the length of the schedule. */
export const MAX_RETRIES = SCHEDULE_S.length;

// The three HTTP-date forms of RFC 9110 § 5.6.7, which is case sensitive and allows no whitespace beyond its SP.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_NAME = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const DAY_NAME_LONG = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH = `(${MONTHS.join("|")})`;
const TIME_OF_DAY = String.raw`(\d{2}):(\d{2}):(\d{2})`;
/** `Sun, 06 Nov 1994 08:49:37 GMT`. Groups: day, month, year, hour, minute, second. */
const IMF_FIXDATE = new RegExp(String.raw`^${DAY_NAME}, (\d{2}) ${MONTH} (\d{4}) ${TIME_OF_DAY} GMT$`);
/** `Sunday, 06-Nov-94 08:49:37 GMT`. Groups: day, month, two-digit year, hour, minute, second. */
const RFC850_DATE = new RegExp(String.raw`^${DAY_NAME_LONG}, (\d{2})-${MONTH}-(\d{2}) ${TIME_OF_DAY} GMT$`);
/** `Sun Nov  6 08:49:37 1994`. Groups: month, day (two digits, or a space and one digit), hour, minute, second, year. */
const ASCTIME_DATE = new RegExp(String.raw`^${DAY_NAME} ${MONTH} (\d{2}| \d) ${TIME_OF_DAY} (\d{4})$`);

/** A date and time of day as an HTTP-date spells it, every field as matched; the month as its three letters. */
interface DateText {
  day: string | undefined;
  month: string | undefined;
  hour: string | undefined;
  minute: string | undefined;
  second: string | undefined;
}

/**
 * The time `text` names in `year`, in UTC milliseconds, or `undefined` where no such day or time exists. The time of
 * day runs from 00:00:00 to 23:59:60, a leap second included (RFC 9110 § 5.6.7).
 */
function utcTime(text: DateText, year: number): number | undefined {
  const month = MONTHS.findIndex((name) => name === text.month);
  // The asctime form's one-digit day keeps its leading space, which `Number` skips.
  const numbers = [text.day, text.hour, text.minute, text.second].map(Number);
  const [day = NaN, hour = NaN, minute = NaN, second = NaN] = numbers;
  if (month === -1 || !numbers.every((value) => Number.isInteger(value))) return undefined;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 60) return undefined;
  return Date.UTC(year, month, day, hour, minute, second);
}

/**
 * The time an RFC 850 date names, in the latest year that ends in its two digits and puts the date no more than 50
 * years after `now`: a date that would appear more than 50 years ahead is read in the most recent past year with the
 * same two digits (RFC 9110 § 5.6.7).
 */
function rfc850Time(text: DateText, twoDigits: number, now: Date): number | undefined {
  const limit = new Date(now.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 50);
  const century = now.getUTCFullYear() - (now.getUTCFullYear() % 100);
  for (const year of [century + 100 + twoDigits, century + twoDigits, century - 100 + twoDigits]) {
    // A day that exists in one century and not in another (29 February) leaves that century out.
    const time = utcTime(text, year);
    if (time !== undefined && time <= limit.getTime()) return time;
  }
  return undefined;
}

/**
 * The time an HTTP-date names, in UTC milliseconds: one of the three forms RFC 9110 § 5.6.7 defines, every one in
 * UTC, the asctime form included, which names no zone. Any other text, `Date.parse` forms such as ISO 8601 included,
 * and a day or a time that does not exist give `undefined`.
 */
function httpDateTime(value: string, now: Date): number | undefined {
  const imf = IMF_FIXDATE.exec(value);
  if (imf !== null) {
    const [, day, month, year, hour, minute, second] = imf;
    return utcTime({ day, month, hour, minute, second }, Number(year));
  }
  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850 !== null) {
    const [, day, month, twoDigits, hour, minute, second] = rfc850;
    return rfc850Time({ day, month, hour, minute, second }, Number(twoDigits), now);
  }
  const asctime = ASCTIME_DATE.exec(value);
  if (asctime !== null) {
    const [, month, day, hour, minute, second, year] = asctime;
    return utcTime({ day, month, hour, minute, second }, Number(year));
  }
  return undefined;
}

/**
 * The seconds a `Retry-After` header asks for, in either form RFC 9110 § 10.2.3 allows: delta-seconds
 * (a positive integer), or an HTTP-date read as the whole seconds from `now` until the date, rounded
 * up so the retry never leaves before it. A delta-seconds value too long for an exact number reads as
 * `Number.MAX_SAFE_INTEGER`, so the cap applies to it like to any other value above the cap. Zero, a
 * negative value, a date at or before `now` and anything unparseable yield `undefined`, and the
 * schedule step applies. An HTTP-date is one of the three forms of RFC 9110 § 5.6.7, each read as UTC: the
 * IMF-fixdate (`Wed, 21 Oct 2026 07:28:00 GMT`), the obsolete RFC 850 form, and the asctime form; any other date
 * text is unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (seconds === 0) return undefined;
    return Number.isSafeInteger(seconds) ? seconds : Number.MAX_SAFE_INTEGER;
  }
  const date = httpDateTime(trimmed, now);
  if (date === undefined) return undefined;
  const seconds = Math.ceil((date - now.getTime()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/**
 * The wait, in seconds, before retry number `attempt` (1-based): the `Retry-After` value capped at
 * `RETRY_AFTER_CAP_S` when the answer carries one, a date measured from `now` (the client passes its
 * clock's time), else the schedule step. `undefined` once the schedule has ended, whatever the header
 * says: the caller then raises `throttled`.
 */
export function backoffWaitS(attempt: number, retryAfter?: string | null, now?: Date): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > SCHEDULE_S.length) return undefined;
  const step = SCHEDULE_S[attempt - 1];
  if (step === undefined) return undefined;
  const fromHeader = parseRetryAfter(retryAfter, now);
  return fromHeader === undefined ? step : Math.min(fromHeader, RETRY_AFTER_CAP_S);
}
