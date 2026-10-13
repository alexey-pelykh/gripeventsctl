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

  it("takes a delta-seconds Retry-After as the wait, capped at 300 s", () => {
    expect(backoffWaitS(1, "7")).toBe(7);
    expect(backoffWaitS(3, "7")).toBe(7);
    expect(backoffWaitS(1, "900")).toBe(300);
    expect(backoffWaitS(1, "300")).toBe(300);
    expect(backoffWaitS(2, " 42 ")).toBe(42);
  });

  it("falls back to the attempt's schedule step for an HTTP-date, zero, a negative or an unparseable value", () => {
    expect(backoffWaitS(1, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(60);
    expect(backoffWaitS(2, "0")).toBe(120);
    expect(backoffWaitS(3, "-5")).toBe(240);
    expect(backoffWaitS(1, "soon")).toBe(60);
    expect(backoffWaitS(1, "1.5")).toBe(60);
    expect(backoffWaitS(1, "")).toBe(60);
    expect(backoffWaitS(1, null)).toBe(60);
    expect(backoffWaitS(1)).toBe(60);
  });

  it("ends after the third retry whatever the header says, and knows no attempt outside 1 to 3", () => {
    expect(backoffWaitS(4, null)).toBeUndefined();
    expect(backoffWaitS(4, "7")).toBeUndefined();
    expect(backoffWaitS(0, null)).toBeUndefined();
    expect(backoffWaitS(-1, null)).toBeUndefined();
    expect(backoffWaitS(1.5, null)).toBeUndefined();
  });

  it("parseRetryAfter reads delta-seconds only", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("0")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
