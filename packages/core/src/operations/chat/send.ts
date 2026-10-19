// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `chat send <thing id> <text> [--dry-run]` (issue #17 § `chat send`): send a chat message to a person the user is
 * connected with, `POST chat/thing/<thing_id>` with `{"message": "<text>", "container_id": <container_id>}`
 * (`docs/api/chat-and-meetings.md` § Send a chat message), the same path `chat thread` reads (§ Messages in a
 * thread), directly under `/1/`. The write runs through the gate and nothing else: the message policy first
 * (`interest/message-policy.ts`, through `ctx.gate.refuse()`; the chat page records no cap, and the same policy is
 * applied so the gate's rules are one set), then `ctx.gate.execute()` with no status read: the chat endpoint is the
 * thread, and a thread exists only between two people who both showed interest (§ Chat threads), so the platform's
 * own refusal of a missing thread is logged as `failed` with the transport's kind. The 200 answer's `message_id` is
 * reported. The repeat guard's key is `(container_id, target_thing_id, "chat.send")`: the tool sends at most one
 * message per person in v1, and the refusal says the conversation continues in the app. An empty text is a usage
 * error on both surfaces (the schema's `min(1)`), before anything.
 */

import { z } from "zod";

import type { WriteResult, WriteSpec } from "../../gate/gate.js";
import { writeResultSchema } from "../../gate/plan.js";
import { containerIdOf, signalOption } from "../context.js";
import { messagePolicyRefusal } from "../interest/message-policy.js";
import { DRY_RUN_HELP, writeExitCode } from "../interest/show.js";
import { defineOperation } from "../operation.js";
import { renderWriteResult } from "../write-result.js";
import { THREAD_THING_ID_HELP, chatThreadPath } from "./thread.js";

export const CHAT_MESSAGE_HELP = "the message text, at most 250 characters";

export const chatSendInput = z.object({
  thing_id: z.number().int().positive().describe(THREAD_THING_ID_HELP),
  message: z.string().min(1).describe(CHAT_MESSAGE_HELP),
  dry_run: z.boolean().default(false).describe(DRY_RUN_HELP),
});

export type ChatSendInput = z.infer<typeof chatSendInput>;

export const chatSendOutput = writeResultSchema.extend({
  message_id: z.number().int().nullable().optional(),
});

export type ChatSendOutput = z.infer<typeof chatSendOutput>;

/** The 200 answer's `data` (`docs/api/chat-and-meetings.md` § Send a chat message); every other key is dropped. */
export const chatSendAnswerSchema = z.object({ message_id: z.number().int() });

/** The outcome line of a sent message, naming the id the platform gave it. */
export function chatSentLine(messageId: number | null | undefined): string {
  return `message ${messageId === null || messageId === undefined ? "null" : String(messageId)}`;
}

export const chatSend = defineOperation({
  group: "chat",
  verb: "send",
  kind: "write",
  description: "Send a chat message to a person you are connected with; this reaches them",
  needsSession: true,
  input: chatSendInput,
  output: chatSendOutput,
  requests: [
    {
      method: "POST",
      pathTemplate: "chat/thing/<thing id>",
      page: "chat-and-meetings.md",
      section: "Send a chat message",
    },
  ],
  cli: { positional: ["thing_id", "message"] },
  render: { human: (output) => renderWriteResult(output, (result) => chatSentLine(result.message_id)) },
  exitCode: writeExitCode,
  async run(ctx, input): Promise<WriteResult> {
    const path = chatThreadPath(input.thing_id);
    const body = { message: input.message, container_id: containerIdOf(ctx) };
    const base: Pick<WriteSpec<unknown>, "kind" | "targetThingId" | "message" | "dryRun" | "request"> = {
      kind: "chat.send",
      targetThingId: input.thing_id,
      message: input.message,
      dryRun: input.dry_run,
      request: { method: "POST", path, body },
    };
    const refusal = messagePolicyRefusal(input.message);
    if (refusal !== null) return ctx.gate.refuse(base, refusal.refusal, refusal.hint);
    return ctx.gate.execute({
      ...base,
      send: () => ctx.client.post(path, body, { schema: chatSendAnswerSchema, ...signalOption(ctx) }),
      resultFields: (answer) => ({ message_id: answer.message_id }),
    });
  },
});
