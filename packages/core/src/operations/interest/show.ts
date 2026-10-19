// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `interest show <thing id> [--message <text>] [--dry-run]` (issue #17 § `interest show`): show interest in a
 * person, with an optional intro message. The write runs through the gate and nothing else: the message policy
 * first where a text is given (`message-policy.ts`, through `ctx.gate.refuse()`), then `ctx.gate.execute()` with the
 * status read of `match status` (issue #12; `docs/api/interest.md` § Check the state first) and `has_match_none` as
 * the one allowed status, and `POST container/<container_id>/thing/user_id/match_manual/yes/to_thing/<thing_id>` with
 * the body `{"message": "<text>"}`, `""` where no text was given and never `{}` (§ Send an answer, § The message:
 * what the app sends from a profile card with no text). The 201 answer's `connection` is reported: `1` when the
 * answer made a mutual connection (§ Response). The path segment `match_manual/yes` is a constant: `superyes` and
 * the plain `match` segment are never built, and no `?source=` query is sent. Without `--message` the spec's
 * `message` is `null`, so the gate asks for no go-ahead while the body still carries the empty text. The 250-code-point
 * cap is this operation's own check, not a schema bound: an over-long text is a refusal on both surfaces, never a
 * usage error. The `statusHint` sentence, appended to a `status-not-none` refusal where a text was given, says that
 * the app edits an intro message by sending `yes` again and this tool does not (a re-send is refused in v1).
 */

import { z } from "zod";

import type { WriteResult, WriteSpec } from "../../gate/gate.js";
import { writeResultSchema } from "../../gate/plan.js";
import { containerIdOf, signalOption } from "../context.js";
import { THING_ID_HELP } from "../match/status.js";
import { defineOperation } from "../operation.js";
import { renderWriteResult } from "../write-result.js";
import { ALLOWED_STATUS, type MatchAnswer, matchAnswerPath, matchAnswerSchema, readMatchStatus } from "./answer.js";
import { messagePolicyRefusal } from "./message-policy.js";

/** The answer this operation sends, a constant: never `superyes`, never `no`. */
export const SHOW_ANSWER: MatchAnswer = "yes";

export const MESSAGE_HELP = "an intro message of at most 250 characters";

export const DRY_RUN_HELP = "show the plan and send nothing";

/** Appended to a status-not-none refusal where a text was given (issue #17 § `interest show`). */
export const SHOW_STATUS_HINT =
  "the app edits an intro message by sending yes again with the new text; this tool does not";

export const interestShowInput = z.object({
  thing_id: z.number().int().positive().describe(THING_ID_HELP),
  message: z.string().optional().describe(MESSAGE_HELP),
  dry_run: z.boolean().default(false).describe(DRY_RUN_HELP),
});

export type InterestShowInput = z.infer<typeof interestShowInput>;

export const interestShowOutput = writeResultSchema.extend({
  connection: z.number().int().nullable().optional(),
});

export type InterestShowOutput = z.infer<typeof interestShowOutput>;

/** The outcome line of a sent answer: whether it made a mutual connection. */
export function interestSentLine(connection: number | null | undefined): string {
  return connection === 1 ? "interest shown; mutual connection" : "interest shown";
}

/** The CLI exit code of a completed write: 4 where the gate refused it, 0 otherwise. */
export function writeExitCode(output: { outcome: string }): number {
  return output.outcome === "refused" ? 4 : 0;
}

export const interestShow = defineOperation({
  group: "interest",
  verb: "show",
  kind: "write",
  description:
    "Show interest in a person, with an optional intro message of at most 250 characters; this notifies them",
  needsSession: true,
  input: interestShowInput,
  output: interestShowOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "container/<id>/thing/user_id/match/<thing id>/status",
      page: "interest.md",
      section: "Check the state first",
    },
    {
      method: "POST",
      pathTemplate: "container/<id>/thing/user_id/match_manual/yes/to_thing/<thing id>",
      page: "interest.md",
      section: "Send an answer",
    },
  ],
  cli: { positional: ["thing_id"] },
  render: { human: (output) => renderWriteResult(output, (result) => interestSentLine(result.connection)) },
  exitCode: writeExitCode,
  async run(ctx, input): Promise<WriteResult> {
    const path = matchAnswerPath(containerIdOf(ctx), SHOW_ANSWER, input.thing_id);
    const body = { message: input.message ?? "" };
    const base: Pick<WriteSpec<unknown>, "kind" | "targetThingId" | "message" | "dryRun" | "request"> = {
      kind: "interest.show",
      targetThingId: input.thing_id,
      message: input.message ?? null,
      dryRun: input.dry_run,
      request: { method: "POST", path, body },
    };
    if (input.message !== undefined) {
      const refusal = messagePolicyRefusal(input.message);
      if (refusal !== null) return ctx.gate.refuse(base, refusal.refusal, refusal.hint);
    }
    return ctx.gate.execute({
      ...base,
      ...(input.message === undefined ? {} : { statusHint: SHOW_STATUS_HINT }),
      readStatus: () => readMatchStatus(ctx, input.thing_id),
      allowedStatus: ALLOWED_STATUS,
      send: () => ctx.client.post(path, body, { schema: matchAnswerSchema, ...signalOption(ctx) }),
      resultFields: (answer) => ({ connection: answer.connection }),
    });
  },
});
