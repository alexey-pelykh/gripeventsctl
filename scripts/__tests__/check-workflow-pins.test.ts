// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Self-tests for `scripts/check-workflow-pins.ts`. Each case writes a temporary tree the script
 * passes over, breaks it in one place, and runs every rule over it: exactly the broken rule fires.
 * The script reads files only, so the tree needs no git. The conforming `uses:` lines are the
 * repository's own SHA pins; every other name, URL and digest is synthetic.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Finding,
  RULES,
  formatFinding,
  loadInput,
  packageSpecProblem,
  runRules,
  unpinnedInstalls,
} from "../check-workflow-pins.js";

const SCRIPT = fileURLToPath(new URL("../check-workflow-pins.ts", import.meta.url));
const BASELINE = fileURLToPath(new URL("./fixtures/release-baseline.yml", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const TSX_CLI = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

const RELEASE = ".github/workflows/release.yml";
const CI = ".github/workflows/ci.yml";
const SETUP = ".github/actions/setup/action.yml";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const RELEASE_YML = `name: Release

on:
  release:
    types: [published]

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
        with:
          fetch-depth: 0
      - uses: ./.github/actions/setup
      - run: pnpm check-secret-leakage --history
      - run: pnpm check-api-docs-dated --strict
      - run: pnpm check-test-traceability --strict

  publish-npm:
    needs: validate
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: ${CHECKOUT}
      - uses: ./.github/actions/setup
      - name: Upgrade npm
        run: npm install -g npm@12.2.0
      - name: Publish
        run: pnpm --filter example-package publish --provenance

  sbom:
    needs: publish-npm
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: ${CHECKOUT}
      - name: Install cdxgen
        run: npm install -g "@cyclonedx/cdxgen@12.3.3"

  publish-mcp-registry:
    needs: publish-npm
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: ${CHECKOUT}
      - name: Download and publish
        run: |
          curl -fsSL -o mcp-publisher.tar.gz "https://example.invalid/example-org/example-registry/releases/download/v1.8.1/mcp-publisher_linux_amd64.tar.gz"
          echo "${DIGEST}  mcp-publisher.tar.gz" | sha256sum -c -
          tar xzf mcp-publisher.tar.gz mcp-publisher
          ./mcp-publisher login github-oidc
          ./mcp-publisher publish
`;

const CI_YML = `name: CI

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  ci:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node-version: ["22", "24"]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: ${CHECKOUT}
      - uses: ./.github/actions/setup
        with:
          node-version: \${{ matrix.node-version }}
      - run: pnpm test
`;

const SETUP_YML = `name: Setup
description: Install pnpm, Node.js, and dependencies

runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
    - uses: actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238 # v6.2.0
      with:
        node-version: "24"
    - run: pnpm install --frozen-lockfile --ignore-scripts
      shell: bash
`;

function manifest(name: string, node: string): string {
  return `${JSON.stringify({ name, version: "0.0.0", engines: { node } }, null, 2)}\n`;
}

let dir: string;

function write(relativePath: string, content: string): void {
  const absolute = join(dir, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function read(relativePath: string): string {
  return readFileSync(join(dir, ...relativePath.split("/")), "utf8");
}

/** Replaces `from` with `to` in a tree file, failing when `from` is absent so no fixture is vacuous. */
function mutate(relativePath: string, from: string, to: string): void {
  const content = read(relativePath);
  expect(content, `${relativePath} holds the text the fixture replaces`).toContain(from);
  write(relativePath, content.replace(from, to));
}

/** A minimal tree every rule passes over. */
function conformingTree(): void {
  write(RELEASE, RELEASE_YML);
  write(CI, CI_YML);
  write(SETUP, SETUP_YML);
  write("package.json", manifest("example-workspace", ">=22.19.0"));
  write("packages/x/package.json", manifest("@example/x", ">=22.19.0"));
}

function findings(): Finding[] {
  return runRules(loadInput(dir));
}

/** Runs every rule over the tree and asserts that `rule` alone fires. */
function onlyRule(rule: number): Finding[] {
  const found = findings();
  expect(new Set(found.map((finding) => finding.rule))).toEqual(new Set([rule]));
  return found;
}

function runCheck(cwd: string = dir): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 60_000,
  });
  if (run.error !== undefined) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gripeventsctl-workflow-pins-"));
  conformingTree();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("[CAP-RELEASE] the workflow pin check over a temporary tree", () => {
  it("R1: the conforming tree yields no finding and the script exits 0", () => {
    expect(findings()).toEqual([]);
    const run = runCheck();
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("2 workflow(s), 1 composite action(s), 2 package manifest(s): 10 rules, no finding.");
    expect(run.status).toBe(0);
  });

  it("R2: rule 1 fails an action pinned by tag, in a workflow step and in a composite action step", () => {
    mutate(
      RELEASE,
      `uses: ${CHECKOUT}\n        with:\n          fetch-depth: 0`,
      "uses: actions/checkout@v7\n        with:\n          fetch-depth: 0",
    );
    const workflow = onlyRule(1);
    expect(workflow).toEqual([expect.objectContaining({ file: RELEASE, job: "validate", rule: 1 })]);
    expect(workflow[0]?.message).toContain("actions/checkout@v7");

    write(RELEASE, RELEASE_YML);
    mutate(SETUP, "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413", "pnpm/action-setup@main");
    const action = onlyRule(1);
    expect(action).toHaveLength(1);
    expect(action[0]).toMatchObject({ file: SETUP, rule: 1 });
    expect(action[0]?.job).toBeUndefined();
  });

  it("R3: rule 2 fails an unpinned install in the id-token job, quoted or not, for npm, npx and pnpm dlx", () => {
    mutate(RELEASE, "run: npm install -g npm@12.2.0", 'run: npm install -g "npm@>=11.5.1"');
    const quoted = onlyRule(2);
    expect(quoted).toEqual([expect.objectContaining({ file: RELEASE, job: "publish-npm", rule: 2 })]);
    expect(quoted[0]?.message).toContain("npm@>=11.5.1");

    write(RELEASE, RELEASE_YML);
    mutate(
      RELEASE,
      "run: npm install -g npm@12.2.0",
      "run: |\n          npx --yes example-tool@1.x --check\n          pnpm dlx example-runner",
    );
    const runners = onlyRule(2);
    expect(runners.map((finding) => finding.message)).toEqual([
      expect.stringContaining("npx example-tool@1.x: version 1.x is not exact"),
      expect.stringContaining("pnpm dlx example-runner: missing a version"),
    ]);
  });

  it("R4: rule 3 fails cdxgen moved into the job that holds id-token: write", () => {
    mutate(
      RELEASE,
      "      - name: Publish\n        run: pnpm --filter",
      '      - name: Install cdxgen\n        run: npm install -g "@cyclonedx/cdxgen@12.3.3"\n      - name: Publish\n        run: pnpm --filter',
    );
    const found = onlyRule(3);
    expect(found).toEqual([expect.objectContaining({ file: RELEASE, job: "publish-npm", rule: 3 })]);
    expect(found[0]?.message).toContain('step "Install cdxgen"');
  });

  it("R5: rule 4 fails a download from releases/latest/download, an unchecked download, and a run before the check", () => {
    mutate(RELEASE, "releases/download/v1.8.1/", "releases/latest/download/");
    const latest = onlyRule(4);
    expect(latest).toEqual([expect.objectContaining({ file: RELEASE, job: "publish-mcp-registry", rule: 4 })]);
    expect(latest[0]?.message).toContain("releases/latest/download");

    write(RELEASE, RELEASE_YML);
    mutate(RELEASE, `          echo "${DIGEST}  mcp-publisher.tar.gz" | sha256sum -c -\n`, "");
    const unchecked = onlyRule(4);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]?.message).toContain("without checking it with sha256sum -c");

    write(RELEASE, RELEASE_YML);
    mutate(
      RELEASE,
      `          echo "${DIGEST}  mcp-publisher.tar.gz" | sha256sum -c -\n          tar xzf mcp-publisher.tar.gz mcp-publisher\n          ./mcp-publisher login github-oidc\n`,
      `          tar xzf mcp-publisher.tar.gz mcp-publisher\n          ./mcp-publisher login github-oidc\n          echo "${DIGEST}  mcp-publisher.tar.gz" | sha256sum -c -\n`,
    );
    const late = onlyRule(4);
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain("executes mcp-publisher before the checksum check");
  });

  it("R6: rule 5 fails the validate job without fetch-depth: 0, and once per strict run it lacks", () => {
    mutate(RELEASE, "        with:\n          fetch-depth: 0\n", "");
    const shallow = onlyRule(5);
    expect(shallow).toEqual([expect.objectContaining({ file: RELEASE, job: "validate", rule: 5 })]);
    expect(shallow[0]?.message).toContain("fetch-depth");

    write(RELEASE, RELEASE_YML);
    mutate(RELEASE, "      - run: pnpm check-api-docs-dated --strict\n", "");
    const missing = onlyRule(5);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toBe("does not run pnpm check-api-docs-dated --strict");

    write(RELEASE, RELEASE_YML);
    mutate(
      RELEASE,
      "      - run: pnpm check-secret-leakage --history\n      - run: pnpm check-api-docs-dated --strict\n      - run: pnpm check-test-traceability --strict\n",
      "      - run: |\n          pnpm check-secret-leakage --history\n          pnpm check-api-docs-dated --strict\n          pnpm check-test-traceability --strict\n",
    );
    expect(findings()).toEqual([]);
  });

  it("R7: rule 6 fails the registry job's wrong permissions or needs, and a release.yml with no registry job", () => {
    mutate(RELEASE, "      contents: read\n      id-token: write\n", "      contents: write\n      id-token: write\n");
    const permissions = onlyRule(6);
    expect(permissions).toEqual([expect.objectContaining({ file: RELEASE, job: "publish-mcp-registry", rule: 6 })]);
    expect(permissions[0]?.message).toContain("permissions are");

    write(RELEASE, RELEASE_YML);
    mutate(
      RELEASE,
      "  publish-mcp-registry:\n    needs: publish-npm\n",
      "  publish-mcp-registry:\n    needs: validate\n",
    );
    const needs = onlyRule(6);
    expect(needs).toHaveLength(1);
    expect(needs[0]?.message).toContain("does not include publish-npm");

    write(RELEASE, RELEASE_YML.slice(0, RELEASE_YML.indexOf("  publish-mcp-registry:")));
    const missing = onlyRule(6);
    expect(missing).toEqual([
      {
        file: RELEASE,
        rule: 6,
        message: "no job's steps run mcp-publisher publish: the MCP registry job is missing",
      },
    ]);
  });

  it("R8: rule 7 fails the setup action's pnpm install without --ignore-scripts", () => {
    mutate(SETUP, "pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --frozen-lockfile");
    const found = onlyRule(7);
    expect(found).toEqual([expect.objectContaining({ file: SETUP, rule: 7 })]);
    expect(found[0]?.message).toContain("without --ignore-scripts");
    expect(found[0]?.job).toBeUndefined();
  });

  it("R9: rule 8 fails a CI matrix that drops Node 24", () => {
    mutate(CI, 'node-version: ["22", "24"]', 'node-version: ["22"]');
    expect(onlyRule(8)).toEqual([expect.objectContaining({ file: CI, job: "ci", rule: 8 })]);
  });

  it("R10: rule 9 fails a package manifest whose engines.node is not >=22.19.0", () => {
    write("packages/x/package.json", manifest("@example/x", ">=22.0.0"));
    const found = onlyRule(9);
    expect(found).toEqual([
      { file: "packages/x/package.json", rule: 9, message: 'engines.node is ">=22.0.0", not >=22.19.0' },
    ]);
  });

  it("R11: rule 10 fails a workflow whose top-level permissions are write-all", () => {
    mutate(RELEASE, "permissions:\n  contents: read\n\njobs:", "permissions: write-all\n\njobs:");
    expect(onlyRule(10)).toEqual([expect.objectContaining({ file: RELEASE, rule: 10 })]);
  });

  it("R12: the baseline release.yml fails rules 2, 3, 5 and 6 and no other", () => {
    copyFileSync(BASELINE, join(dir, ...RELEASE.split("/")));
    const found = findings();
    expect(new Set(found.map((finding) => finding.rule))).toEqual(new Set([2, 3, 5, 6]));
    const byRule = (rule: number): Finding[] => found.filter((finding) => finding.rule === rule);
    expect(byRule(2)).toEqual([expect.objectContaining({ file: RELEASE, job: "publish-npm" })]);
    expect(byRule(2)[0]?.message).toContain("npm@>=11.5.1");
    expect(byRule(3).map((finding) => [finding.job, finding.message])).toEqual([
      ["publish-npm", expect.stringContaining('step "Install cdxgen"')],
      ["publish-npm", expect.stringContaining('step "Generate CycloneDX SBOMs"')],
    ]);
    expect(byRule(5).map((finding) => finding.message)).toEqual([
      expect.stringContaining("fetch-depth"),
      "does not run pnpm check-secret-leakage --history",
      "does not run pnpm check-api-docs-dated --strict",
      "does not run pnpm check-test-traceability --strict",
    ]);
    expect(byRule(6)).toEqual([
      {
        file: RELEASE,
        rule: 6,
        message: "no job's steps run mcp-publisher publish: the MCP registry job is missing",
      },
    ]);
  });

  it("R13: the repository's own tree passes", () => {
    const run = runCheck(REPO_ROOT);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("no finding.");
    expect(run.status).toBe(0);
  });

  it("R14: a workflow that does not parse exits 2 naming the file", () => {
    write(".github/workflows/broken.yml", "jobs: [unclosed\n");
    const run = runCheck();
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(".github/workflows/broken.yml: YAML parse error");
  });

  it("R15: the finding line names the file, the job and the rule", () => {
    mutate(RELEASE, "run: npm install -g npm@12.2.0", 'run: npm install -g "npm@>=11.5.1"');
    write(RELEASE, read(RELEASE).slice(0, read(RELEASE).indexOf("  publish-mcp-registry:")));
    const run = runCheck();
    expect(run.status).toBe(1);
    const lines = run.stderr.split("\n");
    expect(lines).toContain(
      `${RELEASE}: job publish-npm: rule 2 (exact package versions in id-token jobs): step "Upgrade npm" runs npm install -g npm@>=11.5.1: version >=11.5.1 is not exact`,
    );
    expect(lines).toContain(
      `${RELEASE}: rule 6 (MCP registry job: needs publish-npm, least privilege): no job's steps run mcp-publisher publish: the MCP registry job is missing`,
    );
    expect(run.stderr).toContain("FAIL: 2 finding(s).");
  });

  it("R16: a missing .github/workflows/, an unparsable package.json or a missing root package.json exits 2", () => {
    write("packages/x/package.json", "{ not json\n");
    const json = runCheck();
    expect(json.status).toBe(2);
    expect(json.stderr).toContain("packages/x/package.json: JSON parse error");

    rmSync(join(dir, "package.json"));
    const root = runCheck();
    expect(root.status).toBe(2);
    expect(root.stderr).toContain("package.json: cannot read");

    rmSync(join(dir, ".github", "workflows"), { recursive: true, force: true });
    const workflows = runCheck();
    expect(workflows.status).toBe(2);
    expect(workflows.stderr).toContain(".github/workflows/: not found");
  });

  it("R17: a job with no permissions of its own inherits an id-token right from the top level", () => {
    mutate(
      RELEASE,
      "permissions:\n  contents: read\n\njobs:",
      "permissions:\n  contents: read\n  id-token: write\n\njobs:",
    );
    mutate(
      RELEASE,
      "      - run: pnpm check-secret-leakage --history\n",
      "      - run: pnpm check-secret-leakage --history\n      - run: npx example-tool\n",
    );
    const found = findings();
    expect(new Set(found.map((finding) => finding.rule))).toEqual(new Set([2, 10]));
    expect(found.find((finding) => finding.rule === 2)).toMatchObject({ job: "validate" });
    expect(found.find((finding) => finding.rule === 2)?.message).toContain("inherited from the top-level permissions");
  });
});

