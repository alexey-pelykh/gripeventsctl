// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The two 1Password CLI calls the sign-in command makes, through the argument builders and the child
 * environment of `@gripeventsctl/core` (`config/op.ts`): an argument array, no shell, the `OP_*`
 * variables passed through, every call bounded by a timeout.
 *
 * - `readOpCredentials(reference)`: `op item get <item> --vault <vault> --format json --fields
 *   label=username,label=password` for the `auth.credentials` item reference. Each value is
 *   registered as a secret before any other use.
 * - `writeOpToken(reference, token)`: `op item edit <item> --vault <vault> --format json` for the
 *   item of a `session.token` field reference, with a JSON template holding the one field on stdin.
 *   The token never travels as an argument: an argument sits in the process list while `op` runs.
 *   Whether a template reduced to the one changed field leaves the item's other fields unchanged is
 *   not documented by 1Password and is not verified by a live run (see the pull request of issue #7).
 *
 * A missing `op` binary, a non-zero exit and a child still running after the timeout are the
 * `config` kind, exit 8; there is no fallback. `op` stdout is never printed; `op` stderr passes
 * through `redactString` before it reaches a message.
 */

import {
  type ExecException,
  type ExecFileOptionsWithStringEncoding,
  execFile as nodeExecFile,
} from "node:child_process";

import {
  ConfigError,
  type ExecFileLike,
  OP_NOT_FOUND_MESSAGE,
  opEnvironment,
  opItemEditArgs,
  opItemGetArgs,
  redactString,
  registerSecret,
  validateOpReference,
} from "@gripeventsctl/core";

/** The most an `op` call may take, the bound `opRead()` applies in core; a child still running after it is killed. */
export const OP_TIMEOUT_MS = 120_000;

export const USERNAME_LABEL = "username";
export const PASSWORD_LABEL = "password";

export interface OpOptions {
  /** The environment whose `OP_*` variables reach the 1Password CLI; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Testing seam: the `execFile` the call runs through. */
  execFile?: ExecFileLike;
}

export interface OpCredentials {
  email: string;
  password: string;
}

interface OpRun {
  error: ExecException | null;
  stdout: string;
  stderr: string;
}

/** Run `op` with `args`, writing `input` to its stdin where given; the raw outcome, not yet judged. */
function runOp(args: readonly string[], input: string | undefined, options: OpOptions): Promise<OpRun> {
  const run = options.execFile ?? nodeExecFile;
  const execOptions: ExecFileOptionsWithStringEncoding = {
    env: opEnvironment(options.env ?? process.env),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    timeout: OP_TIMEOUT_MS,
    // SIGKILL, as core's `opRead()`: a child that ignores SIGTERM would keep the call waiting.
    killSignal: "SIGKILL",
  };
  return new Promise<OpRun>((resolve) => {
    const child = run("op", args, execOptions, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** Throw the `config` error a failed `op` run maps to; return where the run succeeded. */
function refuseFailure(run: OpRun, what: string): void {
  if (run.error === null) return;
  if (run.error.code === "ENOENT") {
    throw new ConfigError(
      OP_NOT_FOUND_MESSAGE,
      "install the 1Password CLI, or remove the op:// reference from the config file",
    );
  }
  if (run.error.killed) {
    throw new ConfigError(
      `1Password CLI (\`op\`) did not answer within ${String(OP_TIMEOUT_MS / 1000)} s while ${what}`,
      "check that the 1Password CLI is signed in (`op signin`) and waits on no prompt",
    );
  }
  const exit = typeof run.error.code === "number" ? ` (exit ${String(run.error.code)})` : "";
  const detail = redactString(run.stderr.trim());
  throw new ConfigError(
    `1Password CLI failed while ${what}${exit}${detail === "" ? "" : `: ${detail}`}`,
    "check the reference and that the 1Password CLI is signed in (`op signin`)",
  );
}

/**
 * The `label` and `value` of each field object `op item get --fields --format json` prints: an array
 * for several fields, a single object for one. Each `value` is registered as a secret as it is read.
 */
function fieldValues(stdout: string, reference: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ConfigError(
      `1Password CLI printed something other than JSON for ${reference}`,
      "check that the 1Password CLI is signed in (`op signin`) and that the item exists",
    );
  }
  const values = new Map<string, string>();
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record["label"] === "string" ? record["label"] : record["id"];
    const value = record["value"];
    if (typeof label !== "string" || typeof value !== "string") continue;
    registerSecret(value);
    values.set(label, value);
  }
  return values;
}

/**
 * The `username` and `password` fields of the item `reference` names (`auth.credentials`, an
 * `op://<vault>/<item>` reference). Both values are registered as secrets before they are returned.
 */
export async function readOpCredentials(reference: string, options: OpOptions = {}): Promise<OpCredentials> {
  const args = opItemGetArgs(reference, { fields: [USERNAME_LABEL, PASSWORD_LABEL] });
  const run = await runOp(args, undefined, options);
  // The whole of stdout holds the two values: registered before anything else reads it.
  registerSecret(run.stdout.trim());
  refuseFailure(run, `reading ${reference}`);
  const values = fieldValues(run.stdout, reference);
  const email = values.get(USERNAME_LABEL);
  const password = values.get(PASSWORD_LABEL);
  if (email === undefined || email === "" || password === undefined || password === "") {
    throw new ConfigError(
      `the 1Password item ${reference} does not hold both a ${USERNAME_LABEL} and a ${PASSWORD_LABEL} field`,
      `give the item a ${USERNAME_LABEL} field holding the email and a ${PASSWORD_LABEL} field holding the password`,
    );
  }
  return { email, password };
}

/** The `op://<vault>/<item>` item reference of a field reference. */
export function itemReferenceOf(fieldReference: string): string {
  const parsed = validateOpReference(fieldReference, "field");
  return `op://${parsed.vault}/${parsed.item}`;
}

/**
 * The JSON template `op item edit` reads from stdin: the one field the reference names, with its
 * section where the reference carries one, and the `CONCEALED` type so a field `op` creates is hidden.
 */
export function opTokenTemplate(fieldReference: string, token: string): string {
  const parsed = validateOpReference(fieldReference, "field");
  const field: Record<string, unknown> = { label: parsed.field, type: "CONCEALED", value: token };
  if (parsed.section !== undefined) field["section"] = { label: parsed.section };
  return JSON.stringify({ fields: [field] });
}

/**
 * Write `token` into the field `reference` names (`session.token`, an `op://<vault>/<item>[/<section>]/<field>`
 * reference) through `op item edit` with the template on stdin. The argument array holds no token.
 */
export async function writeOpToken(reference: string, token: string, options: OpOptions = {}): Promise<void> {
  registerSecret(token);
  const args = [...opItemEditArgs(itemReferenceOf(reference), {}), "--format", "json"];
  const run = await runOp(args, opTokenTemplate(reference, token), options);
  // `op item edit --format json` prints the edited item, the token included: never read, registered whole.
  registerSecret(run.stdout.trim());
  refuseFailure(run, `writing the session token to ${reference}`);
}
