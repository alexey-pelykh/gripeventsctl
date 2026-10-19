// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Self-tests for `scripts/check-api-docs-dated.ts`. The grading cases build a temporary git repository holding a
 * `docs/api/` folder and call `main` in-process with a stub operation list; the exit-2 case and the real-repository
 * case spawn the script. The fixture pages hold headings and `Verified live` labels only.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { headingsOf, latestDate, main, type OperationAnchors } from "../check-api-docs-dated.js";

const SCRIPT = fileURLToPath(new URL("../check-api-docs-dated.ts", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
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

/** The tree of the acceptance criterion: one dated, one undated, one placeholder-only page, the three exempt names. */
function acceptanceTree(): void {
  write(
    "docs/api/dated.md",
    "# Dated\n\n## Directory search\n\nVerified live 2026-10-01.\n\n### Later\n\nVerified live 2026-10-09.\n",
  );
  write("docs/api/undated.md", "# Undated\n\n## Something\n\nNo label here.\n");
  write("docs/api/placeholder.md", "# Placeholder\n\n| Label |\n| --- |\n| `Verified live YYYY-MM-DD` |\n");
  write("docs/api/not-verified.md", "# Not verified\n\n## Gaps\n");
  write("docs/api/README.md", "# API notes\n\n| `Verified live YYYY-MM-DD` | a real run |\n");
  write("docs/api/platform-landscape.md", "# Landscape\n\n## Hosts\n");
}

const STUB: readonly OperationAnchors[] = [
  { group: "attendees", verb: "list", requests: [{ page: "dated.md", section: "Directory search" }] },
  { group: "writes", verb: "status", requests: [] },
];

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Calls `main` in-process over the temporary repository, capturing what it writes. */
async function runMain(args: string[], operations: readonly OperationAnchors[] = STUB): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const status = await main(args, repo, () => Promise.resolve(operations));
    return { status, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function spawnCheck(cwd: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 60_000,
  });
  if (run.error !== undefined) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The report lines of a run: everything before the blank line that separates the summary. */
function reportLines(stdout: string): string[] {
  return (
    stdout
      .split("\n\n")[0]
      ?.split("\n")
      .filter((line) => line.length > 0) ?? []
  );
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "gripeventsctl-api-docs-")));
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("[CAP-DOCS] the API docs dating check over a temporary repository", () => {
  it("R1: report mode lists each page as dated with its latest date, undated or exempt in sorted order and exits 0", async () => {
    acceptanceTree();
    commitAll();

    const result = await runMain([]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(reportLines(result.stdout)).toEqual([
      "exempt README.md",
      "dated dated.md 2026-10-09",
      "exempt not-verified.md",
      "undated placeholder.md",
      "exempt platform-landscape.md",
      "undated undated.md",
    ]);
  });

  it("R2: strict mode exits 1 naming the two undated pages and no other page", async () => {
    acceptanceTree();
    commitAll();

    const result = await runMain(["--strict"]);

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.startsWith("undated "));
    expect(findings).toEqual([
      'undated placeholder.md: no "Verified live YYYY-MM-DD" label (strict)',
      'undated undated.md: no "Verified live YYYY-MM-DD" label (strict)',
    ]);
    for (const page of ["dated.md", "README.md", "not-verified.md", "platform-landscape.md"]) {
      expect(result.stderr).not.toContain(` ${page}:`);
    }
    expect(result.stderr).toContain("FAIL: 2 finding(s).");
  });

  it("R3: an anchor to a missing page fails both modes naming the operation, the page and the section", async () => {
    acceptanceTree();
    commitAll();
    const operations: OperationAnchors[] = [
      { group: "chat", verb: "list", requests: [{ page: "chat.md", section: "Chat threads" }] },
    ];

    for (const args of [[], ["--strict"]]) {
      const result = await runMain(args, operations);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('anchor chat list: page chat.md is missing (section "Chat threads")\n');
    }
  });

  it("R4: an anchor to a section absent from its page fails both modes naming the operation, the page and the section", async () => {
    acceptanceTree();
    commitAll();
    const operations: OperationAnchors[] = [
      { group: "attendees", verb: "get", requests: [{ page: "dated.md", section: "The per-person profile" }] },
    ];

    for (const args of [[], ["--strict"]]) {
      const result = await runMain(args, operations);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('anchor attendees get: section "The per-person profile" not found on dated.md\n');
    }
  });

  it("R5: a heading inside a fenced code block or at level one does not satisfy an anchor", async () => {
    write(
      "docs/api/fenced.md",
      "# Top level\n\n```markdown\n## Inside a fence\n```\n\n~~~~\n### Inside tildes\n~~~\n#### Still inside\n~~~~\n\nVerified live 2026-10-02.\n",
    );
    commitAll();
    const operations: OperationAnchors[] = ["Top level", "Inside a fence", "Inside tildes", "Still inside"].map(
      (section) => ({ group: "events", verb: "check", requests: [{ page: "fenced.md", section }] }),
    );

    const result = await runMain([], operations);

    expect(result.status).toBe(1);
    expect(result.stderr.split("\n").filter((line) => line.startsWith("anchor "))).toEqual([
      'anchor events check: section "Top level" not found on fenced.md',
      'anchor events check: section "Inside a fence" not found on fenced.md',
      'anchor events check: section "Inside tildes" not found on fenced.md',
      'anchor events check: section "Still inside" not found on fenced.md',
    ]);
  });

  it("R6: a heading matches its section exactly after trimming and a shorter heading does not", async () => {
    write("docs/api/trim.md", "## Directory search \n\n## Directory\n\nVerified live 2026-10-03.\n");
    commitAll();
    const operations: OperationAnchors[] = [
      { group: "attendees", verb: "list", requests: [{ page: "trim.md", section: "Directory search" }] },
      { group: "attendees", verb: "dump", requests: [{ page: "trim.md", section: "Directory searc" }] },
    ];

    const result = await runMain([], operations);

    expect(result.status).toBe(1);
    expect(result.stderr.split("\n").filter((line) => line.startsWith("anchor "))).toEqual([
      'anchor attendees dump: section "Directory searc" not found on trim.md',
    ]);
  });

  it("R7: a page written but not committed is not reported at all", async () => {
    acceptanceTree();
    commitAll();
    write("docs/api/stray.md", "## Stray\n");

    const result = await runMain(["--strict"]);

    expect(result.stdout).not.toContain("stray.md");
    expect(result.stderr).not.toContain("stray.md");
  });

  it("R8: an unknown argument prints the usage line and exits 2", async () => {
    acceptanceTree();
    commitAll();

    const result = await runMain(["--loose"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: check-api-docs-dated [--strict]");
  });

  it("R9: a registry that cannot be imported exits 2 with the error message", async () => {
    acceptanceTree();
    commitAll();
    let stderr = "";
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    try {
      const status = await main([], repo, () => Promise.reject(new Error("module not found")));
      expect(status).toBe(2);
    } finally {
      err.mockRestore();
    }
    expect(stderr).toBe("the operation registry could not be imported: module not found\n");
  });

  it("R10: a missing docs/api/ folder exits 2 with the message when the script is spawned", () => {
    write("README.md", "# A repository without API notes\n");
    commitAll();

    const result = spawnCheck(repo);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`docs/api/ not found under ${repo}\n`);
  });
});

describe("[CAP-DOCS] the heading and date readers", () => {
  it("R11: headingsOf reads levels two to four, drops a closing hash sequence and skips fenced blocks", () => {
    const markdown = "# One\n## Two ##\n### Three\n#### Four\n##### Five\n```\n## Fenced\n```\n##NoSpace\n";
    expect(headingsOf(markdown)).toEqual(["Two", "Three", "Four"]);
  });

  it("R12: latestDate returns the latest dated label and ignores the placeholder", () => {
    expect(latestDate("Verified live 2026-10-07; Verified live 2026-10-13; Verified live 2026-09-30")).toBe(
      "2026-10-13",
    );
    expect(latestDate("Verified live YYYY-MM-DD")).toBeUndefined();
  });
});

describe("[CAP-DOCS] the API docs dating check over this repository", () => {
  it("R13: strict mode exits 0 over the tracked docs/api/ pages and the real registry", () => {
    const result = spawnCheck(root, ["--strict"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const lines = reportLines(result.stdout);
    expect(lines.some((line) => line.startsWith("dated attendees.md "))).toBe(true);
    expect(lines.some((line) => line.startsWith("dated interest.md "))).toBe(true);
    expect(lines).toContain("exempt README.md");
    expect(lines.some((line) => line.startsWith("undated "))).toBe(false);
  });
});
