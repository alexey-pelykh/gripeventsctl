// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The response envelope and the documented bodies (`docs/api/README.md` § Response envelope):
 * `{ "success": <boolean>, "data": <object, array or string> }`, with `data` the reason on
 * `success: false`. The zod schemas run in default object mode, which drops unknown keys without
 * failing, so a new field from the platform never breaks a read and never reaches output; a missing
 * documented field is the `api` kind naming the field.
 */

import { z } from "zod";

// docs/api/interest.md § Throttling (HTTP 429).
export const THROTTLING_REASON = "Throttling - Maximum sending rate exceeded";
// docs/api/interest.md § Errors the app matches on (from the app code).
export const SWIPE_CAP_REASON = "limit of swipes reached for action";
export const MODE_PHASE_REASON = "action not allowed under current mode phase";
// docs/api/containers.md § Answers.
export const UNKNOWN_SLUG_REASON = "No results found for this container name";
// docs/api/attendees.md § Types: a gated type answers 403 `thing N not authorized`.
const GATED_TYPE_PATTERN = /not authorized/i;
const GATED_THING_ID_PATTERN = /\bthing\s+(\d+)\s+not authorized/i;

export interface Envelope {
  success: boolean;
  data: unknown;
}

/** `data` may be absent on a success answer; a `success: false` without a reason is still an error. */
export const envelopeSchema = z.object({ success: z.boolean(), data: z.unknown().optional() });

/** The parsed JSON of `text`, or `undefined` where it is not JSON. Never throws. */
export function parseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The envelope `text` holds, or `undefined` where the body is not JSON or not of the envelope shape. */
export function parseEnvelope(text: string): Envelope | undefined {
  const body = parseJson(text);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const result = envelopeSchema.safeParse(body);
  return result.success ? { success: result.data.success, data: result.data.data } : undefined;
}

/** `data` as one line of text: a string as it is, anything else as JSON. */
export function dataText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "";
  try {
    const json: unknown = JSON.stringify(data);
    return typeof json === "string" ? json : "";
  } catch {
    return "[a value that cannot be serialised]";
  }
}

/** True where a 403 body's `data` is the gated-type answer `thing N not authorized`. */
export function isGatedTypeReason(data: unknown): data is string {
  return typeof data === "string" && GATED_TYPE_PATTERN.test(data);
}

/** The id a gated-type answer names, where it names one. */
export function gatedThingId(reason: string): number | undefined {
  const match = GATED_THING_ID_PATTERN.exec(reason);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The `error.data` array of an HTTP 409 (`docs/api/interest.md` § Errors the app matches on), each
 * item as text, or `undefined` where the body does not hold one.
 */
export function conflictDetails(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error: unknown = (body as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return undefined;
  const data: unknown = (error as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return undefined;
  return data.map((item: unknown) => dataText(item));
}

/**
 * The config lookup's `data` (`docs/api/containers.md` § Fields of a 200 answer): the display name,
 * the container name, the active flag (`1` live, `0` ended), the application name, id and
 * per-event token, and the type permissions kept as sent. `permissions` may be absent (an ended
 * edition). `default_container_id` names the application's default event, not the looked-up
 * container, and is not typed; which field holds the container's own id is not verified.
 */
export const configLookupSchema = z.object({
  container: z.object({
    general: z.object({ display_name: z.string(), name: z.string(), active: z.number() }),
  }),
  application: z.object({
    general: z.object({ application_name: z.string(), application_id: z.number(), token: z.string() }),
    permissions: z.object({ type_permissions: z.unknown().optional() }).optional(),
  }),
});

export type ConfigLookup = z.infer<typeof configLookupSchema>;

/**
 * The login's `data` (`docs/api/login.md` § Response): `user_token` is the session token;
 * `chat_token` is the AWS Cognito object holding `Token` and `IdentityId`, also accepted as a bare
 * string or absent, because nothing in v1 uses it and its absence must not fail a sign-in.
 */
export const loginAnswerSchema = z.object({
  user_token: z.string().min(1),
  chat_token: z
    .union([z.object({ IdentityId: z.string().optional(), Token: z.string().optional() }), z.string()])
    .optional(),
});

export type LoginAnswer = z.infer<typeof loginAnswerSchema>;

/** One line naming the first documented field the answer lacks or mistypes. */
export function schemaFailureMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the answer does not match the documented shape";
  const path = issue.path.map(String).join(".");
  const field = path === "" ? "the answer" : `the documented field ${path}`;
  return `${field} is missing or not of the documented type (${issue.message})`;
}
