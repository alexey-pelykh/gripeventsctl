// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `gripeventsctl auth signin <slug> [--container-id <n>] [--email <email>]` (issue #7 § Specification).
 *
 * 1. Load the config and print the work-tree warnings.
 * 2. Look the slug up (`GripClient.lookupConfig`); an unknown slug is an error, exit 1.
 * 3. The container id: `--container-id` wins; else `data.container.general.container_id` of the
 *    answer; neither is the `usage` kind, exit 2, saying where the id comes from.
 * 4. The credentials: the `auth.credentials` 1Password item, else `--email` or a visible prompt and
 *    a hidden prompt for the password, which need a terminal. There is no `--password` option, and
 *    the password is never read from an argument or an environment variable.
 * 5. One login call; the password and the `Basic` value are registered as secrets and go out of
 *    scope after it. No field, closure or log keeps them.
 * 6. Store the session; where `session.token` is an `op://` field reference, the token goes into
 *    that field through `op item edit` and the reference stays in the file.
 * 7. Print the result; never a token, the application token, the chat token, the password or the
 *    `Basic` value.
 */

import { GripClient, type LoadResult, UsageError, loadConfig, saveSession } from "@gripeventsctl/core";
import type { Command } from "commander";
import { z } from "zod";

import { type CliContext, printWorkTreeWarnings, writeJson, writeOut } from "../../lib/context.js";
import { readOpCredentials, writeOpToken } from "../../lib/op-credentials.js";

const OP_REFERENCE_PREFIX = "op://";

/** The hint of a lookup answer without the container id and no `--container-id`. */
export const CONTAINER_ID_MISSING_MESSAGE =
  "this event's config does not name its container id; pass `--container-id <n>` (the id is the number the event organiser or the platform shows for the event; for the 2026 World Summit AI edition it is printed on `docs/api/login.md`)";

/** The message of a prompt that cannot be shown. */
export const NO_TERMINAL_MESSAGE =
  "no terminal for a prompt; pass `--email` and set `auth.credentials` to a 1Password item, or run in a terminal";

export const NEXT_STEP_LINE = "next: `gripeventsctl events list` or `gripeventsctl attendees list --type <ids>`";

const positiveInteger = z.coerce.number().int().positive();

/** `--container-id <n>` as a positive integer, or the `usage` kind. */
export function parseContainerId(value: string): number {
  const parsed = positiveInteger.safeParse(value.trim() === "" ? Number.NaN : value);
  if (!parsed.success) {
    throw new UsageError(`--container-id must be a positive integer, not ${JSON.stringify(value)}`);
  }
  return parsed.data;
}

export interface SigninOptions {
  containerId?: string;
  email?: string;
}

interface Credentials {
  email: string;
  password: string;
}

/**
 * Refuse, before any request is sent, a sign-in that would need a prompt with no terminal to show it
 * on: no `auth.credentials` item and no TTY on stdin or stdout. `--email` alone does not help: the
 * password still needs the hidden prompt.
 */
function requireTerminalForPrompts(context: CliContext, loaded: LoadResult): void {
  if (loaded.config.auth?.credentials !== undefined) return;
  if (!context.terminal.isStdinTTY() || !context.terminal.isStdoutTTY()) throw new UsageError(NO_TERMINAL_MESSAGE);
}

/** Where the credentials come from: the 1Password item, or the terminal. */
async function obtainCredentials(
  context: CliContext,
  loaded: LoadResult,
  options: SigninOptions,
): Promise<Credentials> {
  const reference = loaded.config.auth?.credentials;
  if (reference !== undefined) {
    const fromOp = await readOpCredentials(reference, { env: context.env });
    return { email: options.email ?? fromOp.email, password: fromOp.password };
  }
  const { terminal } = context;
  const email = options.email ?? (await terminal.prompt("email"));
  if (email.trim() === "") throw new UsageError("the email is empty");
  const password = await terminal.promptHidden("password");
  if (password === "") throw new UsageError("the password is empty");
  return { email: email.trim(), password };
}

export async function runSignin(
  context: CliContext,
  slug: string,
  options: SigninOptions,
  json: boolean,
): Promise<void> {
  const loaded = await loadConfig({ env: context.env, platform: context.platform });
  printWorkTreeWarnings(context, loaded);
  requireTerminalForPrompts(context, loaded);

  const client = new GripClient({
    ...(context.dispatcher === undefined ? {} : { dispatcher: context.dispatcher }),
    clock: context.clock,
    env: context.env,
    stderr: context.stderr,
  });
  const lookup = await client.lookupConfig(slug);

  let containerId: number;
  let source: string;
  if (options.containerId !== undefined) {
    containerId = parseContainerId(options.containerId);
    source = "--container-id";
  } else if (lookup.container.general.container_id !== undefined) {
    containerId = lookup.container.general.container_id;
    source = "the event config";
  } else {
    throw new UsageError(CONTAINER_ID_MISSING_MESSAGE);
  }

  const credentials = await obtainCredentials(context, loaded, options);
  // The one login call; `login()` registers the password and builds the `Basic` value for this request only.
  const { userToken } = await client.login({
    applicationToken: lookup.application.general.token,
    containerId,
    email: credentials.email,
    password: credentials.password,
    slug,
  });

  const previous = loaded.config.session;
  const tokenField = previous?.token.startsWith(OP_REFERENCE_PREFIX) === true ? previous.token : undefined;
  if (tokenField !== undefined) await writeOpToken(tokenField, userToken, { env: context.env });
  await saveSession(
    { slug, container_id: containerId, token: tokenField ?? userToken },
    { env: context.env, platform: context.platform, clock: context.clock },
  );
  const stored = (await loadConfig({ env: context.env, platform: context.platform })).config.session;
  const signedInAt = stored?.signed_in_at ?? "";

  if (json) {
    writeJson(context, { slug, container_id: containerId, signed_in_at: signedInAt });
    return;
  }
  if (previous !== undefined && previous.slug !== slug) writeOut(context, `replaced the session for ${previous.slug}`);
  const displayName = lookup.container.general.display_name || lookup.container.general.name;
  writeOut(
    context,
    `signed in to ${displayName} (${slug}, container ${String(containerId)}, container id from ${source})`,
  );
  writeOut(context, NEXT_STEP_LINE);
}

export function registerSignin(auth: Command, context: CliContext): void {
  auth
    .command("signin")
    .description("sign in to one event and store the session")
    .argument("<slug>", "the event's slug: the last part of https://matchmaking.grip.events/<slug>")
    .option("--container-id <n>", "the container id, overriding the event config's")
    .option("--email <email>", "the attendee's email; prompted for otherwise")
    .action(async (slug: string, options: SigninOptions, command: Command) => {
      const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
      await runSignin(context, slug, options, json);
    });
}
