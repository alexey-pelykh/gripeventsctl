// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Vitest `setupFiles` entry: every test file runs with `HOME`, `USERPROFILE` and
 * `GRIPEVENTSCTL_CONFIG_FILE` pointing at a temporary directory of its own. After each test the
 * config path and the paths derived from it are checked to lie inside that directory, and after
 * the file the real home directory's `.gripeventsctl*` files are checked to be as they were. A
 * test that reaches the real home directory fails.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, afterEach } from "vitest";

import { CONFIG_FILE_NAME, createTempHome, removeTempHome } from "./temp-home.js";

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

/** The same path rule as `@gripeventsctl/core`, restated because this package depends on no workspace package. */
function resolvedPaths(env: NodeJS.ProcessEnv): string[] {
  const home = (process.platform === "win32" ? env["USERPROFILE"] : env["HOME"]) ?? "";
  const override = env["GRIPEVENTSCTL_CONFIG_FILE"];
  const configPath = override === undefined || override === "" ? join(home, CONFIG_FILE_NAME) : override;
  const prefix = configPath.endsWith(".yaml") ? configPath.slice(0, -".yaml".length) : configPath;
  return [configPath, `${prefix}.send-log.jsonl`, `${prefix}.go-aheads.jsonl`, `${prefix}.write.lock`];
}

function isInside(path: string, root: string): boolean {
  const resolved = resolve(path);
  return resolved === root || resolved.startsWith(root + sep);
}

const realHome = homedir();
const before = await snapshot(realHome);
const home = await createTempHome("gripeventsctl-test-home-");
const root = resolve(home.dir);

afterEach(() => {
  const outside = resolvedPaths(process.env).filter((path) => !isInside(path, root));
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
      throw new Error(`a test touched the real home directory ${realHome}: ${changed.join(", ")} changed`);
    }
  } finally {
    await removeTempHome(home);
  }
});
