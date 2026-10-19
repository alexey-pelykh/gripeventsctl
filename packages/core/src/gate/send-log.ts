// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The send log (issue #16 § The send log): the append-only record of every write attempt, one JSON object per line,
 * UTF-8, `\n`-terminated, at `derivedPaths().sendLog`. The module exposes `appendSendLog` and `readSendLog` and
 * nothing that truncates, rewrites or deletes. `readSendLog` tolerates a line it cannot parse, a trailing partial line
 * after a crash mid-append for one: the line is skipped with one stderr warning naming the file, so a crash never
 * blocks later writes. `repeatGuard` is the filter the gate runs over the entries: the newest entry of the same
 * `container_id`, `target_thing_id` and `kind` with `outcome: "sent"` and `dry_run: false`, or `null`. An entry of
 * another kind, another container, a dry run, or an outcome other than `sent` never blocks.
 */

import { readFile } from "node:fs/promises";

import { z } from "zod";

import { type AppendFs, type AppendHandle, appendText, openAppendOnly } from "./files.js";

/** The eight refusals a line may carry (issue #16 § The send log, the `refusal` field). */
export const REFUSALS = [
  "safe-mode",
  "repeat-guard",
  "go-ahead-missing",
  "go-ahead-expired",
  "message-too-long",
  "message-characters",
  "status-not-none",
  "write-busy",
] as const;

export type Refusal = (typeof REFUSALS)[number];

export const OUTCOMES = ["sent", "refused", "failed", "dry-run"] as const;

export type Outcome = (typeof OUTCOMES)[number];

/** One send log line, in field order. */
export const sendLogEntrySchema = z.object({
  time: z.string(),
  kind: z.string(),
  source: z.enum(["cli", "mcp"]),
  container_id: z.number().int(),
  target_thing_id: z.number().int(),
  status_before: z.string().nullable(),
  message: z.string().nullable(),
  message_sha256: z.string().nullable(),
  go_ahead: z.string().nullable(),
  dry_run: z.boolean(),
  outcome: z.enum(OUTCOMES),
  refusal: z.enum(REFUSALS).nullable(),
  http_status: z.number().int().nullable(),
  response: z.string().nullable(),
  connection: z.number().int().nullable(),
  message_id: z.number().int().nullable(),
});

export type SendLogEntry = z.infer<typeof sendLogEntrySchema>;

/** The three fields the repeat guard keys on. */
export interface RepeatGuardKey {
  container_id: number;
  target_thing_id: number;
  kind: string;
}

/** Open the send log for appending by the opening rule, creating it with mode `0600` where it does not exist. */
export function openSendLog(path: string, fs?: AppendFs): Promise<AppendHandle> {
  return openAppendOnly(path, fs);
}

/** Append one line: the entry as compact JSON, `\n`-terminated. A text holding `\n` or `"` is escaped by JSON. */
export async function appendSendLog(path: string, entry: SendLogEntry, fs?: AppendFs): Promise<void> {
  await appendText(path, `${JSON.stringify(entry)}\n`, fs);
}

/** The lines of a JSON Lines file: every complete line parsed; the ones that fail counted and named to `warn`. */
export async function readJsonLines<T>(path: string, schema: z.ZodType<T>, warn: (text: string) => void): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  const entries: T[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) entries.push(result.data);
    else skipped += 1;
  }
  if (skipped > 0) {
    warn(
      `warning: ${String(skipped)} line${skipped === 1 ? "" : "s"} of ${path} could not be read and ${skipped === 1 ? "was" : "were"} skipped`,
    );
  }
  return entries;
}

/**
 * Every complete line of the send log, in file order; an empty list where the file does not exist. A line that is not
 * a JSON object of the documented shape, a trailing partial line after a crash for one, is skipped with one warning
 * on `stderr` naming the file.
 */
export function readSendLog(path: string, stderr: NodeJS.WritableStream): Promise<SendLogEntry[]> {
  return readJsonLines(path, sendLogEntrySchema, (line) => {
    stderr.write(`${line}\n`);
  });
}

/**
 * The newest entry with the key's three fields, `outcome: "sent"` and `dry_run: false`, or `null`. The log is
 * append-only, so file order is time order and the last matching entry is the newest.
 */
export function repeatGuard(entries: readonly SendLogEntry[], key: RepeatGuardKey): SendLogEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (
      entry.container_id === key.container_id &&
      entry.target_thing_id === key.target_thing_id &&
      entry.kind === key.kind &&
      entry.outcome === "sent" &&
      !entry.dry_run
    ) {
      return entry;
    }
  }
  return null;
}
