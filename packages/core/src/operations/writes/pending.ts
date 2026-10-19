// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `writes pending` (issue #16 § `writes pending`): every journal record whose latest event is `proposed` and
 * unexpired, any container, oldest first, with the id the user types back, the kind, the target, the text and the
 * proposal time. No session is needed and no platform call is made. The human form is a table, the message column
 * escaped by the output module, followed by the note naming the approval command; `--json` is the bare array and the
 * MCP twin wraps it in `{ items }`. The text is raw in `--json`: the SHA-256 is over the text exactly as received, so
 * a copy with a trailing space does not match one without.
 */

import { z } from "zod";

import { derivedPaths } from "../../config/paths.js";
import { foldJournal, pendingProposals, readJournal } from "../../gate/go-ahead.js";
import { defineOperation } from "../operation.js";
import { LOCAL_STATE_POSTURE } from "./status.js";

export const writesPendingInput = z.object({});

export const writesPendingOutput = z.array(
  z.object({
    id: z.string(),
    kind: z.string(),
    target_thing_id: z.number().int(),
    message: z.string(),
    proposed_at: z.string(),
  }),
);

export type WritesPendingOutput = z.infer<typeof writesPendingOutput>;

export const PENDING_EMPTY_TEXT = "no go-aheads pending";

export const PENDING_NOTE = "Approve one with gripeventsctl writes go-ahead <id> in a terminal.";

export const writesPending = defineOperation({
  group: "writes",
  verb: "pending",
  kind: "read",
  description: "List the proposed go-aheads that await approval in a terminal",
  needsSession: false,
  input: writesPendingInput,
  output: writesPendingOutput,
  requests: [],
  mcp: { descriptionPosture: LOCAL_STATE_POSTURE },
  render: { emptyText: PENDING_EMPTY_TEXT, note: PENDING_NOTE },
  async run(ctx): Promise<WritesPendingOutput> {
    const paths = derivedPaths(ctx.config.path, ctx.config.config);
    const pending = pendingProposals(foldJournal(await readJournal(paths.goAheads, ctx.stderr)), ctx.clock.now());
    return pending.map((record) => ({
      id: record.id,
      kind: record.kind,
      target_thing_id: record.target_thing_id,
      message: record.message ?? "",
      proposed_at: record.proposed_at,
    }));
  },
});
