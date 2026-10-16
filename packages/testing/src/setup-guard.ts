// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The check the temporary-home guard (`setup.ts`) runs after each test: `HOME`, `USERPROFILE` and
 * `GRIPEVENTSCTL_CONFIG_FILE` still resolve inside the file's temporary directory, and so do the
 * paths derived from the config path (the send log, the go-ahead journal, the write lock) and the
 * `writes.send_log` of a config file found at that path. Each problem names the variable.
 */

import { resolve, sep } from "node:path";

import { HOME_ENV_NAMES } from "./temp-home.js";
import { guardedPaths } from "./guarded-paths.js";

export function isInside(path: string, root: string): boolean {
  const resolved = resolve(path);
  const base = resolve(root);
  return resolved === base || resolved.startsWith(base + sep);
}

/**
 * The problems with `env` against the temporary home `root`, one line each; empty when the three
 * variables and the derived paths all resolve inside it.
 */
export function outsideTempHome(env: NodeJS.ProcessEnv, root: string, configuredSendLog?: string): string[] {
  const problems: string[] = [];
  for (const name of HOME_ENV_NAMES) {
    const value = env[name];
    if (value === undefined || value === "") problems.push(`${name} is unset`);
    else if (!isInside(value, root)) problems.push(`${name} points outside the temporary home: ${value}`);
  }
  const paths = guardedPaths(env);
  const derived: [string, string][] = [
    ["the send log derived from GRIPEVENTSCTL_CONFIG_FILE", paths.sendLog],
    ["the go-ahead journal derived from GRIPEVENTSCTL_CONFIG_FILE", paths.goAheads],
    ["the write lock derived from GRIPEVENTSCTL_CONFIG_FILE", paths.writeLock],
  ];
  if (configuredSendLog !== undefined)
    derived.push(["writes.send_log of the config at GRIPEVENTSCTL_CONFIG_FILE", configuredSendLog]);
  for (const [label, path] of derived) {
    if (!isInside(path, root)) problems.push(`${label} points outside the temporary home: ${path}`);
  }
  return problems;
}

/** The message the guard fails a test with. */
export function guardMessage(root: string, problems: string[]): string {
  return (
    `the test left a config path outside the temporary home ${root}:\n  ${problems.join("\n  ")}\n` +
    "(restore HOME, USERPROFILE and GRIPEVENTSCTL_CONFIG_FILE before the test ends)"
  );
}
