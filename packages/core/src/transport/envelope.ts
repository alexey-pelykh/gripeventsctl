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

// docs/api/interest.md § Errors the app matches on (from the app code).
export const SWIPE_CAP_REASON = "limit of swipes reached for action";
export const MODE_PHASE_REASON = "action not allowed under current mode phase";
// docs/api/containers.md § Answers.
export const UNKNOWN_SLUG_REASON = "No results found for this container name";
// docs/api/attendees.md § Types: a gated type answers 403 `thing N not authorized`. The match is the
// gated-type row of issue #5 § The envelope and the classification ("`data` matching `not authorized`"),
// wider than that documented shape and applied on the directory search path only; the row's hint names
// the one-id-per-call method whether or not the body names an id.
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

/** True for a JSON object or array (`typeof` says `object`) that is not `null`: a value whose keys can be read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The envelope a body already parsed holds (the value `parseJson` returns), or `undefined` where it is not of the
 * envelope shape. The client parses each answer's text once and reads the envelope from that value.
 */
export function envelopeOf(body: unknown): Envelope | undefined {
  if (!isRecord(body) || Array.isArray(body)) return undefined;
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

/**
 * `data` as the reason of a `success: false` answer: `dataText(data)`, or the empty string where `data` is `null` or
 * its text is empty or only whitespace, which counts as no reason (issue #5 § The envelope and the classification):
 * the message then ends at the status and the hint is the status.
 */
export function reasonText(data: unknown): string {
  if (data === null) return "";
  const text = dataText(data);
  return text.trim() === "" ? "" : text;
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
 * The array of an HTTP 409 (`docs/api/interest.md` § Errors the app matches on), each item as text,
 * or `undefined` where the body holds none. Two shapes are accepted (issue #5 § The envelope and the
 * classification, the 409 row): a top-level `error.data` array, the location the web app's code
 * reads, and the envelope's own `data` array, which the app's HTTP client may hand its code as
 * `error.data`. No live 409 is recorded, so both stay accepted until one is
 * (`docs/api/not-verified.md` § Match answers); where both are present, `error.data` wins.
 */
export function conflictDetails(body: unknown): string[] | undefined {
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  const data = isRecord(error) && Array.isArray(error["data"]) ? error["data"] : body["data"];
  if (!Array.isArray(data)) return undefined;
  return data.map((item: unknown) => dataText(item));
}

/**
 * The config lookup's `data` (`docs/api/containers.md` § Fields of a 200 answer): the display name,
 * the container name, the active flag (`1` live, `0` ended), the application name, id and
 * per-event token, and the type permissions kept as sent. `permissions` may be absent without an
 * error (issue #5 § The envelope and the classification, response validation): the answer for an
 * ended edition omits the block, in a live run of 2026-10-13 recorded by #6. `default_container_id`
 * names the application's default event, not the looked-up container, and is not typed; which field
 * holds the container's own id is not verified.
 *
 * The JSON types come from the page's own literals (`1` / `0` for `active`, "numeric id, for
 * example `165`" for `application_id`, a display name that may be empty); the page's § Example
 * prints a script's formatted output, not the raw answer. The live run of 2026-10-13 recorded by #6
 * gives both as JSON numbers, which agrees with this schema. A live answer of another type surfaces
 * as `api` naming the field, the rule for a mistyped documented field (issue #5 § The envelope and
 * the classification, response validation).
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
 * The login's `data` (`docs/api/login.md` § Response): `user_token` is the session token, and a
 * missing one is the `api` kind; `chat_token` is the AWS Cognito object holding `Token` and
 * `IdentityId`, also accepted as a bare string, and may be absent without an error, because nothing in
 * v1 reads it (issue #5 § The envelope and the classification, response validation).
 */
export const loginAnswerSchema = z.object({
  user_token: z.string().min(1),
  chat_token: z
    .union([z.object({ IdentityId: z.string().optional(), Token: z.string().optional() }), z.string()])
    .optional(),
});

export type LoginAnswer = z.infer<typeof loginAnswerSchema>;

/**
 * The one line a missing or mistyped documented field is reported with (the issue's rule: `api` naming
 * the field); `detail` is the validator's own message, where there is one. An empty `field` names the
 * answer as a whole.
 */
export function missingFieldMessage(field: string, detail?: string): string {
  const subject = field === "" ? "the answer" : `the documented field ${field}`;
  return `${subject} is missing or not of the documented type${detail === undefined ? "" : ` (${detail})`}`;
}

/** One line naming the first documented field the answer lacks or mistypes. */
export function schemaFailureMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the answer does not match the documented shape";
  return missingFieldMessage(issue.path.map(String).join("."), issue.message);
}
