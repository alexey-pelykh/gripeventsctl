// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The go-ahead journal (issue #16 § The go-ahead journal): the append-only record of the user's consent that an
 * assistant-written message may be sent, one event per line at `derivedPaths().goAheads`, by the same opening rule
 * as the send log. State is the fold of events per `id`: the latest event by file order decides the state, not the
 * time field. A go-ahead is usable when its latest event is `approved` and that event's time is less than 24 hours
 * before the clock; `consumed` closes it; a `proposed` record never approved expires 24 hours after its `proposed`
 * time. A go-ahead matches a write only when all four of `kind`, `container_id`, `target_thing_id` and
 * `message_sha256` are equal: a go-ahead for one text never matches another text, and a go-ahead for one person never
 * matches another. A `proposed` event stores the text so `writes pending` can show it; `approved` and `consumed`
 * store the hash only. The id is 8 bytes from `crypto.randomBytes`, base64url without padding, 11 characters, printed
 * to the user and typed back. The SHA-256 is over the UTF-8 bytes of the text exactly as received: no trimming, no
 * normalisation. The 24-hour expiry is counted on the clock given, never on `Date.now()`.
 */

import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { Clock } from "../lib/clock.js";
import { UsageError } from "../transport/errors.js";
import type { AppendFs } from "./files.js";
import { appendText } from "./files.js";
import { readJsonLines } from "./send-log.js";

/** How long a proposal waits for its approval, and an approval for its use. One constant, in milliseconds. */
export const GO_AHEAD_TTL_MS = 24 * 60 * 60 * 1000;

export const GO_AHEAD_EVENTS = ["proposed", "approved", "consumed"] as const;

export type GoAheadEventName = (typeof GO_AHEAD_EVENTS)[number];

/** One journal line. */
export const goAheadEventSchema = z.object({
  time: z.string(),
  event: z.enum(GO_AHEAD_EVENTS),
  id: z.string(),
  kind: z.string(),
  container_id: z.number().int(),
  target_thing_id: z.number().int(),
  message: z.string().optional(),
  message_sha256: z.string(),
  source: z.enum(["cli", "mcp"]),
});

export type GoAheadEvent = z.infer<typeof goAheadEventSchema>;

/** The four fields a go-ahead matches a write on, plus the text a proposal stores. */
export interface GoAheadWrite {
  kind: string;
  container_id: number;
  target_thing_id: number;
  message: string;
}

/** The fold of one id's events: its state is the name of the latest event in file order. */
export interface GoAheadRecord {
  id: string;
  state: GoAheadEventName;
  kind: string;
  container_id: number;
  target_thing_id: number;
  message_sha256: string;
  /** The text, from the `proposed` event; absent where that line was not read. */
  message?: string;
  /** The time of the `proposed` event; the first event's time where none was read. */
  proposed_at: string;
  /** The time of the latest `approved` event. */
  approved_at?: string;
  consumed_at?: string;
  /** The source of the latest event. */
  source: "cli" | "mcp";
}

/** The lowercase hex SHA-256 of the UTF-8 bytes of `text`, exactly as received. */
export function messageSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A fresh id: 8 random bytes, base64url without padding, 11 characters. */
export function newGoAheadId(): string {
  return randomBytes(8).toString("base64url");
}

/** Every complete line of the journal, in file order; an empty list where the file does not exist. */
export function readJournal(path: string, stderr?: NodeJS.WritableStream): Promise<GoAheadEvent[]> {
  return readJsonLines(path, goAheadEventSchema, (line) => {
    stderr?.write(`${line}\n`);
  });
}

/** The records of `events`, by id, each in the state of its latest event in file order. */
export function foldJournal(events: readonly GoAheadEvent[]): Map<string, GoAheadRecord> {
  const records = new Map<string, GoAheadRecord>();
  for (const event of events) {
    const existing = records.get(event.id);
    const record: GoAheadRecord = existing ?? {
      id: event.id,
      state: event.event,
      kind: event.kind,
      container_id: event.container_id,
      target_thing_id: event.target_thing_id,
      message_sha256: event.message_sha256,
      proposed_at: event.time,
      source: event.source,
    };
    record.state = event.event;
    record.source = event.source;
    if (event.event === "proposed") {
      record.proposed_at = event.time;
      if (event.message !== undefined) record.message = event.message;
    } else if (event.event === "approved") {
      record.approved_at = event.time;
    } else {
      record.consumed_at = event.time;
    }
    records.set(event.id, record);
  }
  return records;
}

/** When the record expires: the latest `approved` time plus 24 hours, or the `proposed` time plus 24 hours. */
export function goAheadExpiresAt(record: Pick<GoAheadRecord, "proposed_at" | "approved_at">): Date {
  const base = record.approved_at ?? record.proposed_at;
  return new Date(Date.parse(base) + GO_AHEAD_TTL_MS);
}

/** True where the record's expiry is after `now`. */
export function isUnexpired(record: Pick<GoAheadRecord, "proposed_at" | "approved_at">, now: Date): boolean {
  return goAheadExpiresAt(record).getTime() > now.getTime();
}

/** True where the record's latest event is `proposed` and its proposal has not expired. */
export function isOpenProposal(record: GoAheadRecord, now: Date): boolean {
  return record.state === "proposed" && isUnexpired(record, now);
}

/** True where the record's latest event is `approved` and that approval has not expired. */
export function isUsable(record: GoAheadRecord, now: Date): boolean {
  return record.state === "approved" && isUnexpired(record, now);
}

