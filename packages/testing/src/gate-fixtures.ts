// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Fixtures of the write gate's two local files (issue #16 § The send log, § The go-ahead journal): one send log line
 * and one journal event in the documented formats, with overrides, and the two readers that parse a JSON Lines file
 * back, every line, without the subject's own reader. Written here from the item's tables, never by the subject, so
 * a test that seeds a file does not depend on the module it grades. Synthetic values only: small thing ids, plain
 * sentences, the fake clock's start as the time.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

/** One send log line (issue #16 § The send log). */
export interface SendLogLine {
  time: string;
  kind: string;
  source: "cli" | "mcp";
  container_id: number;
  target_thing_id: number;
  status_before: string | null;
  message: string | null;
  message_sha256: string | null;
  go_ahead: string | null;
  dry_run: boolean;
  outcome: "sent" | "refused" | "failed" | "dry-run";
  refusal: string | null;
  http_status: number | null;
  response: string | null;
  connection: number | null;
  message_id: number | null;
}

/** One journal line (issue #16 § The go-ahead journal). */
export interface JournalEvent {
  time: string;
  event: "proposed" | "approved" | "consumed";
  id: string;
  kind: string;
  container_id: number;
  target_thing_id: number;
  message?: string;
  message_sha256: string;
  source: "cli" | "mcp";
}

/** The lowercase hex SHA-256 of the UTF-8 bytes of `text`, as the journal and the send log carry it. */
export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A fresh go-ahead id in the documented shape: 8 random bytes, base64url without padding, 11 characters. */
export function goAheadId(): string {
  return randomBytes(8).toString("base64url");
}

/** The time of the fixtures: the fake clock's start, three hours earlier. */
export const FIXTURE_SENT_AT = "2026-10-12T09:00:00Z";

/** A sent, non-dry-run `synthetic.write` line to thing 42 in container 1: the line the repeat guard blocks on. */
export function sendLogLine(overrides: Partial<SendLogLine> = {}): SendLogLine {
  return {
    time: FIXTURE_SENT_AT,
    kind: "synthetic.write",
    source: "cli",
    container_id: 1,
    target_thing_id: 42,
    status_before: "has_match_none",
    message: null,
    message_sha256: null,
    go_ahead: null,
    dry_run: false,
    outcome: "sent",
    refusal: null,
    http_status: 201,
    response: null,
    connection: null,
    message_id: null,
    ...overrides,
  };
}

/** A `proposed` event for `synthetic message 1` to thing 42 in container 1, with its hash; overrides apply after. */
export function journalEvent(overrides: Partial<JournalEvent> = {}): JournalEvent {
  const message = overrides.message ?? "synthetic message 1";
  return {
    time: FIXTURE_SENT_AT,
    event: "proposed",
    id: goAheadId(),
    kind: "synthetic.write",
    container_id: 1,
    target_thing_id: 42,
    message,
    message_sha256: sha256Of(message),
    source: "mcp",
    ...overrides,
  };
}

/** The fields of a journal event without its text: what an `approved` or `consumed` event for the same id carries. */
export function eventFields(event: JournalEvent): Omit<JournalEvent, "message"> {
  const fields: Partial<JournalEvent> = { ...event };
  delete fields.message;
  return fields as Omit<JournalEvent, "message">;
}

/** Append one JSON line to `path` with `appendFile`, mode `0600`: a seeded line, written without the subject. */
export async function appendJsonLine(path: string, value: object): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Every non-empty line of a JSON Lines file parsed; an empty list where the file does not exist. */
async function readJsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** The send log's lines, in file order. */
export function readSendLog(path: string): Promise<SendLogLine[]> {
  return readJsonLines<SendLogLine>(path);
}

/** The journal's events, in file order. */
export function readJournal(path: string): Promise<JournalEvent[]> {
  return readJsonLines<JournalEvent>(path);
}
