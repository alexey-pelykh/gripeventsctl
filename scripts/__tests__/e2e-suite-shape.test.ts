// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The repository gate over the live suite (issue #18 § The harness unit tests, `suite-shape.test.ts`):
 * the rules of `packages/e2e/src/lib/suite-shape.ts` run over the tracked tree (`git ls-files`, like
 * the other gates), and the live config collects nothing without `GRIPEVENTSCTL_E2E=1` and names the
 * path sequencer, and `vitest run --config vitest.e2e.config.ts --passWithNoTests` in the e2e package
 * exits 0 with the variable removed (the `pnpm test:e2e` path CI never runs itself, because no workflow
 * may run `test:e2e`). The rules themselves are graded over synthetic trees by the e2e package's own
 * `suite-shape.test.ts`; this file is the run over the real tree, on every CI job.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PathSequencer } from "../../packages/e2e/src/lib/sequencer.js";
import {
  LIVE_DIR,
  LIVE_FILE_NAMES,
  WORKFLOWS_DIR,
  isLiveFile,
  shapeFindings,
} from "../../packages/e2e/src/lib/suite-shape.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
/** The Vitest CLI of the workspace, run with the current Node: the same binary `pnpm test:e2e` runs. */
const VITEST_CLI = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

/** Every tracked path under the two directories the rules read, with its content. */
function trackedTree(): Map<string, string> {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", LIVE_DIR, WORKFLOWS_DIR], {
    cwd: root,
    encoding: "utf8",
  });
  const files = new Map<string, string>();
  for (const path of stdout.split("\0").filter((entry) => entry.length > 0)) {
    files.set(path, readFileSync(join(root, path), "utf8"));
  }
  return files;
}

describe("[CAP-E2E] the shape of the live suite over the tracked tree", () => {
  const tree = trackedTree();

  it("holds exactly the nine live files, each tracked", () => {
    const live = [...tree.keys()]
      .filter(isLiveFile)
      .map((path) => path.slice(LIVE_DIR.length))
      .sort();
    expect(live).toEqual([...LIVE_FILE_NAMES].sort());
  });

  it("finds nothing to report: the write names in 60-write only, no dump, no event, no file write, no secret in a workflow", () => {
    expect(shapeFindings(tree)).toEqual([]);
  });
});

describe("[CAP-E2E] the live config", () => {
  it("collects nothing without GRIPEVENTSCTL_E2E=1 and names PathSequencer, no file parallelism, no concurrency", async () => {
    const saved = process.env["GRIPEVENTSCTL_E2E"];
    Reflect.deleteProperty(process.env, "GRIPEVENTSCTL_E2E");
    try {
      const { default: config } = (await import("../../packages/e2e/vitest.e2e.config.js")) as {
        default: {
          test?: {
            include?: string[];
            fileParallelism?: boolean;
            sequence?: { concurrent?: boolean; shuffle?: boolean; sequencer?: unknown };
          };
        };
      };
      expect(config.test?.include).toEqual([]);
      expect(config.test?.fileParallelism).toBe(false);
      expect(config.test?.sequence?.concurrent).toBe(false);
      expect(config.test?.sequence?.shuffle).toBe(false);
      expect(config.test?.sequence?.sequencer).toBe(PathSequencer);
    } finally {
      if (saved !== undefined) process.env["GRIPEVENTSCTL_E2E"] = saved;
    }
  });

  it("exits 0 and collects nothing when the e2e package's test:e2e command runs with the variable removed", () => {
    const env = { ...process.env };
    Reflect.deleteProperty(env, "GRIPEVENTSCTL_E2E");
    const run = spawnSync(
      process.execPath,
      [VITEST_CLI, "run", "--config", "vitest.e2e.config.ts", "--passWithNoTests"],
      { cwd: join(root, "packages", "e2e"), env, encoding: "utf8", timeout: 120_000 },
    );
    expect(run.error).toBeUndefined();
    expect(`${run.stdout}${run.stderr}`).toContain("No test files found");
    expect(run.status).toBe(0);
  }, 150_000);

  it("keeps the unit config from collecting a live file", () => {
    const source = readFileSync(join(root, "packages/e2e/vitest.config.ts"), "utf8");
    expect(source).toContain('"**/*.e2e.test.ts"');
    expect(source).toContain('include: ["src/**/*.test.ts"]');
  });
});
