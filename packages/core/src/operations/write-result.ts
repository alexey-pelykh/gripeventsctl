// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The human form of a write result, shared by the three gated writes (issue #17 § `interest show`, § `interest
 * skip`, § `chat send`): the plan as key-value lines (the kind, the target thing id, the status before, the request
 * as `POST <path>` with the body as compact JSON, and the four verdicts), then one outcome line: `sent: <what the
 * operation says>`, `refused: <refusal>` with `hint: <hint>` on the next line and the proposal's id and expiry where
 * the refusal left one, or `dry run: nothing sent`. A failed POST never reaches this rendering: the gate re-raises
 * the transport's error. The output module escapes and redacts the text like every other human form; `--json` and
 * `structuredContent` never use it.
 */

import type { z } from "zod";

import type { writeResultSchema } from "../gate/plan.js";

/** The validated write result, as the output schema of a write infers it. */
export type WriteResultOutput = z.infer<typeof writeResultSchema>;

export const DRY_RUN_LINE = "dry run: nothing sent";

/** The plan as key-value lines, in the order the plan holds its fields. */
export function writePlanLines(plan: WriteResultOutput["plan"]): string[] {
  return [
    `kind: ${plan.kind}`,
    `target thing id: ${String(plan.target_thing_id)}`,
    `status before: ${plan.status_before ?? "null"}`,
    `request: ${plan.request.method} ${plan.request.path}`,
    `body: ${JSON.stringify(plan.request.body)}`,
    `writes enabled: ${String(plan.verdicts.writes_enabled)}`,
    `repeat guard: ${plan.verdicts.repeat_guard}`,
    `status: ${plan.verdicts.status}`,
    `go-ahead: ${plan.verdicts.go_ahead}`,
  ];
}

/** The outcome line, or lines: `sent` with the operation's own words, `refused` with its hint, or the dry run. */
export function writeOutcomeLines(result: WriteResultOutput, sent: string): string[] {
  switch (result.outcome) {
    case "sent":
      return [`sent: ${sent}`];
    case "dry-run":
      return [DRY_RUN_LINE];
    case "refused": {
      const lines = [`refused: ${result.refusal ?? ""}`];
      if (result.hint !== undefined && result.hint !== "") lines.push(`hint: ${result.hint}`);
      if (result.go_ahead_id !== undefined) {
        lines.push(`go-ahead id: ${result.go_ahead_id}, expires ${result.go_ahead_expires_at ?? ""}`);
      }
      return lines;
    }
    case "failed":
      // Unreachable through the gate, which re-raises a failed POST; the output schema still names the outcome.
      return ["failed: the request was not answered as documented"];
  }
}

/** The plan lines, then the outcome lines, joined with line breaks. */
export function renderWriteResult(result: WriteResultOutput, sent: (result: WriteResultOutput) => string): string {
  return [...writePlanLines(result.plan), ...writeOutcomeLines(result, sent(result))].join("\n");
}
