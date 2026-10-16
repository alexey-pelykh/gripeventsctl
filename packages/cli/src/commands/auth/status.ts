// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `gripeventsctl auth status` (issue #7 § Specification): read the config only. No platform call, and
 * an `op://` token is never resolved. Reports the slug, the container id, the sign-in time and the
 * first authentication failure where one is recorded, never a token fragment: not the first or last
 * characters, not a length. Names the config path; on Windows adds the user-profile-permissions
 * notice; with `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment warns on stderr.
 */

import { loadConfig } from "@gripeventsctl/core";
import type { Command } from "commander";

import { type CliContext, printWorkTreeWarnings, writeErr, writeJson, writeOut } from "../../lib/context.js";

export const WINDOWS_MODE_NOTICE =
  "the config file inherits your user profile's permissions; this tool cannot set mode 0600 here";

export const TLS_WARNING =
  "warning: NODE_TLS_REJECT_UNAUTHORIZED=0 is set, which disables TLS verification for every Node process; this tool does not need it";

export async function runStatus(context: CliContext, json: boolean): Promise<void> {
  const loaded = await loadConfig({ env: context.env, platform: context.platform });
  printWorkTreeWarnings(context, loaded);
  if (context.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") writeErr(context, TLS_WARNING);
  const session = loaded.config.session;
  if (json) {
    writeJson(context, {
      session:
        session === undefined
          ? null
          : {
              slug: session.slug,
              container_id: session.container_id,
              signed_in_at: session.signed_in_at,
              auth_failed_at: session.auth_failed_at ?? null,
            },
    });
    return;
  }
  if (session === undefined) {
    writeOut(context, "no session");
  } else {
    writeOut(
      context,
      `signed in to ${session.slug} (container ${String(session.container_id)}) at ${session.signed_in_at}`,
    );
    if (session.auth_failed_at !== undefined) {
      writeOut(
        context,
        `authentication failed at ${session.auth_failed_at}; run \`gripeventsctl auth signin ${session.slug}\``,
      );
    }
  }
  writeOut(context, `config: ${loaded.path}`);
  if (context.platform === "win32") writeOut(context, WINDOWS_MODE_NOTICE);
}

export function registerStatus(auth: Command, context: CliContext): void {
  auth
    .command("status")
    .description("show the stored session; no platform call")
    .action(async (_options: Record<string, never>, command: Command) => {
      const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
      await runStatus(context, json);
    });
}
