// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `chat list` (issue #13 § `chat list`): every chat thread of the signed-in container, `GET chat/latest?container_id=
 * <container_id>` (`docs/api/chat-and-meetings.md` § Chat threads). The path sits directly under `/1/`, not under
 * `container/`; the container id travels as the `container_id` query parameter, through the client's `query` option.
 * Each thread is projected to the ten documented fields in the order the API sent them: the other person's
 * `thing_id`, `name`, `job_title`, `company_name`, the `last_message` and its `last_message_date` (epoch seconds),
 * `last_message_is_read`, `new_messages_count`, `total_message_count` and `chat_id`; zod's default object mode drops
 * every other key, and a missing `thing_id` is the transport's `api` kind naming the field. `last_message` and
 * `last_message_date` are nullable, because a person who showed interest back has a thread before anyone types; the
 * page records no JSON type for the read flag, so it is typed as a boolean until a live run shows otherwise. The list
 * is also the connections list, which the `render.note` sentence states after the table: the connections path
 * `container/<id>/thing/user_id/connections` answers 404 and is never requested. One GET, no side effect.
 */

import { z } from "zod";

import { containerIdOf, signalOption } from "../context.js";
import { defineOperation } from "../operation.js";

export const chatThreadRecord = z.object({
  thing_id: z.number().int(),
  name: z.string().nullable(),
  job_title: z.string().nullable(),
  company_name: z.string().nullable(),
  /** Null on a thread nobody has typed in. */
  last_message: z.string().nullable(),
  /** Epoch seconds; null with `last_message`. */
  last_message_date: z.number().int().nullable(),
  last_message_is_read: z.boolean(),
  new_messages_count: z.number().int(),
  total_message_count: z.number().int(),
  chat_id: z.number().int(),
});

export type ChatThreadRecord = z.infer<typeof chatThreadRecord>;

export const chatListOutput = z.array(chatThreadRecord);

export type ChatListOutput = z.infer<typeof chatListOutput>;

/** The path of the thread list; the container id is its query parameter, never a path segment. */
export const CHAT_LIST_PATH = "chat/latest";

export const CHAT_LIST_EMPTY_TEXT = "no threads";

export const CHAT_LIST_NOTE =
  "This list is also your connections list: a person who showed interest back has a thread here before anyone types.";

export const chatList = defineOperation({
  group: "chat",
  verb: "list",
  kind: "read",
  description: "List your chat threads, which are also your connections",
  needsSession: true,
  input: z.object({}),
  output: chatListOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "chat/latest?container_id=<id>",
      page: "chat-and-meetings.md",
      section: "Chat threads",
    },
  ],
  render: { epochFields: ["last_message_date"], emptyText: CHAT_LIST_EMPTY_TEXT, note: CHAT_LIST_NOTE },
  run: (ctx): Promise<ChatListOutput> =>
    ctx.client.get(CHAT_LIST_PATH, {
      query: { container_id: containerIdOf(ctx) },
      schema: chatListOutput,
      ...signalOption(ctx),
    }),
});
