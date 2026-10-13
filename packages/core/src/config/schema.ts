// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The config file, schema version 1. Strict objects at every level: an unknown key, top-level or
 * nested, is refused with its name in the message, so a typo never silently drops a setting.
 *
 * ```yaml
 * version: 1
 * auth:
 *   credentials: "op://<vault>/<item>"       # optional: a 1Password item holding username and password
 * session:
 *   slug: "<event slug>"
 *   container_id: <container id>
 *   token: "<session token or op://<vault>/<item>[/<section>]/<field>>"
 *   signed_in_at: "2026-10-12T19:09:00Z"
 *   auth_failed_at: "2026-10-13T08:12:00Z"   # set once, at the first 401; cleared by signin
 * writes:
 *   enabled: false                           # safe mode; `true` is "writes enabled"
 *   send_log: "<optional absolute path ending in .jsonl; default beside the config>"
 * ```
 *
 * The per-event application token and the chat token the login call returns are never stored here
 * (`docs/api/login.md` § Handling credentials).
 */

import { isAbsolute } from "node:path";

import { z } from "zod";

import { ConfigError } from "../transport/errors.js";
import { OP_REFERENCE_PREFIX, isFieldReference, isItemReference } from "./op.js";

export const CONFIG_VERSION = 1;
export const SEND_LOG_EXTENSION = ".jsonl";

export interface Session {
  slug: string;
  container_id: number;
  token: string;
  signed_in_at: string;
  auth_failed_at?: string;
}

export interface Config {
  version: 1;
  auth?: { credentials?: string };
  session?: Session;
  writes: { enabled: boolean; send_log?: string };
}

/** `YYYY-MM-DDTHH:MM:SSZ`, with optional fractional seconds, UTC only. */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const timestamp = z
  .string()
  .regex(TIMESTAMP_PATTERN, { error: "must be an ISO 8601 UTC timestamp such as 2026-10-12T19:09:00Z" });

const sessionSchema = z.strictObject({
  slug: z.string().min(1, { error: "must be a non-empty string" }),
  container_id: z
    .number({ error: "must be a positive integer" })
    .int({ error: "must be a positive integer" })
    .positive({ error: "must be a positive integer" }),
  token: z
    .string()
    .min(1, { error: "must be a non-empty string" })
    .refine((value) => !value.startsWith(OP_REFERENCE_PREFIX) || isFieldReference(value), {
      error: "must be the session token itself or an op://<vault>/<item>[/<section>]/<field> reference",
    }),
  signed_in_at: timestamp,
  auth_failed_at: timestamp.optional(),
});

const authSchema = z.strictObject({
  credentials: z.string().refine(isItemReference, { error: "must be an op://<vault>/<item> reference" }).optional(),
});

const writesSchema = z.strictObject({
  enabled: z.boolean().default(false),
  send_log: z
    .string()
    .refine((value) => isAbsolute(value) && value.endsWith(SEND_LOG_EXTENSION), {
      error: `must be an absolute path ending in ${SEND_LOG_EXTENSION}`,
    })
    .optional(),
});

export const configSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION, { error: `must be ${String(CONFIG_VERSION)}` }),
  auth: authSchema.optional(),
  session: sessionSchema.optional(),
  writes: writesSchema.optional(),
});

/** The config of a machine that never signed in: version 1, safe mode, no session. */
export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, writes: { enabled: false } };
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

const EXPECTED_WORDS: Record<string, string> = {
  string: "a string",
  number: "a number",
  boolean: "a boolean",
  object: "a mapping",
};

function describeIssue(issue: z.core.$ZodIssue, data: unknown): string {
  const key = issue.path.map(String).join(".");
  switch (issue.code) {
    case "unrecognized_keys":
      return issue.keys.map((name) => `unknown key ${JSON.stringify(key === "" ? name : `${key}.${name}`)}`).join("; ");
    case "invalid_type":
    case "invalid_value": {
      if (valueAt(data, issue.path) === undefined) return `${key} is required`;
      if (issue.code === "invalid_value") return `${key} must be ${issue.values.map(String).join(" or ")}`;
      return `${key} must be ${EXPECTED_WORDS[issue.expected] ?? issue.expected}`;
    }
    default:
      return key === "" ? issue.message : `${key} ${issue.message}`;
  }
}

/**
 * Validate a parsed YAML document against the schema and return the config it holds, with
 * `writes` defaulted to safe mode. A failure is a `ConfigError` whose message names the offending
 * key, prefixed with `source` (the file path) when given.
 */
export function parseConfig(data: unknown, source?: string): Config {
  const prefix = source === undefined ? "" : `${source}: `;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ConfigError(`${prefix}the config file must be a YAML mapping with a version key`);
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => describeIssue(issue, data)).join("; ");
    throw new ConfigError(
      `${prefix}invalid config: ${problems}`,
      "fix the config file, or sign in again to rewrite it",
    );
  }
  const parsed = result.data;
  const config: Config = { version: CONFIG_VERSION, writes: { enabled: parsed.writes?.enabled ?? false } };
  if (parsed.writes?.send_log !== undefined) config.writes.send_log = parsed.writes.send_log;
  if (parsed.auth !== undefined) {
    config.auth = parsed.auth.credentials === undefined ? {} : { credentials: parsed.auth.credentials };
  }
  if (parsed.session !== undefined) {
    const session: Session = {
      slug: parsed.session.slug,
      container_id: parsed.session.container_id,
      token: parsed.session.token,
      signed_in_at: parsed.session.signed_in_at,
    };
    if (parsed.session.auth_failed_at !== undefined) session.auth_failed_at = parsed.session.auth_failed_at;
    config.session = session;
  }
  return config;
}

/** Refuse an in-memory config that does not satisfy the schema; the same rules as `parseConfig`. */
export function validateConfig(config: Config): Config {
  return parseConfig(config);
}

/** The plain object written to the file: the config's keys in a fixed order, no undefined values. */
export function toFileShape(config: Config): Record<string, unknown> {
  const file: Record<string, unknown> = { version: config.version };
  if (config.auth !== undefined) {
    file["auth"] = config.auth.credentials === undefined ? {} : { credentials: config.auth.credentials };
  }
  if (config.session !== undefined) {
    const session: Record<string, unknown> = {
      slug: config.session.slug,
      container_id: config.session.container_id,
      token: config.session.token,
      signed_in_at: config.session.signed_in_at,
    };
    if (config.session.auth_failed_at !== undefined) session["auth_failed_at"] = config.session.auth_failed_at;
    file["session"] = session;
  }
  const writes: Record<string, unknown> = { enabled: config.writes.enabled };
  if (config.writes.send_log !== undefined) writes["send_log"] = config.writes.send_log;
  file["writes"] = writes;
  return file;
}
