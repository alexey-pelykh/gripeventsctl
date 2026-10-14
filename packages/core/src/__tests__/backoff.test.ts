// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { MAX_RETRIES, RETRY_AFTER_CAP_S, SCHEDULE_S, backoffWaitS, parseRetryAfter } from "../transport/backoff.js";

describe("[CAP-THROTTLE] the schedule constants and the Retry-After forms (docs/api/interest.md § Throttling)", () => {
  it("has three steps, so three retries at most, and caps Retry-After at 300 s", () => {
    expect([...SCHEDULE_S]).toEqual([60, 120, 240]);
    expect(MAX_RETRIES).toBe(3);
    expect(RETRY_AFTER_CAP_S).toBe(300);
  });

  it("freezes the schedule, so no importer can change the 429 waits at run time", () => {
    // `readonly number[]` binds at compile time only, and every module that imports the schedule shares this one array.
    const before = [...SCHEDULE_S];
    expect(Array.isArray(SCHEDULE_S)).toBe(true);
    expect(Object.isFrozen(SCHEDULE_S)).toBe(true);
    // The cast reaches the run-time guard; ES modules run in strict mode, so each write throws.
    const writable = SCHEDULE_S as number[];
    expect(() => {
      writable[0] = 1;
    }).toThrow(TypeError);
    expect(() => writable.push(480)).toThrow(TypeError);
    expect(() => {
      writable.length = 0;
    }).toThrow(TypeError);
    expect([...SCHEDULE_S]).toEqual(before);
    expect(backoffWaitS(1)).toBe(60);
  });

  it("takes a delta-seconds Retry-After as the wait, capped at 300 s", () => {
    expect(backoffWaitS(1, "7")).toBe(7);
    expect(backoffWaitS(3, "7")).toBe(7);
    expect(backoffWaitS(1, "900")).toBe(300);
    expect(backoffWaitS(1, "300")).toBe(300);
    expect(backoffWaitS(2, " 42 ")).toBe(42);
  });

  it("caps every all-digit Retry-After above 300 s at 300 s, however many digits it has", () => {
    // 2^53 is the first integer past Number.MAX_SAFE_INTEGER; a value that long still asks for more than the cap.
    expect(backoffWaitS(1, "9007199254740992")).toBe(300);
    expect(backoffWaitS(2, "999999999999999999999999999999")).toBe(300);
    expect(backoffWaitS(3, "9".repeat(400))).toBe(300);
    expect(backoffWaitS(1, "9007199254740991")).toBe(300);
    expect(backoffWaitS(1, "0000300")).toBe(300);
    expect(backoffWaitS(2, "000")).toBe(120);
  });

  it("falls back to the attempt's schedule step for zero, a negative, an unparseable value, or a date at or before now", () => {
    const now = new Date("2026-10-21T07:28:00Z");
    expect(backoffWaitS(1, "Wed, 21 Oct 2026 07:28:00 GMT", now)).toBe(60);
    expect(backoffWaitS(1, "Wed, 21 Oct 2026 07:27:59 GMT", now)).toBe(60);
    expect(backoffWaitS(2, "0")).toBe(120);
    expect(backoffWaitS(3, "-5")).toBe(240);
    expect(backoffWaitS(1, "soon")).toBe(60);
    expect(backoffWaitS(1, "1.5")).toBe(60);
    expect(backoffWaitS(1, "")).toBe(60);
    expect(backoffWaitS(1, null)).toBe(60);
    expect(backoffWaitS(1)).toBe(60);
  });

  it("takes an HTTP-date Retry-After as the whole seconds until that date on the given clock, rounded up and capped at 300 s", () => {
    // RFC 9110 § 10.2.3 allows delta-seconds and an HTTP-date, and issue #5 § The backoff schedule takes both.
    const now = new Date("2026-10-12T12:00:00Z");
    expect(backoffWaitS(1, "Mon, 12 Oct 2026 12:00:07 GMT", now)).toBe(7);
    expect(backoffWaitS(3, "Mon, 12 Oct 2026 12:00:07 GMT", now)).toBe(7);
    expect(backoffWaitS(1, "Mon, 12 Oct 2026 12:15:00 GMT", now)).toBe(300);
    expect(backoffWaitS(1, "Mon, 12 Oct 2026 12:05:00 GMT", now)).toBe(300);
    // The obsolete RFC 850 form.
    expect(backoffWaitS(1, "Monday, 12-Oct-26 12:00:07 GMT", now)).toBe(7);
    // A fraction of a second rounds up, so the retry never leaves before the date.
    expect(parseRetryAfter("Mon, 12 Oct 2026 12:00:07 GMT", new Date("2026-10-12T12:00:00.500Z"))).toBe(7);
  });

  it("reads an HTTP-date only in the three RFC 9110 § 5.6.7 forms, each as UTC, and any other date text as no header", () => {
    const now = new Date("2026-10-21T07:28:00Z");
    // IMF-fixdate, the RFC 850 form, and the asctime form with a two-digit and a one-digit day.
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:07 GMT", now)).toBe(7);
    expect(parseRetryAfter("Wednesday, 21-Oct-26 07:28:07 GMT", now)).toBe(7);
    expect(parseRetryAfter("Wed Oct 21 07:28:07 2026", now)).toBe(7);
    expect(parseRetryAfter("Thu Oct  1 07:28:07 2026", new Date("2026-10-01T07:28:00Z"))).toBe(7);
    // A leap second is in the grammar (00:00:00 to 23:59:60).
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:60 GMT", new Date("2026-10-21T07:28:50Z"))).toBe(10);
    // The RFC 850 form's two-digit year: a date more than 50 years ahead is read in the most recent past year with
    // those two digits (RFC 9110 § 5.6.7). 2075 is 49 years ahead; 2077 would be 51, so `77` is 1977, in the past.
    const in2075 = (Date.UTC(2075, 9, 21, 7, 28, 7) - now.getTime()) / 1000;
    expect(parseRetryAfter("Monday, 21-Oct-75 07:28:07 GMT", now)).toBe(in2075);
    expect(backoffWaitS(1, "Monday, 21-Oct-75 07:28:07 GMT", now)).toBe(300);
    expect(parseRetryAfter("Thursday, 21-Oct-77 07:28:07 GMT", now)).toBeUndefined();
    // Date text that no HTTP-date grammar holds, most of which `Date.parse` reads: no header, so the schedule step
    // applies.
    const notHttpDates = [
      "2026-10-21T07:28:07Z",
      "2026-10-21 07:28:07",
      "October 21, 2026 07:28:07 GMT",
      "Wed, 21 Oct 2026 07:28:07 +0000",
      "Wed, 21 Oct 2026 07:28:07 UTC",
      "Wed, 21 Oct 2026 7:28:07 GMT",
      "wed, 21 oct 2026 07:28:07 gmt",
      "Wed,  21 Oct 2026 07:28:07 GMT",
      "Wed, 21 Oct 26 07:28:07 GMT",
      "Wed Oct 21 07:28:07 2026 GMT",
      // Inside the grammar, but no such day or time.
      "Wed, 31 Feb 2026 07:28:07 GMT",
      "Wed, 21 Oct 2026 24:28:07 GMT",
      "Wed, 00 Oct 2026 07:28:07 GMT",
    ];
    for (const value of notHttpDates) {
      expect(parseRetryAfter(value, now), value).toBeUndefined();
      expect(backoffWaitS(1, value, now), value).toBe(60);
    }
  });

  it("reads the asctime form as UTC whatever the process's time zone", () => {
    const saved = process.env.TZ;
    try {
      // Node reads a changed TZ at once; an asctime value names no zone, and RFC 9110 § 5.6.7 assumes UTC for it.
      for (const zone of ["Asia/Kolkata", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = zone;
        expect(parseRetryAfter("Wed Oct 21 07:28:07 2026", new Date("2026-10-21T07:28:00Z")), zone).toBe(7);
        expect(parseRetryAfter("Thu Oct  1 07:28:07 2026", new Date("2026-10-01T07:28:00Z")), zone).toBe(7);
      }
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = saved;
    }
  });

  it("ends after the third retry whatever the header says, and knows no attempt outside 1 to 3", () => {
    expect(backoffWaitS(4, null)).toBeUndefined();
    expect(backoffWaitS(4, "7")).toBeUndefined();
    expect(backoffWaitS(0, null)).toBeUndefined();
    expect(backoffWaitS(-1, null)).toBeUndefined();
    expect(backoffWaitS(1.5, null)).toBeUndefined();
  });

  it("parseRetryAfter reads delta-seconds and the HTTP-date form, and nothing else", () => {
    const now = new Date("2026-10-21T07:27:53Z");
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("0")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", now)).toBe(7);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:53 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:00:00 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
