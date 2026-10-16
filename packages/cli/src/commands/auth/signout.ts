// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `gripeventsctl auth signout` (issue #7 § Specification): remove `session` from the config; `writes`
 * and `auth.credentials` stay. No platform call: no logout endpoint is documented. Without a session
 * the command says so and exits 0.
 */

import { clearSession, loadConfig } from "@gripeventsctl/core";
import type { Command } from "commander";

import { type CliContext, printWorkTreeWarnings, writeJson, writeOut } from "../../lib/context.js";

export async function runSignout(context: CliContext, json: boolean): Promise<void> {
  const loaded = await loadConfig({ env: context.env, platform: context.platform });
  printWorkTreeWarnings(context, loaded);
  const signedOut = loaded.config.session !== undefined;
  if (signedOut) await clearSession({ env: context.env, platform: context.platform });
  if (json) {
    writeJson(context, { signed_out: signedOut });
    return;
  }
  writeOut(context, signedOut ? "signed out" : "no session");
}

export function registerSignout(auth: Command, context: CliContext): void {
  auth
    .command("signout")
    .description("remove the stored session")
    .action(async (_options: Record<string, never>, command: Command) => {
      const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
      await runSignout(context, json);
    });
}
