// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `match status <thing id>` (issue #12 § `match status`): whether the signed-in attendee has answered a person,
 * `GET container/<container_id>/thing/user_id/match/<thing_id>/status` (`docs/api/interest.md` § Check the state
 * first), where `user_id` is the platform's literal for the caller (`docs/api/README.md` § Vocabulary) and the thing
 * id is the `id` of a directory entry or a profile. One request, always GET, always the `user_id/match/<thing id>`
 * form: the reversed form `thing/<thing id>/match/user_id/status` answers 403 and is never built, and this module
 * imports nothing that can POST. The output is the projection `{ status }` with every other key of the answer
 * dropped; the value is shown as the platform sent it. The four documented values are `has_match_none` (not yet
 * answered), `has_match_yes` (interest shown), `has_match_no` (skipped) and `has_connection` (the other person showed
 * interest back); any other value passes through unchanged, with one warning line on `ctx.stderr` naming it and
 * listing the four, because a fifth value is a platform change to report, not a failed read. The line is redacted
 * first, so the patterns and the registered values read the text as sent, then escaped for the terminal, then kept
 * to one physical line like the transport's own lines: a wire value can hold a line break, and a second line could
 * read as a transport diagnostic.
 * A missing `data.status` is the transport's `api` kind naming the field; every other error propagates untouched.
 * No side effect: this is the read the gated writes run before every POST, and the user's own view of the same answer.
 */

import { z } from "zod";

import { escapeForTerminal } from "../../lib/escape.js";
import { redactString } from "../../lib/redact.js";
import { escapeLineBreaks } from "../../transport/errors.js";
import { containerIdOf, signalOption } from "../context.js";
import { defineOperation } from "../operation.js";

/** The platform's literal path segment for the caller (`docs/api/README.md` § Vocabulary); a constant, never an input. */
export const CALLER_SEGMENT = "user_id";

/** The four values `docs/api/interest.md` § Check the state first records, in the page's order. */
export const DOCUMENTED_MATCH_STATUSES: readonly string[] = Object.freeze([
  "has_match_none",
  "has_match_yes",
  "has_match_no",
  "has_connection",
]);

export const THING_ID_HELP = "a thing id from attendees list";

export const matchStatusInput = z.object({
  thing_id: z.number().int().positive().describe(THING_ID_HELP),
});

export type MatchStatusInput = z.infer<typeof matchStatusInput>;

export const matchStatusOutput = z.object({ status: z.string() });

export type MatchStatusOutput = z.infer<typeof matchStatusOutput>;

/** The answer's `data`: `status` required and non-empty; zod's default object mode drops every other key. */
export const matchStatusAnswerSchema = z.object({ status: z.string().min(1) });

/** The request path for a thing id: the `user_id/match/<thing id>/status` form, never the reversed one. */
export function matchStatusPath(containerId: number, thingId: number): string {
  return `container/${String(containerId)}/thing/${CALLER_SEGMENT}/match/${String(thingId)}/status`;
}

/** The one warning line for a value the page does not record, before redaction and escaping. */
export function unknownStatusWarning(status: string): string {
  return `unknown match status "${status}"; the documented values are ${DOCUMENTED_MATCH_STATUSES.join(", ")}`;
}

/** The warning as written: redacted, then escaped for the terminal, then every remaining line break escaped. */
export function unknownStatusWarningLine(status: string): string {
  return escapeLineBreaks(escapeForTerminal(redactString(unknownStatusWarning(status))));
}

export const matchStatus = defineOperation({
  group: "match",
  verb: "status",
  kind: "read",
  description: "Show whether you have answered a person: not yet, interest shown, skipped, or connected",
  needsSession: true,
  input: matchStatusInput,
  output: matchStatusOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "container/<id>/thing/user_id/match/<thing id>/status",
      page: "interest.md",
      section: "Check the state first",
    },
  ],
  cli: { positional: ["thing_id"] },
  async run(ctx, input): Promise<MatchStatusOutput> {
    const answer = await ctx.client.get(matchStatusPath(containerIdOf(ctx), input.thing_id), {
      schema: matchStatusAnswerSchema,
      ...signalOption(ctx),
    });
    if (!DOCUMENTED_MATCH_STATUSES.includes(answer.status)) {
      ctx.stderr.write(`${unknownStatusWarningLine(answer.status)}\n`);
    }
    return { status: answer.status };
  },
});
