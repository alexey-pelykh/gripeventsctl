// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The plan every write builds and the dry run prints, and the shared write result (issue #16 § `OperationContext.gate`
 * and `createWriteGate()`): the kind, the container and target, the request the plan shows and `send()` sends with
 * every string passed through `redactString`, the status read before the write, and the four verdicts. The result
 * carries the plan, the outcome, the refusal and its hint where refused, the proposal's id and expiry where a
 * go-ahead is missing, the fields a sent answer gives, and the send log entry the attempt left. The zod schemas are
 * the output schema the writes item extends with its own fields.
 */

import { z } from "zod";

import { redactString } from "../lib/redact.js";
import { REFUSALS, sendLogEntrySchema } from "./send-log.js";

export const WRITE_KINDS = ["interest.show", "interest.skip", "chat.send"] as const;

export type WriteKind = (typeof WRITE_KINDS)[number];

/** The request the plan shows and `send()` sends: method, path as passed to the client, body as serialised. */
export const writeRequestSchema = z.object({
  method: z.literal("POST"),
  path: z.string(),
  body: z.unknown(),
});

export type WriteRequest = { method: "POST"; path: string; body: unknown };

export const writeVerdictsSchema = z.object({
  writes_enabled: z.boolean(),
  repeat_guard: z.enum(["clear", "blocked"]),
  status: z.enum(["allowed", "not-none", "not-read"]),
  go_ahead: z.enum(["recorded", "missing", "expired", "not-needed"]),
});

export type WriteVerdicts = z.infer<typeof writeVerdictsSchema>;

export const writePlanSchema = z.object({
  kind: z.string(),
  container_id: z.number().int(),
  target_thing_id: z.number().int(),
  request: writeRequestSchema,
  status_before: z.string().nullable(),
  verdicts: writeVerdictsSchema,
});

export interface WritePlan {
  kind: WriteKind;
  container_id: number;
  target_thing_id: number;
  request: WriteRequest;
  status_before: string | null;
  verdicts: WriteVerdicts;
}

export const writeResultSchema = z.object({
  plan: writePlanSchema,
  outcome: z.enum(["sent", "refused", "failed", "dry-run"]),
  refusal: z.enum(REFUSALS).optional(),
  hint: z.string().optional(),
  go_ahead_id: z.string().optional(),
  go_ahead_expires_at: z.string().optional(),
  connection: z.number().int().nullable().optional(),
  message_id: z.number().int().nullable().optional(),
  log_entry: sendLogEntrySchema,
});

/** `value` with every string in it, at any depth, passed through `redactString`; every other value as it is. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((entry: unknown) => redactDeep(entry)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactDeep(entry)]),
    ) as T;
  }
  return value;
}

/** The request as the plan shows it: the same method, path and body, every string redacted. */
export function redactRequest(request: WriteRequest): WriteRequest {
  return { method: "POST", path: redactString(request.path), body: redactDeep(request.body) };
}
