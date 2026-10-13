// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * A temporary home directory for one test: `HOME`, `USERPROFILE` and `GRIPEVENTSCTL_CONFIG_FILE`
 * point at a fresh `fs.mkdtemp` directory while the test runs, and the directory is removed
 * afterwards. The per-file guard in `setup.ts` uses the same pieces.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_FILE_NAME } from "./guarded-paths.js";

/** The environment variables a temporary home overrides. */
export const HOME_ENV_NAMES = ["HOME", "USERPROFILE", "GRIPEVENTSCTL_CONFIG_FILE"] as const;

export interface TempHome {
  /** The temporary directory that stands in for the home directory. */
  dir: string;
  /** `<dir>/.gripeventsctl.yaml`, also the value of `GRIPEVENTSCTL_CONFIG_FILE`. */
  configFile: string;
  /** A copy of `process.env` with the three variables pointing at `dir`. */
  env: NodeJS.ProcessEnv;
}

/** Create a temporary home directory and point the three variables of `process.env` at it. */
export async function createTempHome(prefix = "gripeventsctl-home-"): Promise<TempHome> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const configFile = join(dir, CONFIG_FILE_NAME);
  process.env["HOME"] = dir;
  process.env["USERPROFILE"] = dir;
  process.env["GRIPEVENTSCTL_CONFIG_FILE"] = configFile;
  return { dir, configFile, env: { ...process.env } };
}

/** Remove a temporary home; lock directories and open handles are retried. */
export async function removeTempHome(home: TempHome): Promise<void> {
  await rm(home.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Snapshot the three variables so they can be put back. */
export function saveHomeEnv(): Record<string, string | undefined> {
  return Object.fromEntries(HOME_ENV_NAMES.map((name) => [name, process.env[name]]));
}

export function restoreHomeEnv(saved: Record<string, string | undefined>): void {
  for (const name of HOME_ENV_NAMES) {
    const value = saved[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

/**
 * Run `fn` with a fresh `fs.mkdtemp` directory set as `HOME`, `USERPROFILE` and
 * `GRIPEVENTSCTL_CONFIG_FILE`, then put the variables back and remove the directory.
 */
export async function withTempHome<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  const saved = saveHomeEnv();
  const home = await createTempHome();
  try {
    return await fn(home);
  } finally {
    restoreHomeEnv(saved);
    await removeTempHome(home);
  }
}
