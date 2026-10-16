#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Test traceability check.
 *
 * Reads the capability catalog `test-capabilities.yaml` at the repository root and the tracked test
 * files (`git ls-files`, like `check-secret-leakage.ts`), and checks that every test file names the
 * capability it covers and that every active capability has a test at each level it declares.
 *
 * The tag: the title of a file's first top-level `describe` call (`describe(`, `describe.skip(`,
 * `describe.only(`, `describe.skipIf(...)(` or `describe.runIf(...)(` at the start of a line) is a
 * string literal that starts with one or more `[CAP-<NAME>]` tags separated by single spaces, then a
 * space and the title text. The title may sit on the line after the opening parenthesis, as Prettier
 * breaks a long call. A template-literal title, or no top-level `describe`, leaves the file untagged.
 *
 * The levels: the catalog declares the levels each capability must have tests at (`U` unit, `C`
 * component, `S` surface, `P` process, `R` repository gate, `L` live, `M` manual). A file's level
 * follows from its path only where the path fixes it: a file under `packages/e2e/src/` ending in
 * `.e2e.test.ts` is `L`, a file under `scripts/__tests__/` is `R`, and every other matched file
 * counts for `U`, `C`, `S` and `P` alike. `M` is never checked: a row whose levels are `[M]` only is
 * satisfied by its `recorded:` field (the pull request or issue comment where the manual runs are
 * recorded) and can never be flipped to `active` by a test file.
 *
 * The oracle report line (`oracle file changed: <path>`) lists the `*.oracle.test.ts` files that
 * differ from the base ref (`GITHUB_BASE_REF`, else `main`). It is best effort and never a failure:
 * in CI the checkout is shallow, and when the base ref is not available the line is skipped with a
 * note.
 *
 * Exit codes:
 *   0: clean
 *   1: findings (one line per finding on stderr, naming the file or the capability)
 *   2: a usage or parse error (the catalog unreadable or malformed)
 *
 * `--strict` additionally fails on any `planned` capability remaining, except a manual-only row whose
 * `recorded` field is set. It is not run in `pnpm lint`; a later item wires it into the release gate.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

/** The tag prefix: one constant, so a rename is this line plus a search over the test titles. */
export const CAP_PREFIX = "CAP-";

/** The catalog file at the repository root. */
export const CATALOG_FILE = "test-capabilities.yaml";

/** The level letters the catalog may declare. */
export const LEVELS = ["U", "C", "S", "P", "R", "L", "M"] as const;
export type Level = (typeof LEVELS)[number];

/** The levels a test file counts for when its path fixes none. */
export const UNFIXED_LEVELS: readonly Level[] = ["U", "C", "S", "P"];

export type Status = "planned" | "active";

export interface Capability {
  id: string;
  description: string;
  levels: Level[];
  status: Status;
  /** Manual-only rows: where the manual runs are recorded. */
  recorded?: string;
}

export interface Catalog {
  capabilities: Capability[];
}

/** What reading a test file's first top-level `describe` gives. */
export type TagResult = { tags: string[]; title: string } | { untagged: string };

