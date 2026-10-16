// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Self-tests for `scripts/check-test-traceability.ts`. The exit-code cases build a temporary git
 * repository holding a catalog and tagged test files, and spawn the script against it; the title
 * grammar cases call `readTags` directly.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isTestFile, levelsOf, readTags } from "../check-test-traceability.js";

const SCRIPT = fileURLToPath(new URL("../check-test-traceability.ts", import.meta.url));
const require = createRequire(import.meta.url);
const TSX_CLI = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

let repo: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test Person 1",
      "-c",
      "user.email=test.person.1@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

function write(relativePath: string, content: string): void {
  const absolute = join(repo, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function commitAll(message = "fixtures"): void {
  git("add", "-A", "--force", ".");
  git("commit", "-q", "-m", message);
}

interface Row {
  id: string;
  levels: string[];
  status: "planned" | "active";
  recorded?: string;
  /** Raw YAML lines appended to the row, for malformed-row cases. */
  raw?: string[];
}

function catalog(rows: Row[]): string {
  const lines = ["capabilities:"];
  for (const row of rows) {
    lines.push(`  - id: ${row.id}`);
    lines.push(`    description: ${row.id} as documented`);
    lines.push(`    levels: [${row.levels.join(", ")}]`);
    lines.push(`    status: ${row.status}`);
    if (row.recorded !== undefined) lines.push(`    recorded: ${row.recorded}`);
    for (const extra of row.raw ?? []) lines.push(`    ${extra}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A test file whose first top-level describe carries `title`. */
function testFile(title: string, form = "describe"): string {
  return `// header\nimport { describe, it } from "vitest";\n\n${form}(${JSON.stringify(title)}, () => {\n  it("runs", () => {});\n});\n`;
}

function runCheck(
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", GITHUB_BASE_REF: "", ...env },
    timeout: 60_000,
  });
  if (run.error !== undefined) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** A clean tree: one capability per level class, each with a tagged file at its path-derived level. */
function cleanTree(): Row[] {
  const rows: Row[] = [
    { id: "CAP-ALPHA", levels: ["U", "C"], status: "active" },
    { id: "CAP-GATEWAY", levels: ["R"], status: "active" },
    { id: "CAP-LIVE", levels: ["L"], status: "active" },
    { id: "CAP-LATER", levels: ["S"], status: "planned" },
  ];
  write("test-capabilities.yaml", catalog(rows));
  write("packages/core/src/__tests__/alpha.test.ts", testFile("[CAP-ALPHA] the alpha rules"));
  write("scripts/__tests__/gateway.test.ts", testFile("[CAP-GATEWAY] the gate"));
  write("packages/e2e/src/live.e2e.test.ts", testFile("[CAP-LIVE] the live reads"));
  return rows;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gripeventsctl-traceability-"));
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("[CAP-TEST-TOOLING] the traceability check over a temporary repository", () => {
  it("exits 0 on a clean tree and prints one report line per capability plus the planned list", () => {
    cleanTree();
    commitAll();

    const result = runCheck();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CAP-ALPHA active U:1 C:1\n");
    expect(result.stdout).toContain("CAP-GATEWAY active R:1\n");
    expect(result.stdout).toContain("CAP-LIVE active L:1\n");
    expect(result.stdout).toContain("CAP-LATER planned S:0\n");
    expect(result.stdout).toContain("planned: CAP-LATER\n");
    expect(result.stdout.match(/^CAP-/gmu)).toHaveLength(4);
  });

  it("exits 1 naming an untagged test file", () => {
    cleanTree();
    write("packages/cli/src/__tests__/orphan.test.ts", testFile("no tag here"));
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/cli/src/__tests__/orphan.test.ts: untagged");
  });

  it("exits 1 naming the file and the unknown id of a [CAP-NOPE] tag", () => {
    cleanTree();
    write("packages/cli/src/__tests__/nope.test.ts", testFile("[CAP-NOPE] unknown"));
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/cli/src/__tests__/nope.test.ts: tag [CAP-NOPE] is not in test-capabilities.yaml",
    );
  });

  it("exits 1 naming the capability and the level when an active L row has no live file", () => {
    cleanTree();
    // The live file is tagged with another capability: CAP-LIVE keeps no file at L.
    write("packages/e2e/src/live.e2e.test.ts", testFile("[CAP-ALPHA] mis-tagged"));
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CAP-LIVE: active, yet no tagged test file at level L");
  });

  it("exits 1 telling the maintainer to flip a planned capability that has a tagged file", () => {
    cleanTree();
    write("packages/cli/src/__tests__/later.test.ts", testFile("[CAP-LATER] landed"));
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CAP-LATER: planned, yet packages/cli/src/__tests__/later.test.ts is tagged with it: flip it to active",
    );
  });

  it("exits 1 under --strict while a planned capability remains, and 0 without --strict", () => {
    cleanTree();
    commitAll();

    expect(runCheck().status).toBe(0);
    const strict = runCheck(["--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain("CAP-LATER: planned");
  });

  it("counts both tags of a two-tag title, and a describe.skip title", () => {
    const rows: Row[] = [
      { id: "CAP-ONE", levels: ["U"], status: "active" },
      { id: "CAP-TWO", levels: ["C"], status: "active" },
      { id: "CAP-SKIPPED", levels: ["S"], status: "active" },
    ];
    write("test-capabilities.yaml", catalog(rows));
    write("packages/core/src/__tests__/both.test.ts", testFile("[CAP-ONE] [CAP-TWO] flow 4"));
    write("packages/core/src/__tests__/skipped.test.ts", testFile("[CAP-SKIPPED] later", "describe.skip"));
    commitAll();

    const result = runCheck();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CAP-ONE active U:1\n");
    expect(result.stdout).toContain("CAP-TWO active C:1\n");
    expect(result.stdout).toContain("CAP-SKIPPED active S:1\n");
  });

  it("reports a template-literal title as untagged, and reads a title that follows a leading comment block", () => {
    write("test-capabilities.yaml", catalog([{ id: "CAP-ONE", levels: ["U"], status: "active" }]));
    write(
      "packages/core/src/__tests__/template.test.ts",
      'import { describe, it } from "vitest";\n\ndescribe(`[CAP-ONE] template`, () => {\n  it("runs", () => {});\n});\n',
    );
    write(
      "packages/core/src/__tests__/commented.test.ts",
      `/**\n * describe("[CAP-NOPE] inside a comment") is not a call.\n */\n${testFile("[CAP-ONE] after the comment")}`,
    );
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/core/src/__tests__/template.test.ts: untagged (the first describe title is a template literal)",
    );
    expect(result.stderr).not.toContain("commented.test.ts");
    expect(result.stderr).not.toContain("CAP-NOPE");
  });

  it("exits 1 on a catalog row missing a field and on a duplicate id", () => {
    write(
      "test-capabilities.yaml",
      "capabilities:\n  - id: CAP-ONE\n    levels: [U]\n    status: active\n  - id: CAP-ONE\n    description: again\n    levels: [U]\n    status: active\n",
    );
    write("packages/core/src/__tests__/one.test.ts", testFile("[CAP-ONE] one"));
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CAP-ONE: missing `description`");
    expect(result.stderr).toContain("CAP-ONE: duplicate id");
  });

  it("exits 2 when the catalog is unreadable or malformed", () => {
    write("packages/core/src/__tests__/one.test.ts", testFile("[CAP-ONE] one"));
    commitAll();

    expect(runCheck().status).toBe(2);

    write("test-capabilities.yaml", "capabilities: [\n");
    commitAll();
    const malformed = runCheck();
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("test-capabilities.yaml:");
  });

  it("prints `oracle file changed: <path>` for an oracle file that differs from the base, with the exit code unchanged", () => {
    cleanTree();
    write("packages/core/src/__tests__/alpha.oracle.test.ts", testFile("[CAP-ALPHA] the oracle"));
    commitAll();
    git("checkout", "-q", "-b", "feature");
    write("packages/core/src/__tests__/alpha.oracle.test.ts", testFile("[CAP-ALPHA] the oracle, edited"));
    commitAll("edit the oracle");

    const result = runCheck([], { GITHUB_BASE_REF: "main" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("oracle file changed: packages/core/src/__tests__/alpha.oracle.test.ts\n");
  });

  it("skips the oracle report line, without failing, when the base ref is absent", () => {
    cleanTree();
    commitAll();

    const result = runCheck([], { GITHUB_BASE_REF: "no-such-branch" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("oracle diff skipped: base ref no-such-branch is not available");
    expect(result.stdout).not.toContain("oracle file changed");
  });

  it("satisfies a manual-only row by its recorded field under --strict, and names an unrecorded one as planned (manual, not recorded)", () => {
    const recorded = "https://github.com/example-org/example/pull/1#issuecomment-1";
    write("test-capabilities.yaml", catalog([{ id: "CAP-MANUAL", levels: ["M"], status: "planned", recorded }]));
    commitAll();

    const ok = runCheck(["--strict"]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`CAP-MANUAL planned (manual, recorded: ${recorded})\n`);

    write("test-capabilities.yaml", catalog([{ id: "CAP-MANUAL", levels: ["M"], status: "planned" }]));
    commitAll();
    const missing = runCheck(["--strict"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("CAP-MANUAL: planned (manual, not recorded)");
    expect(missing.stdout).toContain("CAP-MANUAL planned (manual, not recorded)\n");
    expect(runCheck().status).toBe(0);
  });

  it("never lets a test file flip a manual-only row to active", () => {
    write("test-capabilities.yaml", catalog([{ id: "CAP-MANUAL", levels: ["M"], status: "active" }]));
    write("packages/core/src/__tests__/manual.test.ts", testFile("[CAP-MANUAL] not a manual run"));
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CAP-MANUAL: manual-only, yet packages/core/src/__tests__/manual.test.ts is tagged with it",
    );
    expect(result.stderr).toContain("CAP-MANUAL: manual-only rows are never active; set `recorded` instead");
  });
});

describe("[CAP-TEST-TOOLING] readTags, isTestFile and levelsOf", () => {
  it("reads the tags of a plain, a skipped and a conditional describe, with the title on the next line too", () => {
    expect(readTags(testFile("[CAP-GATE] [CAP-GOAHEAD] flow 4"))).toEqual({
      tags: ["CAP-GATE", "CAP-GOAHEAD"],
      title: "[CAP-GATE] [CAP-GOAHEAD] flow 4",
    });
    expect(readTags(testFile("[CAP-CFG] later", "describe.skip"))).toMatchObject({ tags: ["CAP-CFG"] });
    expect(readTags(testFile("[CAP-CFG] only", "describe.only"))).toMatchObject({ tags: ["CAP-CFG"] });
    const conditional =
      'describe.skipIf(subject === undefined)(\n  "[CAP-OUTPUT] every output form",\n  () => {},\n);\n';
    expect(readTags(conditional)).toMatchObject({ tags: ["CAP-OUTPUT"] });
    expect(readTags("describe.skipIf(!ready)('[CAP-CFG] single quotes', () => {});")).toMatchObject({
      tags: ["CAP-CFG"],
    });
    expect(readTags('describe.runIf(fn(1))("[CAP-CFG] nested call", () => {});')).toMatchObject({ tags: ["CAP-CFG"] });
  });

  it("reports a template literal, a missing describe, an untagged title and a malformed tag as untagged", () => {
    expect(readTags("describe(`[CAP-CFG] x`, () => {});")).toEqual({
      untagged: "the first describe title is a template literal",
    });
    expect(readTags("describe(title, () => {});")).toEqual({
      untagged: "the first describe title is not a string literal",
    });
    expect(readTags('it("no describe", () => {});')).toEqual({
      untagged: "no top-level describe call at the start of a line",
    });
    expect(readTags(testFile("plain title"))).toMatchObject({
      untagged: expect.stringContaining("carries no [CAP-<NAME>] tag"),
    });
    expect(readTags(testFile("[CAP-lower] title"))).toMatchObject({ untagged: expect.stringContaining("carries no") });
    expect(readTags(testFile("[CAP-A]  two spaces"))).toMatchObject({
      untagged: expect.stringContaining("carries no"),
    });
    expect(readTags(testFile("[CAP-A][CAP-B] no space"))).toMatchObject({
      untagged: expect.stringContaining("carries no"),
    });
    expect(readTags(testFile("[CAP-A]"))).toMatchObject({ untagged: expect.stringContaining("carries no") });
  });

  it("ignores an indented describe (not top level) when choosing the first call", () => {
    const nested = '  describe("[CAP-INNER] nested", () => {});\ndescribe("[CAP-OUTER] outer", () => {});\n';
    expect(readTags(nested)).toMatchObject({ tags: ["CAP-OUTER"] });
  });

  it("matches the test paths the check reads and derives the level from the path", () => {
    expect(isTestFile("packages/core/src/__tests__/redact.test.ts")).toBe(true);
    expect(isTestFile("packages/core/src/__tests__/gate.oracle.test.ts")).toBe(true);
    expect(isTestFile("packages/e2e/src/reads.e2e.test.ts")).toBe(true);
    expect(isTestFile("scripts/__tests__/check-oracles.test.ts")).toBe(true);
    expect(isTestFile("packages/core/src/lib/redact.ts")).toBe(false);
    expect(isTestFile("packages/core/dist/__tests__/redact.test.ts")).toBe(false);
    expect(isTestFile("scripts/check-oracles.ts")).toBe(false);
    expect(levelsOf("packages/e2e/src/reads.e2e.test.ts")).toEqual(["L"]);
    expect(levelsOf("packages/e2e/src/__tests__/harness.test.ts")).toEqual(["U", "C", "S", "P"]);
    expect(levelsOf("scripts/__tests__/check-oracles.test.ts")).toEqual(["R"]);
    expect(levelsOf("packages/core/src/__tests__/redact.test.ts")).toEqual(["U", "C", "S", "P"]);
  });
});