/** True where the record's four fields equal the write's. */
export function matchesWrite(
  record: Pick<GoAheadRecord, "kind" | "container_id" | "target_thing_id" | "message_sha256">,
  write: { kind: string; container_id: number; target_thing_id: number; message_sha256: string },
): boolean {
  return (
    record.kind === write.kind &&
    record.container_id === write.container_id &&
    record.target_thing_id === write.target_thing_id &&
    record.message_sha256 === write.message_sha256
  );
}

/** The records of `folded`, oldest proposal first, whose latest event is `proposed` and unexpired. */
export function pendingProposals(folded: ReadonlyMap<string, GoAheadRecord>, now: Date): GoAheadRecord[] {
  return [...folded.values()]
    .filter((record) => isOpenProposal(record, now))
    .sort((a, b) => Date.parse(a.proposed_at) - Date.parse(b.proposed_at));
}

/** Append one event by the opening rule. */
async function appendEvent(path: string, event: GoAheadEvent, fs?: AppendFs): Promise<void> {
  await appendText(path, `${JSON.stringify(event)}\n`, fs);
}

/**
 * Propose a go-ahead for `write`: where an open (unexpired, latest event `proposed`) record with the same four fields
 * exists, return it; otherwise append `proposed` with a new id and return the record. A retry of the same call never
 * mints a second id.
 */
export async function proposeGoAhead(
  path: string,
  write: GoAheadWrite & { source: "cli" | "mcp" },
  clock: Clock,
  fs?: AppendFs,
): Promise<GoAheadRecord> {
  const now = clock.now();
  const message_sha256 = messageSha256(write.message);
  const folded = foldJournal(await readJournal(path));
  for (const record of folded.values()) {
    if (isOpenProposal(record, now) && matchesWrite(record, { ...write, message_sha256 })) return record;
  }
  const event: GoAheadEvent = {
    time: now.toISOString(),
    event: "proposed",
    id: newGoAheadId(),
    kind: write.kind,
    container_id: write.container_id,
    target_thing_id: write.target_thing_id,
    message: write.message,
    message_sha256,
    source: write.source,
  };
  await appendEvent(path, event, fs);
  return {
    id: event.id,
    state: "proposed",
    kind: event.kind,
    container_id: event.container_id,
    target_thing_id: event.target_thing_id,
    message_sha256,
    message: write.message,
    proposed_at: event.time,
    source: event.source,
  };
}

/** The `usage` error of an id that cannot be approved, naming the state it is in. */
export function notApprovable(id: string, record: GoAheadRecord | undefined, now: Date): UsageError {
  const hint = "list the proposals that await approval with `gripeventsctl writes pending`";
  if (record === undefined) return new UsageError(`go-ahead ${id} is unknown`, hint);
  if (record.state === "approved") return new UsageError(`go-ahead ${id} is already approved`, hint);
  if (record.state === "consumed") return new UsageError(`go-ahead ${id} is already consumed`, hint);
  if (!isUnexpired(record, now)) {
    return new UsageError(`go-ahead ${id} expired at ${goAheadExpiresAt(record).toISOString()}`, hint);
  }
  return new UsageError(`go-ahead ${id} cannot be approved`, hint);
}

/**
 * The open proposal `id`: the record whose latest event is `proposed` and unexpired; otherwise the `usage` kind saying
 * the id is unknown, already approved, consumed or expired. What `writes go-ahead` reads before it shows the screen.
 */
export async function findOpenProposal(path: string, id: string, clock: Clock): Promise<GoAheadRecord> {
  const now = clock.now();
  const record = foldJournal(await readJournal(path)).get(id);
  if (record === undefined || !isOpenProposal(record, now)) throw notApprovable(id, record, now);
  return record;
}

export interface ApproveOptions {
  /** The source of the approval; `cli`, the only one that may record it. */
  source?: "cli";
  fs?: AppendFs;
  /**
   * The approval's time, where the caller took it before the reads it made first: `writes go-ahead` reads the event's
   * and the person's names after the user asked and before the user typed, and the approval is dated to the ask.
   */
  at?: Date;
}

/**
 * Approve the proposal `id`: append `approved` from the terminal (`source: "cli"`) where its latest event is
 * `proposed` and unexpired at `options.at` (the clock's now by default); otherwise the `usage` kind saying the id is
 * unknown, already approved, consumed or expired. Returns the record with its approval.
 */
export async function approveGoAhead(
  path: string,
  id: string,
  clock: Clock,
  options: ApproveOptions = {},
): Promise<GoAheadRecord> {
  const now = options.at ?? clock.now();
  const source = options.source ?? "cli";
  const record = foldJournal(await readJournal(path)).get(id);
  if (record === undefined || !isOpenProposal(record, now)) throw notApprovable(id, record, now);
  const event: GoAheadEvent = {
    time: now.toISOString(),
    event: "approved",
    id,
    kind: record.kind,
    container_id: record.container_id,
    target_thing_id: record.target_thing_id,
    message_sha256: record.message_sha256,
    source,
  };
  await appendEvent(path, event, options.fs);
  return { ...record, state: "approved", approved_at: event.time, source };
}

/** Append `consumed` for `record` with the write's source; the gate calls it before the POST. */
export async function consumeGoAhead(
  path: string,
  record: Pick<GoAheadRecord, "id" | "kind" | "container_id" | "target_thing_id" | "message_sha256">,
  source: "cli" | "mcp",
  clock: Clock,
  fs?: AppendFs,
): Promise<void> {
  await appendEvent(
    path,
    {
      time: clock.now().toISOString(),
      event: "consumed",
      id: record.id,
      kind: record.kind,
      container_id: record.container_id,
      target_thing_id: record.target_thing_id,
      message_sha256: record.message_sha256,
      source,
    },
    fs,
  );
}
