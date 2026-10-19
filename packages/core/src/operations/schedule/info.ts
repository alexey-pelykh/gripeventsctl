// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `schedule info` (issue #14 § `schedule info`): the signed-in attendee's schedule, `GET schedule/thing/user_id/info?
 * container_id=<container_id>` (`docs/api/chat-and-meetings.md` § Schedule). The path sits directly under `/1/`, not
 * under `container/`; `user_id` is the platform's literal segment for the caller (`docs/api/README.md` § Vocabulary),
 * and the container id travels as the `container_id` query parameter, through the client's `query` option. The
 * answer's `data.schedule` holds one entry per meeting and per agenda session; each is projected to the ten
 * documented fields in the order the API sent the entries: `type`, `status`, `user_display_type`, the start and end
 * (`date_start_timestamp`, `date_end_timestamp`, epoch seconds), `location`, `attendees` (each with `thing_id`,
 * `name`, `company_name` and `status`), `requestor_id`, the request note `message` and `has_conflict`. `type`,
 * `status` and `user_display_type` are strings, never enums: the page lists the display types only in part, so a
 * value it does not list is shown as sent. The page does not record whether `requestor_id`, `location` and `message`
 * are `null` for an agenda session, so they are nullable, as are the timestamps; a missing nullable field maps to
 * `null` and a missing `attendees` to an empty array. The page records no JSON type for the conflict flag, so it is
 * typed as a boolean until a live run shows otherwise. zod's default object mode drops every other key; a missing
 * `type`, or an answer whose `data` lacks `schedule`, is the transport's `api` kind naming the field. One GET, no
 * side effect.
 */

import { z } from "zod";

import { containerIdOf, signalOption } from "../context.js";
import { defineOperation } from "../operation.js";

/** One of an entry's `attendees` as the page records it; a missing nullable field maps to `null`. */
export const scheduleAttendeeRecord = z.object({
  thing_id: z.number().int(),
  name: z.string().nullable().default(null),
  company_name: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
});

export const scheduleEntryRecord = z.object({
  /** Documented values `meeting` and `session`; passed through as sent. */
  type: z.string(),
  /** Documented values `accepted`, `pending` and `declined`; passed through as sent. */
  status: z.string(),
  /** Documented in part (`confirmed`, `awaiting_response`); always passed through as sent. */
  user_display_type: z.string(),
  /** Epoch seconds. */
  date_start_timestamp: z.number().int().nullable().default(null),
  /** Epoch seconds. */
  date_end_timestamp: z.number().int().nullable().default(null),
  location: z.string().nullable().default(null),
  /** Empty where the entry carries none. */
  attendees: z.array(scheduleAttendeeRecord).default(() => []),
  /** The thing id of the person who asked for the meeting; not recorded for an agenda session. */
  requestor_id: z.number().int().nullable().default(null),
  /** The note sent with the request. */
  message: z.string().nullable().default(null),
  has_conflict: z.boolean(),
});

export type ScheduleEntryRecord = z.infer<typeof scheduleEntryRecord>;

export const scheduleInfoOutput = z.array(scheduleEntryRecord);

export type ScheduleInfoOutput = z.infer<typeof scheduleInfoOutput>;

/** The answer's `data`: the entries under `schedule`. */
export const scheduleInfoAnswer = z.object({ schedule: scheduleInfoOutput });

/** The path of the schedule read; the container id is its query parameter, never a path segment. */
export const SCHEDULE_INFO_PATH = "schedule/thing/user_id/info";

export const SCHEDULE_INFO_EMPTY_TEXT = "empty schedule";

export const scheduleInfo = defineOperation({
  group: "schedule",
  verb: "info",
  kind: "read",
  description: "Show your schedule: meetings and agenda sessions",
  needsSession: true,
  input: z.object({}),
  output: scheduleInfoOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "schedule/thing/user_id/info?container_id=<id>",
      page: "chat-and-meetings.md",
      section: "Schedule",
    },
  ],
  render: { epochFields: ["date_start_timestamp", "date_end_timestamp"], emptyText: SCHEDULE_INFO_EMPTY_TEXT },
  async run(ctx): Promise<ScheduleInfoOutput> {
    const data = await ctx.client.get(SCHEDULE_INFO_PATH, {
      query: { container_id: containerIdOf(ctx) },
      schema: scheduleInfoAnswer,
      ...signalOption(ctx),
    });
    return data.schedule;
  },
});