/** The first top-level `describe` call: `describe`, `.skip`, `.only`, `.skipIf(...)`, `.runIf(...)`, then `(`. */
const DESCRIBE_CALL = /^describe(?:\.(?:skip|only)|\.(?:skipIf|runIf)\((?:[^()]|\([^()]*\))*\))?\(/mu;

/** A string literal in double or single quotes, on one line. */
const STRING_LITERAL = /^(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/u;

/** `<NAME>` in `[CAP-<NAME>]`. */
const TAG_NAME = "[A-Z][A-Z0-9-]*";

/**
 * The tags of a `describe` title: one or more `[CAP-<NAME>]` separated by single spaces, then a
 * space and the title text. The prefix is escaped so a renamed prefix still forms a valid pattern.
 */
export function tagPattern(prefix = CAP_PREFIX): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const tag = `\\[${escaped}${TAG_NAME}\\]`;
  return new RegExp(`^(${tag}(?: ${tag})*) \\S`, "u");
}

/** Reads the tags of the first top-level `describe` title in `source`. */
export function readTags(source: string, prefix = CAP_PREFIX): TagResult {
  const call = DESCRIBE_CALL.exec(source);
  if (call === null) return { untagged: "no top-level describe call at the start of a line" };
  const rest = source.slice(call.index + call[0].length).replace(/^\s+/u, "");
  const literal = STRING_LITERAL.exec(rest);
  if (literal === null) {
    const reason = rest.startsWith("`") ? "a template literal" : "not a string literal";
    return { untagged: `the first describe title is ${reason}` };
  }
  const title = literal[1] ?? literal[2] ?? "";
  const tagged = tagPattern(prefix).exec(title);
  if (tagged === null) {
    return { untagged: `the first describe title carries no [${prefix}<NAME>] tag: ${JSON.stringify(title)}` };
  }
  const tags = (tagged[1] ?? "").split(" ").map((tag) => tag.slice(1, -1));
  return { tags, title };
}

/** True for a tracked path this check reads: `packages/<pkg>/src/**\/*.test.ts` or `scripts/__tests__/*.test.ts`. */
export function isTestFile(path: string): boolean {
  return (
    /^packages\/[^/]+\/src\/(?:[^/]+\/)*[^/]+\.test\.ts$/u.test(path) ||
    /^scripts\/__tests__\/[^/]+\.test\.ts$/u.test(path)
  );
}

/** The levels a test file counts for, from its path. */
export function levelsOf(path: string): readonly Level[] {
  if (path.startsWith("packages/e2e/src/") && path.endsWith(".e2e.test.ts")) return ["L"];
  if (path.startsWith("scripts/__tests__/")) return ["R"];
  return UNFIXED_LEVELS;
}

/** True for a row that only manual runs can satisfy. */
export function isManualOnly(capability: Capability): boolean {
  return capability.levels.length === 1 && capability.levels[0] === "M";
}

/** Parses the catalog text; the findings name each malformed row. */
export function parseCatalog(text: string): { catalog: Catalog; findings: string[] } {
  const findings: string[] = [];
  const data: unknown = parse(text);
  if (typeof data !== "object" || data === null || !Array.isArray((data as Record<string, unknown>)["capabilities"])) {
    throw new Error(`${CATALOG_FILE}: expected a top-level \`capabilities\` list`);
  }
  const rows = (data as { capabilities: unknown[] }).capabilities;
  const seen = new Set<string>();
  const capabilities: Capability[] = [];
  rows.forEach((row, index) => {
    const label = `${CATALOG_FILE}: row ${String(index + 1)}`;
    if (typeof row !== "object" || row === null) {
      findings.push(`${label}: not a mapping`);
      return;
    }
    const record = row as Record<string, unknown>;
    const id = record["id"];
    const name = typeof id === "string" && id.length > 0 ? id : label;
    let valid = true;
    for (const field of ["id", "description", "levels", "status"]) {
      if (record[field] === undefined || record[field] === null) {
        findings.push(`${name}: missing \`${field}\``);
        valid = false;
      }
    }
    if (typeof id === "string" && !id.startsWith(CAP_PREFIX)) {
      findings.push(`${name}: \`id\` must start with ${CAP_PREFIX}`);
      valid = false;
    }
    if (typeof id === "string" && seen.has(id)) {
      findings.push(`${name}: duplicate id`);
      valid = false;
    }
    if (typeof id === "string") seen.add(id);
    const levels = record["levels"];
    const levelList: Level[] = [];
    if (Array.isArray(levels)) {
      for (const level of levels) {
        if (typeof level === "string" && (LEVELS as readonly string[]).includes(level)) levelList.push(level as Level);
        else {
          findings.push(`${name}: unknown level ${JSON.stringify(level)} (one of ${LEVELS.join(", ")})`);
          valid = false;
        }
      }
      if (levels.length === 0) {
        findings.push(`${name}: \`levels\` is empty`);
        valid = false;
      }
    } else if (levels !== undefined && levels !== null) {
      findings.push(`${name}: \`levels\` must be a list`);
      valid = false;
    }
    const status = record["status"];
    if (status !== undefined && status !== null && status !== "planned" && status !== "active") {
      findings.push(`${name}: \`status\` must be planned or active`);
      valid = false;
    }
    const recorded = record["recorded"];
    if (recorded !== undefined && recorded !== null && typeof recorded !== "string") {
      findings.push(`${name}: \`recorded\` must be a string`);
      valid = false;
    }
    if (!valid || typeof id !== "string" || typeof record["description"] !== "string") {
      if (valid) findings.push(`${name}: \`id\` and \`description\` must be strings`);
      return;
    }
    capabilities.push({
      id,
      description: record["description"],
      levels: levelList,
      status: status as Status,
      ...(typeof recorded === "string" ? { recorded } : {}),
    });
  });
  return { catalog: { capabilities }, findings };
}

export interface TaggedFile {
  path: string;
  tags: string[];
  levels: readonly Level[];
}

export interface Grade {
  findings: string[];
  report: string[];
  planned: string[];
}

/** Grades the tagged files against the catalog. `strict` adds the planned-capability findings. */
export function grade(catalog: Catalog, files: TaggedFile[], strict: boolean): Grade {
  const findings: string[] = [];
  const report: string[] = [];
  const planned: string[] = [];
  const byId = new Map(catalog.capabilities.map((capability) => [capability.id, capability]));

  for (const file of files) {
    for (const tag of file.tags) {
      if (!byId.has(tag)) findings.push(`${file.path}: tag [${tag}] is not in ${CATALOG_FILE}`);
    }
  }

  for (const capability of catalog.capabilities) {
    const tagged = files.filter((file) => file.tags.includes(capability.id));
    const manualOnly = isManualOnly(capability);
    const counts = capability.levels.map(
      (level) => `${level}:${String(tagged.filter((file) => file.levels.includes(level)).length)}`,
    );

    if (manualOnly) {
      for (const file of tagged) {
        findings.push(`${capability.id}: manual-only, yet ${file.path} is tagged with it: no test file can satisfy it`);
      }
      if (capability.status === "active") {
        findings.push(`${capability.id}: manual-only rows are never active; set \`recorded\` instead`);
      }
      const recorded = capability.recorded === undefined ? "not recorded" : `recorded: ${capability.recorded}`;
      report.push(`${capability.id} planned (manual, ${recorded})`);
      if (capability.recorded === undefined) {
        planned.push(capability.id);
        if (strict) findings.push(`${capability.id}: planned (manual, not recorded)`);
      }
      continue;
    }

    if (capability.status === "planned") {
      for (const file of tagged) {
        findings.push(`${capability.id}: planned, yet ${file.path} is tagged with it: flip it to active`);
      }
      planned.push(capability.id);
      if (strict) findings.push(`${capability.id}: planned`);
    } else {
      for (const level of capability.levels) {
        if (level === "M") continue;
        if (!tagged.some((file) => file.levels.includes(level))) {
          findings.push(`${capability.id}: active, yet no tagged test file at level ${level}`);
        }
      }
    }
    report.push(`${capability.id} ${capability.status} ${counts.join(" ")}`);
  }

  return { findings, report, planned };
}

/** Every tracked path, NUL-separated so a path holding a byte outside printable ASCII stays whole. */
export function listTrackedFiles(repoRoot: string): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((path) => path.length > 0);
}

