// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Vitest `setupFiles` entry: every test file runs with `HOME`, `USERPROFILE` and
 * `GRIPEVENTSCTL_CONFIG_FILE` pointing at a temporary directory of its own.
 *
 * After each test, the config path and the paths derived from it (resolved from `process.env`,
 * plus the `writes.send_log` of a config file found at that path) must lie inside that directory.
 * After the file, the real home directory's `.gripeventsctl*` files must be as they were. A test
 * that leaves the variables pointing elsewhere, or writes the real config, fails.
 *
 * What the guard cannot see: a store built from an explicit `env` object that names another
 * directory, and a read of the real config file. Tests pass `withTempHome()`'s `env` for that.
 * A real gripeventsctl process of yours that writes `~/.gripeventsctl.yaml` while the suite runs
 * trips the after-file check too; the message says so.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, afterEach } from "vitest";
import { parse } from "yaml";

import { guardedPaths } from "./guarded-paths.js";
import { createTempHome, removeTempHome } from "./temp-home.js";

/** The files this guard watches in the real home directory. */
const GUARDED_FILE_NAMES = [
  ".gripeventsctl.yaml",
  ".gripeventsctl.yaml.lock",
  ".gripeventsctl.send-log.jsonl",
  ".gripeventsctl.go-aheads.jsonl",
  ".gripeventsctl.write.lock",
];

interface FileState {
  exists: boolean;
  size: number;
  mtimeMs: number;
}

async function snapshot(dir: string): Promise<Map<string, FileState>> {
  const states = new Map<string, FileState>();
  for (const name of GUARDED_FILE_NAMES) {
    try {
      const info = await stat(join(dir, name));
      states.set(name, { exists: true, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      states.set(name, { exists: false, size: 0, mtimeMs: 0 });
    }
  }
  return states;
}

/** The `writes.send_log` of the config file at `path`, when the file exists and names one. */
async function configuredSendLog(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const data: unknown = parse(text);
    if (typeof data !== "object" || data === null) return undefined;
    const writes: unknown = (data as Record<string, unknown>)["writes"];
    if (typeof writes !== "object" || writes === null) return undefined;
    const sendLog: unknown = (writes as Record<string, unknown>)["send_log"];
    return typeof sendLog === "string" ? sendLog : undefined;
  } catch {
    return undefined;
  }
}

function isInside(path: string, root: string): boolean {
  const resolved = resolve(path);
  return resolved === root || resolved.startsWith(root + sep);
}

const realHome = homedir();
const before = await snapshot(realHome);
const home = await createTempHome("gripeventsctl-test-home-");
const root = resolve(home.dir);

afterEach(async () => {
  const paths = guardedPaths(process.env);
  const candidates = [paths.config, paths.sendLog, paths.goAheads, paths.writeLock];
  // Read the config file for its `writes.send_log` only once its path is known to be inside the
  // temporary home: a path outside it is reported, never opened.
  if (isInside(paths.config, root)) {
    const sendLog = await configuredSendLog(paths.config);
    if (sendLog !== undefined) candidates.push(sendLog);
  }
  const outside = candidates.filter((path) => !isInside(path, root));
  if (outside.length > 0) {
    throw new Error(
      `the test left a config path outside the temporary home ${root}: ${outside.join(", ")} ` +
        "(restore HOME, USERPROFILE and GRIPEVENTSCTL_CONFIG_FILE before the test ends)",
    );
  }
});

afterAll(async () => {
  try {
    const after = await snapshot(realHome);
    const changed = GUARDED_FILE_NAMES.filter((name) => {
      const was = before.get(name);
      const is = after.get(name);
      return (
        was === undefined ||
        is === undefined ||
        was.exists !== is.exists ||
        was.size !== is.size ||
        was.mtimeMs !== is.mtimeMs
      );
    });
    if (changed.length > 0) {
      throw new Error(
        `the real home directory ${realHome} changed while this test file ran: ${changed.join(", ")} ` +
          "(a test reached the real home, or a gripeventsctl process of yours wrote it during the run)",
      );
    }
  } finally {
    await removeTempHome(home);
  }
});
