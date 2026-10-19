// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `chat thread <thing id>` (issue #13 § `chat thread`): every message of the thread with one person, `GET
 * chat/thing/<thing_id>` (`docs/api/chat-and-meetings.md` § Messages in a thread), where the thing id is the other
 * person's, from `chat list` or a directory entry. The path sits directly under `/1/`, not under `container/`, and
 * carries no query: the page records none for this call. Each message is projected to the seven documented fields in
 * the order the API sent them: `id`, `sender_id`, `recipient_id`, `message`, `date_created` (epoch seconds),
 * `is_read` and `meeting_action`; zod's default object mode drops every other key. `meeting_action` is typed
 * `unknown`, nullable, on purpose: the page names the field and not its type, so the value passes through as sent
 * (the human table shows a non-scalar as compact JSON). One GET and nothing else: the page records no mark-as-read
 * call and no side effect of this read, and this module imports nothing that can POST.
 */

import { z } from "zod";

import { signalOption } from "../context.js";
import { defineOperation } from "../operation.js";

export const THREAD_THING_ID_HELP = "the other person's thing id, from chat list";

export const chatThreadInput = z.object({
  thing_id: z.number().int().positive().describe(THREAD_THING_ID_HELP),
});

export type ChatThreadInput = z.infer<typeof chatThreadInput>;

export const chatMessageRecord = z.object({
  id: z.number().int(),
  sender_id: z.number().int(),
  recipient_id: z.number().int(),
  message: z.string().nullable(),
  /** Epoch seconds. */
  date_created: z.number().int().nullable(),
  is_read: z.boolean(),
  /** The type is not recorded on the page; shown as sent. */
  meeting_action: z.unknown().nullable(),
});

export type ChatMessageRecord = z.infer<typeof chatMessageRecord>;

export const chatThreadOutput = z.array(chatMessageRecord);

export type ChatThreadOutput = z.infer<typeof chatThreadOutput>;

export const CHAT_THREAD_EMPTY_TEXT = "no messages";

/** The request path for a thing id: `chat/thing/<thing id>`, with no query. */
export function chatThreadPath(thingId: number): string {
  return `chat/thing/${String(thingId)}`;
}

export const chatThread = defineOperation({
  group: "chat",
  verb: "thread",
  kind: "read",
  description: "Show the messages in your thread with one person",
  needsSession: true,
  input: chatThreadInput,
  output: chatThreadOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "chat/thing/<thing id>",
      page: "chat-and-meetings.md",
      section: "Messages in a thread",
    },
  ],
  cli: { positional: ["thing_id"] },
  render: { epochFields: ["date_created"], emptyText: CHAT_THREAD_EMPTY_TEXT },
  run: (ctx, input): Promise<ChatThreadOutput> =>
    ctx.client.get(chatThreadPath(input.thing_id), { schema: chatThreadOutput, ...signalOption(ctx) }),
});
