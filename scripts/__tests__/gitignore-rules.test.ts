// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The ignore rules over the user's own records (issue #19 § The ignore rules): the send log, the go-ahead journal,
 * the write lock, the config and anything derived from its name are ignored by the tracked `.gitignore`, and a source
 * file under `packages/core/src/gate/` is not. Run over the real repository with `git check-ignore`, one path per call.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** `git check-ignore -q <path>`: 0 when ignored, 1 when not. */
function ignored(path: string): boolean {
  const run = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: root, stdio: "ignore", timeout: 10_000 });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0 && run.status !== 1)
    throw new Error(`git check-ignore exited ${String(run.status)} for ${path}`);
  return run.status === 0;
}

describe("[CAP-RELEASE] the ignore rules cover every local file that holds the user's own records", () => {
  it("ignores the send log, the go-ahead journal, the write lock, an alternate config and a file derived from the config name", () => {
    for (const path of [
      "x.send-log.jsonl",
      "x.go-aheads.jsonl",
      "x.write.lock",
      ".gripeventsctl-alt.yaml",
      ".gripeventsctl.send-log.jsonl",
      ".gripeventsctl.yaml",
    ]) {
      expect(ignored(path), path).toBe(true);
    }
  });

  it("does not ignore the gate's source files or a docs page: the patterns match file names, not source", () => {
    for (const path of ["packages/core/src/gate/gate.ts", "packages/core/src/gate/files.ts", "docs/api/README.md"]) {
      expect(ignored(path), path).toBe(false);
    }
  });
});
