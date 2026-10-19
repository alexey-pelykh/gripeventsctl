// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `gripeventsctl writes go-ahead <id>` (issue #16 § `writes go-ahead <id>`; `cli_only` in `.mcp-exempt.yaml`): the
 * user's own act at a terminal that records a go-ahead for one proposed write. It refuses with the `usage` kind when
 * stdin or stdout is not a TTY, before anything is read; needs a session (the two reads below need it, and the record
 * belongs to the session's container); reads the proposal, which must be open; reads the event's display name
 * (`docs/api/containers.md` § Config by slug) and the target's name (`docs/api/attendees.md` § The per-person
 * profile), and goes on with the slug or the thing id alone when either read fails, saying so in one line, because the
 * approval never depends on a platform answer; shows the view through the shared renderer; asks for a fresh
 * four-character challenge code, up to three retries after a wrong answer, then exits 2 with nothing appended; on the
 * right code appends `approved` with `source: "cli"` and prints `recorded`, the next step and the expiry. `--json`
 * prints `{ id, approved_at }`. No `--yes` flag, environment variable or piped answer stands in for the typed code.
 */

import {
  NoSessionError,
  UsageError,
  approveGoAhead,
  derivedPaths,
  findOpenProposal,
  goAheadExpiresAt,
  loadConfig,
} from "@gripeventsctl/core";
import type { Command } from "commander";

import { type CliContext, printWorkTreeWarnings, writeErr, writeJson, writeOut } from "../../lib/context.js";
import { askChallenge, showGoAheadView } from "../../lib/go-ahead-view.js";

export const NEEDS_TERMINAL =
  "writes go-ahead needs a terminal on stdin and stdout; run it in a terminal of your own, not through an assistant's shell";

/** One attempt plus three retries. */
export const CHALLENGE_ATTEMPTS = 4;

export const WRONG_CODE = "the code did not match; nothing was recorded";

export const NOT_APPROVED = "the challenge code was not typed; nothing was recorded";

export const NEXT_STEP = "call the tool again with the same thing id and the same text, or run the write again";

/** The display name of the event, or `undefined` where the lookup fails for any reason. */
async function eventName(context: CliContext, slug: string): Promise<string | undefined> {
  try {
    return (await context.client().lookupConfig(slug)).container.general.display_name;
  } catch (error: unknown) {
    writeErr(context, `the event's name could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** The target's name from the per-person profile, or `undefined` where the read fails or the answer carries none. */
async function targetName(context: CliContext, containerId: number, thingId: number): Promise<string | undefined> {
  try {
    const answer = await context.client().get(`container/${String(containerId)}/thing/${String(thingId)}`);
    const name = typeof answer === "object" && answer !== null ? (answer as { name?: unknown }).name : undefined;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch (error: unknown) {
    writeErr(context, `the person's name could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function runGoAhead(context: CliContext, id: string, json: boolean): Promise<void> {
  if (!context.terminal.isStdinTTY() || !context.terminal.isStdoutTTY()) throw new UsageError(NEEDS_TERMINAL);
  const loaded = await loadConfig({ env: context.env, platform: context.platform });
  printWorkTreeWarnings(context, loaded);
  const session = loaded.config.session;
  if (session === undefined) {
    throw new NoSessionError(
      loaded.exists ? `no session in ${loaded.path}` : `no session: no config file at ${loaded.path}`,
    );
  }
  const paths = derivedPaths(loaded.path, loaded.config);
  // The approval is dated to the ask: the two reads below may wait on the clock (the profile-read spacing).
  const askedAt = context.clock.now();
  const record = await findOpenProposal(paths.goAheads, id, context.clock);
  const displayName = await eventName(context, session.slug);
  const name = await targetName(context, record.container_id, record.target_thing_id);
  showGoAheadView(context.terminal, context.stderr, {
    kind: record.kind,
    event: { slug: session.slug, displayName, containerId: record.container_id },
    target: { thingId: record.target_thing_id, name },
    message: record.message ?? "",
    messageSha256: record.message_sha256,
  });
  let typed = false;
  for (let attempt = 1; attempt <= CHALLENGE_ATTEMPTS && !typed; attempt += 1) {
    typed = await askChallenge(context.terminal, "approve");
    if (!typed && attempt < CHALLENGE_ATTEMPTS) writeErr(context, WRONG_CODE);
  }
  if (!typed) throw new UsageError(NOT_APPROVED, "run the command again and type the code shown");
  const approved = await approveGoAhead(paths.goAheads, id, context.clock, { at: askedAt });
  const approvedAt = approved.approved_at ?? askedAt.toISOString();
  if (json) {
    writeJson(context, { id, approved_at: approvedAt });
    return;
  }
  writeOut(context, `recorded: go-ahead ${id} approved at ${approvedAt}`);
  writeOut(context, `next: ${NEXT_STEP}`);
  writeOut(context, `the approval expires at ${goAheadExpiresAt(approved).toISOString()}`);
}

export function registerGoAhead(writes: Command, context: CliContext): void {
  writes
    .command("go-ahead")
    .description("record your go-ahead for one proposed message, at a terminal of your own (CLI only)")
    .argument("<id>", "the id writes pending lists")
    .action(async (id: string, _options: Record<string, never>, command: Command) => {
      const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
      await runGoAhead(context, id, json);
    });
}