/**
 * The `*.oracle.test.ts` files that differ from the base ref, or `undefined` with a note when the
 * base is not available (a shallow checkout, a missing branch).
 */
export function changedOracleFiles(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { files: string[] } | { skipped: string } {
  const base = env["GITHUB_BASE_REF"] !== undefined && env["GITHUB_BASE_REF"] !== "" ? env["GITHUB_BASE_REF"] : "main";
  const candidates = [base, `origin/${base}`];
  for (const candidate of candidates) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      continue;
    }
    try {
      const stdout = execFileSync(
        "git",
        ["diff", "--name-only", "-z", `${candidate}...HEAD`, "--", "*.oracle.test.ts"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return { files: stdout.split("\0").filter((path) => path.length > 0) };
    } catch {
      return { skipped: `the diff against ${candidate} failed (no merge base in a shallow checkout?)` };
    }
  }
  return { skipped: `base ref ${base} is not available (not fetched, or the branch does not exist)` };
}

export function main(argv: readonly string[] = process.argv.slice(2), repoRoot: string = process.cwd()): number {
  const strict = argv.includes("--strict");
  const unknown = argv.filter((arg) => arg !== "--strict");
  if (unknown.length > 0) {
    process.stderr.write(`usage: check-test-traceability [--strict] (unknown argument ${unknown.join(" ")})\n`);
    return 2;
  }

  let parsed: ReturnType<typeof parseCatalog>;
  try {
    parsed = parseCatalog(readFileSync(join(repoRoot, CATALOG_FILE), "utf8"));
  } catch (error: unknown) {
    process.stderr.write(`${CATALOG_FILE}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const findings = [...parsed.findings];
  const files: TaggedFile[] = [];
  for (const path of listTrackedFiles(repoRoot).filter(isTestFile).sort()) {
    const result = readTags(readFileSync(join(repoRoot, path), "utf8"));
    if ("untagged" in result) {
      findings.push(`${path}: untagged (${result.untagged})`);
      continue;
    }
    files.push({ path, tags: result.tags, levels: levelsOf(path) });
  }

  const graded = grade(parsed.catalog, files, strict);
  findings.push(...graded.findings);

  for (const line of graded.report) process.stdout.write(`${line}\n`);
  process.stdout.write(`planned: ${graded.planned.length === 0 ? "(none)" : graded.planned.join(", ")}\n`);
  const oracles = changedOracleFiles(repoRoot);
  if ("skipped" in oracles) process.stdout.write(`oracle diff skipped: ${oracles.skipped}\n`);
  else for (const path of oracles.files) process.stdout.write(`oracle file changed: ${path}\n`);

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stderr.write(
      `\nFAIL: ${String(findings.length)} finding(s). Every test file's first describe title starts with its [${CAP_PREFIX}<NAME>] tags from ${CATALOG_FILE}; a capability's first tagged test flips its row to active.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `\n${String(files.length)} test file(s) traced to ${String(parsed.catalog.capabilities.length)} capability(ies).\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
