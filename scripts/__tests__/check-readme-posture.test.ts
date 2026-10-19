// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Self-tests for `scripts/check-readme-posture.ts`. Each case builds a temporary tree with
 * `conformingTree`, breaks one thing, and calls `checkPosture` or spawns the script against it. The
 * script reads files only, so the tree needs no git. The text is synthetic.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DISCLAIMER_HEADING, MCP_WARNING, REPOSITORY_URL, checkPosture, findBlock } from "../check-readme-posture.js";

const SCRIPT = fileURLToPath(new URL("../check-readme-posture.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const TSX_CLI = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

/** The disclaimer block of the synthetic root README; line 5 of the block is `BLOCK[4]`. */
const BLOCK = [
  DISCLAIMER_HEADING,
  "",
  "> This is an unofficial tool for a synthetic platform.",
  "",
  "- It is not affiliated with the platform owner.",
  "- Use it only for your own account.",
  "",
  "See the legitimacy page for details.",
];

const PACKAGES = ["core", "cli", "mcp", "e2e", "testing", "gripeventsctl"];

let tree: string;

function write(relativePath: string, content: string): void {
  const absolute = join(tree, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function read(relativePath: string): string {
  return readFileSync(join(tree, ...relativePath.split("/")), "utf8");
}

function edit(relativePath: string, change: (text: string) => string): void {
  write(relativePath, change(read(relativePath)));
}

function editJson(relativePath: string, change: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(read(relativePath)) as Record<string, unknown>;
  change(value);
  write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** A package README with the block after its first paragraph; `heading` replaces the block heading. */
function packageReadme(name: string, heading = DISCLAIMER_HEADING): string {
  return [
    `# ${name}`,
    "",
    "A synthetic package.",
    "",
    heading,
    ...BLOCK.slice(1),
    "",
    "## Install",
    "",
    "Run it.",
    "",
  ].join("\n");
}

/** A minimal tree every rule passes over. */
function conformingTree(dir: string): void {
  tree = dir;
  write(
    "README.md",
    [
      "# Synthetic",
      "",
      ...BLOCK,
      "",
      "## Status",
      "",
      "Early.",
      "",
      "## MCP Integration",
      "",
      "Configure the server.",
      "",
      `${MCP_WARNING} Do not give it to agents you do not trust.`,
      "",
      "## Documentation",
      "",
      "- [`docs/legitimacy.md`](docs/legitimacy.md): the position.",
      "",
    ].join("\n"),
  );
  for (const name of ["core", "cli", "mcp"]) write(`packages/${name}/README.md`, packageReadme(`@synthetic/${name}`));
  write("packages/e2e/README.md", "# @synthetic/e2e\n\nPrivate live tests.\n");
  write(
    "docs/legitimacy.md",
    "# Legitimacy\n\nEvery platform fact below was read on 2026-10-12.\n\nThe word names the platform; this is nominative use.\n",
  );
  write("package.json", `${JSON.stringify({ name: "synthetic-workspace", private: true }, null, 2)}\n`);
  for (const name of PACKAGES) {
    const manifest: Record<string, unknown> = {
      name: name === "gripeventsctl" ? "gripeventsctl" : `@gripeventsctl/${name}`,
      description: `Synthetic ${name} package`,
      repository: { type: "git", url: `${REPOSITORY_URL}.git`, directory: `packages/${name}` },
    };
    if (name === "gripeventsctl") {
      manifest["description"] = "Unofficial synthetic CLI";
      manifest["keywords"] = ["unofficial", "grip-events", "cli"];
      manifest["homepage"] = REPOSITORY_URL;
    }
    write(`packages/${name}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  write(
    "server.json",
    `${JSON.stringify({ name: "io.example/synthetic", description: "Unofficial synthetic server" }, null, 2)}\n`,
  );
}

function runCheck(args: string[] = [], cwd: string = tree): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 60_000,
  });
  if (run.error !== undefined) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

beforeEach(() => {
  conformingTree(mkdtempSync(join(tmpdir(), "gripeventsctl-posture-")));
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

describe("[CAP-POSTURE] the README posture check over a temporary tree", () => {
  it("R1: the conforming tree passes", () => {
    expect(checkPosture(tree)).toEqual([]);
    const run = runCheck();
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^posture: \d+ file\(s\) checked, nothing to report\n$/u);
    expect(run.stderr).toBe("");
  });

  it("R2: a package README whose block has one changed line fails naming the file and the first differing line number", () => {
    edit("packages/mcp/README.md", (text) => text.replace(BLOCK[4] ?? "", "- It is endorsed by the platform owner."));
    // The heading sits on line 5 of the package README, so block line 5 is README line 9.
    const findings = checkPosture(tree);
    expect(findings).toEqual([
      `packages/mcp/README.md: the disclaimer block differs at line 9: expected ${JSON.stringify(BLOCK[4])} but found "- It is endorsed by the platform owner."`,
    ]);
    const run = runCheck();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("packages/mcp/README.md: the disclaimer block differs at line 9");
    expect(run.stderr).not.toContain("packages/core/README.md");
    expect(run.stderr).not.toContain("packages/cli/README.md");
    expect(run.stderr).toMatch(/FAIL: 1 finding\(s\)\./u);
  });

  it("R3: a package copy whose heading is ### passes; a copy whose block lines are not contiguous fails", () => {
    write("packages/cli/README.md", packageReadme("@synthetic/cli", `#${DISCLAIMER_HEADING}`));
    expect(checkPosture(tree)).toEqual([]);

    edit("packages/core/README.md", (text) =>
      text.replace(`${BLOCK[4] ?? ""}\n`, `${BLOCK[4] ?? ""}\n- An inserted line.\n`),
    );
    expect(checkPosture(tree)).toEqual([
      `packages/core/README.md: the disclaimer block differs at line 10: expected ${JSON.stringify(BLOCK[5])} but found "- An inserted line."`,
    ]);
    expect(findBlock(BLOCK, read("packages/cli/README.md"))).toEqual({ index: 4 });
  });

  it("R4: trailing whitespace on a block line is ignored; a changed word is not", () => {
    edit("packages/mcp/README.md", (text) => text.replace(BLOCK[2] ?? "", `${BLOCK[2] ?? ""}   \t`));
    edit("README.md", (text) => text.replace(BLOCK[5] ?? "", `${BLOCK[5] ?? ""}  `));
    expect(checkPosture(tree)).toEqual([]);

    edit("packages/cli/README.md", (text) => text.replace("own account", "own accounts"));
    const findings = checkPosture(tree);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^packages\/cli\/README\.md: the disclaimer block differs at line 10: /u);
  });

  it("R5: the root README without the MCP warning sentence fails; the sentence outside the MCP Integration section fails", () => {
    const original = read("README.md");
    edit("README.md", (text) => text.replace(MCP_WARNING, "Be careful."));
    expect(checkPosture(tree)).toEqual(['README.md: the MCP warning sentence is missing under "## MCP Integration"']);
    expect(runCheck().status).toBe(1);

    // Before the section, then after the next `## ` heading: both are outside it.
    write("README.md", original.replace(`${MCP_WARNING} `, "").replace("Early.", `Early. ${MCP_WARNING}`));
    expect(checkPosture(tree)).toEqual(['README.md: the MCP warning sentence is missing under "## MCP Integration"']);
    write(
      "README.md",
      original.replace(`${MCP_WARNING} `, "").replace("the position.", `the position. ${MCP_WARNING}`),
    );
    expect(checkPosture(tree)).toEqual(['README.md: the MCP warning sentence is missing under "## MCP Integration"']);

    // A sentence wrapped across two lines inside the section still counts.
    write("README.md", original.replace(MCP_WARNING, MCP_WARNING.replace(" can use", "\ncan use")));
    expect(checkPosture(tree)).toEqual([]);
  });

  it("R6: docs/legitimacy.md renamed fails; without a read on line fails; without nominative or the phrase fails; README not linking it fails", () => {
    renameSync(join(tree, "docs", "legitimacy.md"), join(tree, "docs", "position.md"));
    expect(checkPosture(tree)).toEqual(["docs/legitimacy.md: missing"]);
    expect(runCheck().status).toBe(1);
    renameSync(join(tree, "docs", "position.md"), join(tree, "docs", "legitimacy.md"));

    edit("docs/legitimacy.md", (text) => text.replace("read on 2026-10-12", "checked in October"));
    expect(checkPosture(tree)).toEqual(['docs/legitimacy.md: no "read on YYYY-MM-DD" line']);
    expect(runCheck().status).toBe(1);
    edit("docs/legitimacy.md", (text) => text.replace("checked in October", "read on 2026-10-12"));

    edit("docs/legitimacy.md", (text) => text.replace("this is nominative use", "this is fair"));
    expect(checkPosture(tree)).toEqual([
      'docs/legitimacy.md: neither the word "nominative" nor the phrase "only to say which platform"',
    ]);
    edit("docs/legitimacy.md", (text) => text.replace("this is fair", "it is used only to say which platform"));
    expect(checkPosture(tree)).toEqual([]);

    edit("README.md", (text) => text.replace("](docs/legitimacy.md)", "](docs/other.md)"));
    expect(checkPosture(tree)).toEqual([
      'README.md: no link to docs/legitimacy.md (a Markdown link target "](docs/legitimacy.md)")',
    ]);
  });

  it("R7: a package.json named @grip/anything fails; a repository.url elsewhere fails; the umbrella description not starting with Unofficial fails; server.json description without Unofficial fails", () => {
    editJson("packages/core/package.json", (value) => {
      value["name"] = "@grip/anything";
    });
    expect(checkPosture(tree)).toEqual(['packages/core/package.json: name starts with @grip/ ("@grip/anything")']);
    expect(runCheck().status).toBe(1);
    editJson("packages/core/package.json", (value) => {
      value["name"] = "@gripeventsctl/core";
    });

    editJson("packages/cli/package.json", (value) => {
      value["repository"] = { type: "git", url: "https://example.com/someone/else.git" };
    });
    expect(checkPosture(tree)).toEqual([
      `packages/cli/package.json: repository.url "https://example.com/someone/else.git" does not point at ${REPOSITORY_URL}`,
    ]);
    editJson("packages/cli/package.json", (value) => {
      value["repository"] = { type: "git", url: `git+${REPOSITORY_URL}.git` };
    });
    expect(checkPosture(tree)).toEqual([]);

    editJson("packages/gripeventsctl/package.json", (value) => {
      value["description"] = "A synthetic CLI, unofficial";
    });
    expect(checkPosture(tree)).toEqual([
      'packages/gripeventsctl/package.json: description does not start with "Unofficial"',
    ]);
    editJson("packages/gripeventsctl/package.json", (value) => {
      value["description"] = "Unofficial synthetic CLI";
    });

    editJson("server.json", (value) => {
      value["description"] = "A synthetic server";
    });
    expect(checkPosture(tree)).toEqual(['server.json: description does not contain "Unofficial"']);
  });

  it("R8: packages/e2e/README.md without the block is not a finding", () => {
    expect(read("packages/e2e/README.md")).not.toContain(DISCLAIMER_HEADING);
    rmSync(join(tree, "packages", "testing"), { recursive: true });
    expect(checkPosture(tree)).toEqual([]);
  });

  it("R9: the repository's own tree passes", () => {
    const run = runCheck([], ROOT);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^posture: \d+ file\(s\) checked, nothing to report\n$/u);
  });

  it("R10: an unknown argument exits 2", () => {
    const run = runCheck(["--strict"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: check-readme-posture");
  });
});
