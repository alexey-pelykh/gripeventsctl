// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Where the config file lives, the paths derived from it, and the git work-tree check.
 *
 * The config path is `GRIPEVENTSCTL_CONFIG_FILE` when set, else `~/.gripeventsctl.yaml`. Never the
 * current working directory: a config file in the directory the command runs in is ignored, so a
 * checked-out repository cannot inject credentials. Three files sit beside each other at the config
 * path's prefix: the config, the send log and the go-ahead journal; the write lock sits there too.
 * Moving the config path with the environment variable moves all of them.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Config } from "./schema.js";

export const CONFIG_FILE_ENV = "GRIPEVENTSCTL_CONFIG_FILE";
export const DEFAULT_CONFIG_FILE_NAME = ".gripeventsctl.yaml";
const CONFIG_SUFFIX = ".yaml";

export interface DerivedPaths {
  sendLog: string;
  goAheads: string;
  writeLock: string;
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  const fromEnv = process.platform === "win32" ? env["USERPROFILE"] : env["HOME"];
  return fromEnv === undefined || fromEnv === "" ? homedir() : fromEnv;
}

/** The config file path for `env` (default `process.env`). Exported so the CLI and the MCP server print the same path. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_FILE_ENV];
  if (override !== undefined && override !== "") return isAbsolute(override) ? override : resolve(override);
  return join(homeDirectory(env), DEFAULT_CONFIG_FILE_NAME);
}

/** The config path with its `.yaml` suffix removed; the whole path where it does not end in `.yaml`. */
export function configPrefix(path: string): string {
  return path.endsWith(CONFIG_SUFFIX) ? path.slice(0, -CONFIG_SUFFIX.length) : path;
}

/**
 * The send log (`<prefix>.send-log.jsonl`, unless `writes.send_log` names another file), the
 * go-ahead journal (`<prefix>.go-aheads.jsonl`) and the write lock (`<prefix>.write.lock`).
 */
export function derivedPaths(path: string, config: Config): DerivedPaths {
  const prefix = configPrefix(path);
  return {
    sendLog: config.writes.send_log ?? `${prefix}.send-log.jsonl`,
    goAheads: `${prefix}.go-aheads.jsonl`,
    writeLock: `${prefix}.write.lock`,
  };
}

/** True when any ancestor directory of `path` holds a `.git` entry (file or directory). */
export function insideGitWorkTree(path: string): boolean {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The config path and the paths derived from it that resolve inside a git work tree. The caller
 * warns once per process run on stderr for each: the file must not be committed.
 */
export function workTreeWarnings(config: Config, path: string): string[] {
  const derived = derivedPaths(path, config);
  return [...new Set([path, derived.sendLog, derived.goAheads, derived.writeLock])].filter(insideGitWorkTree);
}
