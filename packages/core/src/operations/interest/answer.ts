// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * What the two interest writes share (issue #17 § `interest show`, § `interest skip`): the answer path
 * `container/<container_id>/thing/user_id/match_manual/<answer>/to_thing/<thing_id>` (`docs/api/interest.md` § Send an
 * answer), where `user_id` is the platform's literal for the caller and `match_manual` is the segment for a person
 * the user found themselves (§ What the app sends: the plain `match` segment records an answer to a recommendation
 * Grip served and is outside v1); the answer schema `{ message, connection }` of the 201 answer (§ Response); the
 * status read before every POST, which is `match status` itself (issue #12), so the path and the schema are never
 * duplicated; and the one status a POST is allowed on, `has_match_none` (§ Check the state first). The answer is
 * typed as `yes` or `no`: `superyes` (strong interest) is outside v1 and cannot be built here.
 */

import { z } from "zod";

import type { OperationContext } from "../operation.js";
import { CALLER_SEGMENT, matchStatus } from "../match/status.js";

/** The two answers v1 sends; `superyes` is outside v1 (`docs/api/interest.md` § Send an answer). */
export type MatchAnswer = "yes" | "no";

/** The segment for a person the user found themselves (`docs/api/interest.md` § What the app sends). */
export const MATCH_MANUAL_SEGMENT = "match_manual";

/** The one status an interest write posts to (`docs/api/interest.md` § Check the state first). */
export const ALLOWED_STATUS = "has_match_none";

/** The 201 answer's `data` (`docs/api/interest.md` § Response); zod's default object mode drops every other key. */
export const matchAnswerSchema = z.object({ message: z.string(), connection: z.number().int() });

export type MatchAnswerData = z.infer<typeof matchAnswerSchema>;

/** The answer path: `match_manual/<answer>` is a constant per operation, never an input; `?source=` is never sent. */
export function matchAnswerPath(containerId: number, answer: MatchAnswer, thingId: number): string {
  return `container/${String(containerId)}/thing/${CALLER_SEGMENT}/${MATCH_MANUAL_SEGMENT}/${answer}/to_thing/${String(thingId)}`;
}

/** The status read the gate runs before the POST: `match status` for the thing id, the value as the platform sent it. */
export async function readMatchStatus(ctx: OperationContext, thingId: number): Promise<string> {
  const { status } = await matchStatus.run(ctx, { thing_id: thingId });
  return status;
}