describe("[CAP-RELEASE] the rule table and the package spec reader", () => {
  it("R18: the rule table holds rules 1 to 10 once each, in order, each with a description", () => {
    expect(RULES.map((rule) => rule.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const rule of RULES) expect(rule.description.length).toBeGreaterThan(0);
  });

  it("R19: an exact version passes and a range, a tag, an x component or no version fails", () => {
    expect(packageSpecProblem("npm@11.6.0")).toBeUndefined();
    expect(packageSpecProblem("@cyclonedx/cdxgen@12.3.3")).toBeUndefined();
    expect(packageSpecProblem("example-tool@1.0.0-rc.1")).toBeUndefined();
    expect(packageSpecProblem("npm@>=11.5.1")).toBe("version >=11.5.1 is not exact");
    expect(packageSpecProblem("npm@^11.5.1")).toBe("version ^11.5.1 is not exact");
    expect(packageSpecProblem("npm@~11.5.1")).toBe("version ~11.5.1 is not exact");
    expect(packageSpecProblem("npm@<12")).toBe("version <12 is not exact");
    expect(packageSpecProblem("npm@*")).toBe("version * is not exact");
    expect(packageSpecProblem("npm@1.x")).toBe("version 1.x is not exact");
    expect(packageSpecProblem("npm@x")).toBe("version x is not exact");
    expect(packageSpecProblem("npm@latest")).toBe("version latest is not exact");
    expect(packageSpecProblem("npm")).toBe("missing a version");
    expect(packageSpecProblem("npm@")).toBe("missing a version");
    expect(packageSpecProblem("@cyclonedx/cdxgen")).toBe("missing a version");
  });

  it("R20: every spec of npm install -g is read, flags are skipped, and npx inside a word is not a command", () => {
    expect(unpinnedInstalls("npm install -g --no-fund npm@12.2.0 example-tool@^2 && echo done")).toEqual([
      { command: "npm install -g", spec: "example-tool@^2", problem: "version ^2 is not exact" },
    ]);
    expect(unpinnedInstalls("npm i -g \\\n  example-tool")).toEqual([
      { command: "npm i -g", spec: "example-tool", problem: "missing a version" },
    ]);
    expect(unpinnedInstalls("pnpx example-tool; echo npx-free; pnpm --filter x exec tsc")).toEqual([]);
    expect(unpinnedInstalls("npx example-tool@2.0.0 --flag value")).toEqual([]);
  });

  it("R21: formatFinding omits the job part for a finding against the file", () => {
    expect(formatFinding({ file: "package.json", rule: 9, message: "m" })).toBe(
      "package.json: rule 9 (engines.node is >=22.19.0): m",
    );
    expect(formatFinding({ file: CI, job: "ci", rule: 8, message: "m" })).toBe(
      `${CI}: job ci: rule 8 (CI matrix: three OSes, Node 22 and 24): m`,
    );
  });
});
