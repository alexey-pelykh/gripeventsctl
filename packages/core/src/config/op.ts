// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The 1Password CLI (`op`) rules: reference validation, the argument builders, the child
 * environment, and `opRead()`. Every call runs through `child_process.execFile` with an argument
 * array and no shell. A reference is accepted only in the two documented forms, with each segment
 * made of letters, digits, space, `-`, `_` and `.`, and is rejected before any process is spawned.
 * `op` stdout is registered as a secret before any other use; `op` stderr passes through
 * `redactString` before it is shown. The auth item reuses the `op item get` and `op item edit`
 * argument builders; this module makes no such call.
 */

import {
  type ChildProcess,
  type ExecException,
  type ExecFileOptionsWithStringEncoding,
  execFile as nodeExecFile,
} from "node:child_process";

import { REDACTED, UUID_PATTERN_SOURCE, redactString, registerSecret } from "../lib/redact.js";
import { ConfigError } from "../transport/errors.js";

/** The characters one segment of an `op://` reference, a field label or a field value may hold. */
const SEGMENT_SOURCE = String.raw`[A-Za-z0-9 ._-]+`;
const SEGMENT = new RegExp(`^${SEGMENT_SOURCE}$`);
const REFERENCE = new RegExp(
  `^op://(${SEGMENT_SOURCE})/(${SEGMENT_SOURCE})(?:/(${SEGMENT_SOURCE}))?(?:/(${SEGMENT_SOURCE}))?$`,
);

export const OP_REFERENCE_PREFIX = "op://";

/**
 * A parsed `op://` reference: `op://<vault>/<item>` names an item,
 * `op://<vault>/<item>[/<section>]/<field>` a field.
 */
export interface OpReference {
  reference: string;
  kind: "item" | "field";
  vault: string;
  item: string;
  section?: string;
  field?: string;
}

/** Parse a reference; `undefined` when it is not of one of the two accepted forms. */
export function parseOpReference(reference: string): OpReference | undefined {
  const match = REFERENCE.exec(reference);
  if (match === null) return undefined;
  const [, vault, item, third, fourth] = match;
  if (vault === undefined || item === undefined) return undefined;
  if (third === undefined) return { reference, kind: "item", vault, item };
  if (fourth === undefined) return { reference, kind: "field", vault, item, field: third };
  return { reference, kind: "field", vault, item, section: third, field: fourth };
}

export function isItemReference(reference: string): boolean {
  return parseOpReference(reference)?.kind === "item";
}

export function isFieldReference(reference: string): boolean {
  return parseOpReference(reference)?.kind === "field";
}

/** Parse a reference of the expected kind, or refuse with the `config` kind before anything is spawned. */
export function validateOpReference(reference: string, kind: OpReference["kind"]): OpReference {
  const parsed = parseOpReference(reference);
  const expected =
    kind === "item" ? "op://<vault>/<item>" : "op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>";
  if (parsed === undefined) {
    throw new ConfigError(
      `invalid 1Password reference ${JSON.stringify(reference)}: expected ${expected}, with each segment made of letters, digits, space, "-", "_" and "."`,
      "fix the reference in the config file",
    );
  }
  if (parsed.kind !== kind) {
    throw new ConfigError(
      `invalid 1Password reference ${JSON.stringify(reference)}: expected ${expected}`,
      "fix the reference in the config file",
    );
  }
  return parsed;
}

const PLATFORM_MINIMUM_ENV = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "LANG"]);

/**
 * The environment an `op` child inherits: the `OP_*` variables of `env` (the service account
 * token, the Connect host, the session variables, whatever 1Password reads), `PATH`, and the
 * platform's minimum (`HOME`, `USERPROFILE`, `SYSTEMROOT`, `TMPDIR`, `LANG`, `LC_*`). Nothing else.
 * The `OP_` and `LC_` prefixes match as written; the platform names match in any letter case,
 * because Windows spells them `Path` and `SystemRoot`.
 */
export function opEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name.startsWith("OP_") || name.startsWith("LC_") || PLATFORM_MINIMUM_ENV.has(name.toUpperCase())) {
      child[name] = value;
    }
  }
  return child;
}

