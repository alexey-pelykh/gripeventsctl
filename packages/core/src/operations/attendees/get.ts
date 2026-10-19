// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `attendees get <thing id | user_id | me>` (issue #11 § `attendees get`): the per-person profile,
 * `GET container/<container_id>/thing/<segment>` (`docs/api/attendees.md` § The per-person profile), where the
 * segment is the number, or the literal `user_id` for both `user_id` (the platform's literal for the caller's own
 * record) and `me` (its alias). One request; the at-least-1,000 ms spacing between two profile reads is the
 * transport's queue rule, and the operation adds no wait of its own. The output is an explicit projection of the
 * fields the page records and the search payload lacks: `rtm` and `rtm_raw` (the rich profile fields, shape not
 * recorded, shown as compact JSON), `sessions_speaker` (`data.sessions.speaker[]`), `common_containers`,
 * `common_connections_count` and `rtm_score`; a missing `sessions` or `sessions.speaker` maps to an empty array, a
 * missing optional field to `null`, and a missing `data.id` is the `api` kind naming the field (the transport's
 * schema check). For a numeric request, `data.id` must equal the requested number, else the `api` kind with the
 * message `profile id mismatch: requested <n>, answer carries <m>`; for `user_id` and `me` the returned `id` is the
 * caller's own thing id and is shown. Nothing is written to disk. Fields the page does not record, the person's name
 * among them, are not projected until the page records them.
 */

import { z } from "zod";

import { ApiError, WIRE_BREAKAGE_HINT } from "../../transport/errors.js";
import { defineOperation } from "../operation.js";
import { containerIdOf, signalOption } from "../context.js";

/** The platform's literal path segment for the caller's own record (`docs/api/README.md` § Vocabulary). */
export const OWN_RECORD_SEGMENT = "user_id";

/** The alias the tool accepts for `user_id`. */
export const OWN_RECORD_ALIAS = "me";

export const THING_ID_HELP = `a thing id from attendees list; ${OWN_RECORD_SEGMENT} is your own record and ${OWN_RECORD_ALIAS} is its alias`;

export const attendeesGetInput = z.object({
  thing_id: z
    .union([z.number().int().positive(), z.literal(OWN_RECORD_SEGMENT), z.literal(OWN_RECORD_ALIAS)])
    .describe(THING_ID_HELP),
});

export type AttendeesGetInput = z.infer<typeof attendeesGetInput>;

/** One of `data.sessions.speaker[]` as the page records it; a field the answer lacks maps to `null`. */
export const speakerSessionSchema = z.object({
  session_name: z.string().nullable(),
  description: z.string().nullable(),
  track: z.string().nullable(),
  location: z.string().nullable(),
  /** Epoch seconds. Nested, so the human form shows it inside the compact JSON of the entry, not as local time. */
  date_start: z.number().int().nullable(),
});

export const attendeesGetOutput = z.object({
  id: z.number().int(),
  /** The rich profile fields; shape not recorded, so shown as compact JSON. */
  rtm: z.unknown().nullable(),
  rtm_raw: z.unknown().nullable(),
  /** `data.sessions.speaker[]`; empty where the answer has no `sessions` or no `speaker`. */
  sessions_speaker: z.array(speakerSessionSchema),
  /** Shape not recorded beyond "lists only containers shared with the caller". */
  common_containers: z.unknown().nullable(),
  common_connections_count: z.number().int().nullable(),
  /** Grip's own match score. */
  rtm_score: z.number().nullable(),
});

export type AttendeesGetOutput = z.infer<typeof attendeesGetOutput>;

/** The answer's `data` as the page records it: `id` required, every other recorded field optional and nullable. */
const speakerSessionAnswer = z.object({
  session_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  track: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  date_start: z.number().int().nullable().optional(),
});

export const profileAnswerSchema = z.object({
  id: z.number().int(),
  rtm: z.unknown().optional(),
  rtm_raw: z.unknown().optional(),
  sessions: z
    .object({ speaker: z.array(speakerSessionAnswer).nullable().optional() })
    .nullable()
    .optional(),
  common_containers: z.unknown().optional(),
  common_connections_count: z.number().int().nullable().optional(),
  rtm_score: z.number().nullable().optional(),
});

export type ProfileAnswer = z.infer<typeof profileAnswerSchema>;

/** The projection of a profile answer: every output key present, a missing field as `null`, no speaker list as `[]`. */
export function projectProfile(answer: ProfileAnswer): AttendeesGetOutput {
  return {
    id: answer.id,
    rtm: answer.rtm ?? null,
    rtm_raw: answer.rtm_raw ?? null,
    sessions_speaker: (answer.sessions?.speaker ?? []).map((session) => ({
      session_name: session.session_name ?? null,
      description: session.description ?? null,
      track: session.track ?? null,
      location: session.location ?? null,
      date_start: session.date_start ?? null,
    })),
    common_containers: answer.common_containers ?? null,
    common_connections_count: answer.common_connections_count ?? null,
    rtm_score: answer.rtm_score ?? null,
  };
}

/** The path segment of a `thing_id` input: the number, or `user_id` for both `user_id` and `me`. */
export function profileSegment(thingId: AttendeesGetInput["thing_id"]): string {
  return typeof thingId === "number" ? String(thingId) : OWN_RECORD_SEGMENT;
}

export const attendeesGet = defineOperation({
  group: "attendees",
  verb: "get",
  kind: "read",
  description: "Show one attendee's profile; user_id or me shows your own record",
  needsSession: true,
  input: attendeesGetInput,
  output: attendeesGetOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "container/<id>/thing/<thing id>",
      page: "attendees.md",
      section: "The per-person profile",
    },
  ],
  cli: { positional: ["thing_id"] },
  async run(ctx, input): Promise<AttendeesGetOutput> {
    const path = `container/${String(containerIdOf(ctx))}/thing/${profileSegment(input.thing_id)}`;
    const answer = await ctx.client.get(path, { schema: profileAnswerSchema, ...signalOption(ctx) });
    if (typeof input.thing_id === "number" && answer.id !== input.thing_id) {
      throw new ApiError(
        `profile id mismatch: requested ${String(input.thing_id)}, answer carries ${String(answer.id)}`,
        WIRE_BREAKAGE_HINT,
      );
    }
    return projectProfile(answer);
  },
});
