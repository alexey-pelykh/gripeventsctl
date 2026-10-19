// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The operation context of the three gated writes' operation-level tests (issue #17): a real `GripClient` over the
 * mock agent, the config loaded from a temporary home seeded with a synthetic session (`container_id` 1), the write
 * gate of `createWriteGate()` on an advancing fake clock with the CLI's terminal confirmation stubbed to confirm,
 * and the stderr sink. Test code only, beside `synthetic-write.ts`; every `tsconfig.build.json` keeps `__tests__`
 * out of `dist`.
 */

import { writeFile } from "node:fs/promises";
import { Writable } from "node:stream";

import { type TempHome, fixtureSecrets } from "@gripeventsctl/testing";
import type { MockAgent } from "undici";

import { type TerminalConfirmation, createWriteGate } from "../../gate/gate.js";
import type { Clock } from "../../lib/clock.js";
import { type DerivedPaths, derivedPaths } from "../../config/paths.js";
import { loadConfig } from "../../config/store.js";
import type { OperationContext } from "../../operations/operation.js";
import { GripClient } from "../../transport/client.js";

/** The fake clock's start: 2026-10-12T12:00:00Z. */
export const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

export class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

/** A clock whose waits end at once, advancing it and recording each wait: the 429 schedule runs without real time. */
export function advancingClock(start = T0): Clock & { sleeps: number[] } {
  let current = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(current),
    sleep: (ms) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

/** The CLI's terminal confirmation, confirming every write; `prompts` counts the asks. */
export function confirming(
  prompts: { count: number } = { count: 0 },
): TerminalConfirmation & { prompts: { count: number } } {
  return {
    prompts,
    interactive: true,
    run: () => {
      prompts.count += 1;
      return Promise.resolve(true);
    },
  };
}

/** Seed the home's config with a synthetic session in container 1 and the writes switch as given. */
export async function seedWriteConfig(home: TempHome, writesEnabled: boolean): Promise<void> {
  await writeFile(
    home.configFile,
    [
      "version: 1",
      "session:",
      "  slug: test-event-1",
      "  container_id: 1",
      `  token: ${fixtureSecrets().sessionToken}`,
      '  signed_in_at: "2026-10-12T10:00:00.000Z"',
      "writes:",
      `  enabled: ${String(writesEnabled)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

export interface WriteContext {
  ctx: OperationContext;
  paths: DerivedPaths;
  clock: Clock & { sleeps: number[] };
  stderr: () => string;
}

export interface WriteContextOptions {
  source?: "cli" | "mcp";
  /** The terminal confirmation; absent means no TTY (the CLI off a terminal, or MCP). */
  confirm?: TerminalConfirmation;
  clock?: Clock & { sleeps: number[] };
}

/** The context over the home's config as it stands now, with the gate the surfaces build. */
export async function writeContextIn(
  home: TempHome,
  agent: MockAgent,
  options: WriteContextOptions = {},
): Promise<WriteContext> {
  const loaded = await loadConfig({ env: home.env });
  const clock = options.clock ?? advancingClock();
  const sink = new Sink();
  const source = options.source ?? "cli";
  const paths = derivedPaths(loaded.path, loaded.config);
  const ctx: OperationContext = {
    client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr: sink }),
    config: loaded,
    clock,
    stderr: sink,
    source,
    gate: createWriteGate({
      config: loaded,
      paths,
      clock,
      source,
      stderr: sink,
      ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    }),
  };
  return { ctx, paths, clock, stderr: () => sink.text };
}

/** The request body of a recorded call as text. */
export function bodyText(call: { body: unknown }): string {
  const body: unknown = call.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body);
}

/** The headers of a recorded call, names lowercased. */
export function lowerHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || headers === undefined) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    return out;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

/** The last line of a human rendering. */
export function lastLine(text: string): string {
  return text.trimEnd().split("\n").at(-1) ?? "";
}