/** `op read <reference>`. */
export function opReadArgs(reference: string): string[] {
  const parsed = validateOpReference(reference, "field");
  return ["read", parsed.reference];
}

function validateLabel(label: string, what: string): string {
  if (!SEGMENT.test(label)) {
    throw new ConfigError(
      `invalid 1Password ${what} ${JSON.stringify(label)}: letters, digits, space, "-", "_" and "." only`,
    );
  }
  return positional(label, what);
}

/** A value that `op` reads as a positional argument or an assignment must not look like a flag. */
function positional(value: string, what: string): string {
  if (value.startsWith("-")) {
    throw new ConfigError(`invalid 1Password ${what} ${JSON.stringify(value)}: it must not start with "-"`);
  }
  return value;
}

/**
 * `op item get <item> --vault <vault> --format json [--fields label=<a>,label=<b>]`, for an item
 * reference. The auth item reads `username` and `password` with it.
 */
export function opItemGetArgs(reference: string, options: { fields?: readonly string[] } = {}): string[] {
  const parsed = validateOpReference(reference, "item");
  const args = ["item", "get", positional(parsed.item, "item"), "--vault", positional(parsed.vault, "vault")];
  args.push("--format", "json");
  if (options.fields !== undefined && options.fields.length > 0) {
    args.push("--fields", options.fields.map((field) => `label=${validateLabel(field, "field label")}`).join(","));
  }
  return args;
}

/**
 * `op item edit <item> --vault <vault> <field>=<value>...`, for an item reference. Each key of
 * `assignments` is a field label or `<section>.<field>`; the values are passed as given.
 */
export function opItemEditArgs(reference: string, assignments: Readonly<Record<string, string>>): string[] {
  const parsed = validateOpReference(reference, "item");
  const args = ["item", "edit", positional(parsed.item, "item"), "--vault", positional(parsed.vault, "vault")];
  for (const [field, value] of Object.entries(assignments)) {
    args.push(`${validateLabel(field, "field label")}=${value}`);
  }
  return args;
}

/** The part of `child_process.execFile` this module uses; a test injects a recording stand-in. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

export interface OpReadOptions {
  execFile?: ExecFileLike;
}

export const OP_NOT_FOUND_MESSAGE = "1Password CLI (`op`) not found on PATH";

/**
 * `op`'s stderr, with every secret shape, every registered value and every bare UUID replaced:
 * a diagnostic from a secrets manager may echo the very value it failed to read, and a session
 * token is a bare UUID with no context for the pattern rules to key on.
 */
export function redactOpStderr(text: string): string {
  return redactString(text).replace(new RegExp(UUID_PATTERN_SOURCE, "gi"), REDACTED);
}

function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Resolve a field reference through `op read`, with the `OP_*` variables of `env` passed through.
 * The value is registered as a secret before it is returned and is never written anywhere. A
 * missing `op` binary and a non-zero exit are the `config` kind; there is no fallback.
 */
export async function opRead(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
  options: OpReadOptions = {},
): Promise<string> {
  const args = opReadArgs(reference);
  const run = options.execFile ?? nodeExecFile;
  const result = await new Promise<{ error: ExecException | null; stdout: string; stderr: string }>((resolve) => {
    const child = run(
      "op",
      args,
      { env: opEnvironment(env), encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
    // `op read` takes no input; closing stdin lets the child finish without waiting on it.
    child.stdin?.end();
  });

  const value = stripTrailingNewline(result.stdout);
  registerSecret(value);

  if (result.error !== null) {
    if (result.error.code === "ENOENT") {
      throw new ConfigError(
        OP_NOT_FOUND_MESSAGE,
        "install the 1Password CLI, or store the session token itself in the config file",
      );
    }
    const exit = typeof result.error.code === "number" ? ` (exit ${String(result.error.code)})` : "";
    const detail = redactOpStderr(result.stderr.trim());
    throw new ConfigError(
      `1Password CLI failed to read ${reference}${exit}${detail === "" ? "" : `: ${detail}`}`,
      "check the reference and that the 1Password CLI is signed in (`op signin`)",
    );
  }
  return value;
}
