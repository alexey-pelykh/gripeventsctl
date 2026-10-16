// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `runCli()` over the built CLI, and `captureProcessOutput()`, the capture both harnesses wrap a
 * call in: a line written past the injected streams comes back to the test and never reaches the
 * runner's own streams.
 */

import { describe, expect, it } from "vitest";

import { captureProcessOutput } from "../capture-output.js";
import { runCli } from "../cli-harness.js";
import { fakeClock } from "../fake-clock.js";
import { mockGrip } from "../mock-grip.js";
import { fakeTerminal } from "../terminal.js";

/** Records what reaches the real `process.stdout` and `process.stderr` while `fn` runs. */
async function leaked(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const out = { stdout: "", stderr: "" };
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: Uint8Array | string) => {
    out.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: Uint8Array | string) => {
    out.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return out;
}

describe("[CAP-TEST-TOOLING] captureProcessOutput()", () => {
  it("returns a console.error line and a process.stdout.write line, and nothing reaches the outer streams", async () => {
    let captured: Awaited<ReturnType<typeof captureProcessOutput<number>>> | undefined;
    const outer = await leaked(async () => {
      captured = await captureProcessOutput(() => {
        console.error("an error line");
        process.stdout.write("a stdout line\n");
        console.log("a log line");
        process.stderr.write("a stderr line\n");
        return Promise.resolve(7);
      });
    });
    expect(captured?.result).toBe(7);
    expect(captured?.stdout).toBe("a stdout line\na log line\n");
    expect(captured?.stderr).toBe("an error line\na stderr line\n");
    expect(outer).toEqual({ stdout: "", stderr: "" });
  });

  it("restores the streams and the console after the call, including when it rejects", async () => {
    const write = process.stdout.write;
    const error = console.error;
    await expect(
      captureProcessOutput(() => {
        process.stdout.write("lost\n");
        return Promise.reject(new Error("boom"));
      }),
    ).rejects.toThrow("boom");
    expect(process.stdout.write).toBe(write);
    expect(console.error).toBe(error);
  });
});

describe("[CAP-TEST-TOOLING] runCli()", () => {
  const agent = mockGrip();

  it("runs the built CLI with captured streams: --version prints the version and nothing reaches the runner's streams", async () => {
    let result: Awaited<ReturnType<typeof runCli>> | undefined;
    const outer = await leaked(async () => {
      result = await runCli(["--version"], {
        terminal: fakeTerminal().terminal,
        dispatcher: agent,
        clock: fakeClock(),
        env: {},
      });
    });
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toMatch(/^\d+\.\d+\.\d+/u);
    expect(result?.stderr).toBe("");
    expect(outer).toEqual({ stdout: "", stderr: "" });
  });
});
