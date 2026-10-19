// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `interest skip <thing id> [--dry-run]` (issue #17 § `interest skip`): record a `no` answer about a person. The
 * write runs through `ctx.gate.execute()` and nothing else, with the status read of `match status` (issue #12;
 * `docs/api/interest.md` § Check the state first) and `has_match_none` as the one allowed status, and
 * `POST container/<container_id>/thing/user_id/match_manual/no/to_thing/<thing_id>` with the body `{}`: the skip
 * carries no text, as the app sends from the screens that have no message box (§ The message), and no message input
 * exists on either surface. The spec's `message` is `null`, so the gate asks for no go-ahead. The `no` answer is
 * from the app code and not verified live as a POST (§ Send an answer; `docs/api/not-verified.md` § Match answers):
 * the first live send, on the maintainer's go-ahead, dates the row; until then the module stays as the page records
 * the shape, and the maintainer may hold it out of the registry.
 */

import { z } from "zod";

import type { WriteResult } from "../../gate/gate.js";
import { writeResultSchema } from "../../gate/plan.js";
import { containerIdOf, signalOption } from "../context.js";
import { THING_ID_HELP } from "../match/status.js";
import { defineOperation } from "../operation.js";
import { renderWriteResult } from "../write-result.js";
import { ALLOWED_STATUS, type MatchAnswer, matchAnswerPath, matchAnswerSchema, readMatchStatus } from "./answer.js";
import { DRY_RUN_HELP, writeExitCode } from "./show.js";

/** The answer this operation sends, a constant: never `yes`, never `superyes`. */
export const SKIP_ANSWER: MatchAnswer = "no";

export const SKIP_SENT_LINE = "person skipped";

export const interestSkipInput = z.object({
  thing_id: z.number().int().positive().describe(THING_ID_HELP),
  dry_run: z.boolean().default(false).describe(DRY_RUN_HELP),
});

export type InterestSkipInput = z.infer<typeof interestSkipInput>;

export const interestSkipOutput = writeResultSchema;

export type InterestSkipOutput = z.infer<typeof interestSkipOutput>;

export const interestSkip = defineOperation({
  group: "interest",
  verb: "skip",
  kind: "write",
  description: "Skip a person: record a no answer about them",
  needsSession: true,
  input: interestSkipInput,
  output: interestSkipOutput,
  requests: [
    {
      method: "GET",
      pathTemplate: "container/<id>/thing/user_id/match/<thing id>/status",
      page: "interest.md",
      section: "Check the state first",
    },
    {
      method: "POST",
      pathTemplate: "container/<id>/thing/user_id/match_manual/no/to_thing/<thing id>",
      page: "interest.md",
      section: "Send an answer",
    },
  ],
  cli: { positional: ["thing_id"] },
  render: { human: (output) => renderWriteResult(output, () => SKIP_SENT_LINE) },
  exitCode: writeExitCode,
  run(ctx, input): Promise<WriteResult> {
    const path = matchAnswerPath(containerIdOf(ctx), SKIP_ANSWER, input.thing_id);
    const body = {};
    return ctx.gate.execute({
      kind: "interest.skip",
      targetThingId: input.thing_id,
      message: null,
      dryRun: input.dry_run,
      request: { method: "POST", path, body },
      readStatus: () => readMatchStatus(ctx, input.thing_id),
      allowedStatus: ALLOWED_STATUS,
      send: () => ctx.client.post(path, body, { schema: matchAnswerSchema, ...signalOption(ctx) }),
      resultFields: () => ({}),
    });
  },
});
