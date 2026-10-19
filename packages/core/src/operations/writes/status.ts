// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `writes status` (issue #16 § `writes status`): whether writes are enabled, where the send log is, how many
 * go-aheads await approval, and which config file was read. No session is needed and no platform call is made: the
 * switch is read from the config, the paths derive from its path, and the count is the fold of the journal, counting
 * the records whose latest event is `proposed` and unexpired on the clock. The human form's first line reads
 * `writes: safe mode` or `writes: writes enabled`, word for word; `--json` is the object. The MCP twin carries the
 * posture sentence of a tool that reads its own local state.
 */

import { z } from "zod";

import { derivedPaths } from "../../config/paths.js";
import { foldJournal, pendingProposals, readJournal } from "../../gate/go-ahead.js";
import { defineOperation } from "../operation.js";

/** The posture sentence of the two `writes` reads: local state, no platform call. */
export const LOCAL_STATE_POSTURE = "It reads the tool's own local state and makes no platform call.";

export const writesStatusInput = z.object({});

export const writesStatusOutput = z.object({
  writes_enabled: z.boolean(),
  send_log: z.string(),
  go_aheads_pending: z.number().int().min(0),
  config_path: z.string(),
});

export type WritesStatusOutput = z.infer<typeof writesStatusOutput>;

/** The first line of the human form: the write state in the fixed vocabulary. */
export function writesLine(enabled: boolean): string {
  return `writes: ${enabled ? "writes enabled" : "safe mode"}`;
}

export const writesStatus = defineOperation({
  group: "writes",
  verb: "status",
  kind: "read",
  description: "Show whether writes are enabled, where the send log is, and how many go-aheads await approval",
  needsSession: false,
  input: writesStatusInput,
  output: writesStatusOutput,
  requests: [],
  mcp: { descriptionPosture: LOCAL_STATE_POSTURE },
  render: {
    human: (output) =>
      [
        writesLine(output.writes_enabled),
        `send_log: ${output.send_log}`,
        `go_aheads_pending: ${String(output.go_aheads_pending)}`,
        `config_path: ${output.config_path}`,
      ].join("\n"),
  },
  async run(ctx): Promise<WritesStatusOutput> {
    const paths = derivedPaths(ctx.config.path, ctx.config.config);
    const pending = pendingProposals(foldJournal(await readJournal(paths.goAheads, ctx.stderr)), ctx.clock.now());
    return {
      writes_enabled: ctx.config.config.writes.enabled,
      send_log: paths.sendLog,
      go_aheads_pending: pending.length,
      config_path: ctx.config.path,
    };
  },
});
