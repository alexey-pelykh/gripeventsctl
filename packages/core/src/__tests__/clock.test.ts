// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { systemClock } from "../lib/clock.js";

describe("[CAP-CLIENT] the system clock (lib/clock.ts)", () => {
  it("is frozen, so no importer can replace its sleep, its timeoutSignal or its now at run time", () => {
    // `GripClient` falls back to it when no clock is injected: every 429 wait, every pause between pages and the
    // spacing of profile reads run on its `sleep`, and every request is bounded by its `timeoutSignal`. The package
    // entry hands it to every importer, and a method declared on an interface is writable at compile time.
    const before = { now: systemClock.now, sleep: systemClock.sleep, timeoutSignal: systemClock.timeoutSignal };
    expect(Object.isFrozen(systemClock)).toBe(true);
    // ES modules run in strict mode, so each write to a frozen object throws.
    expect(() => {
      systemClock.sleep = () => Promise.resolve();
    }).toThrow(TypeError);
    expect(() => {
      systemClock.timeoutSignal = () => new AbortController().signal;
    }).toThrow(TypeError);
    expect(() => {
      systemClock.now = () => new Date(0);
    }).toThrow(TypeError);
    expect(() => {
      (systemClock as Record<string, unknown>)["extra"] = 1;
    }).toThrow(TypeError);
    expect(systemClock.now).toBe(before.now);
    expect(systemClock.sleep).toBe(before.sleep);
    expect(systemClock.timeoutSignal).toBe(before.timeoutSignal);
  });

  it("reads the real time, sleeps on a timer and bounds a wait with a signal that fires", async () => {
    const started = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(started);
    await systemClock.sleep(1);
    const signal = systemClock.timeoutSignal(1);
    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(signal.aborted).toBe(true);
  });
});
