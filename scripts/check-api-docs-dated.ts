#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * API docs dating check.
 *
 * Reads the tracked `docs/api/*.md` pages (`git ls-files -z`, like the other gates) and the operation registry
 * (`OPERATIONS` from `packages/core/src/operations/registry.ts`), and checks two things.
 *
 * Dating: a page is dated when it holds at least one `Verified live YYYY-MM-DD` label with digits for the date. The
 * literal placeholder `Verified live YYYY-MM-DD` of the label table in `docs/api/README.md` does not count. Each page
 * gets one report line: `dated <page> <latest date>`, `undated <page>` or `exempt <page>`.
 *
 * Exempt pages: `EXEMPT_PAGES` below. `not-verified.md` is the index of undated claims by design. `README.md` and
 * `platform-landscape.md` hold no request shape and carry no dated label today; they stay exempt until the maintainer
 * either dates them or removes them from the constant. That is the maintainer's call, not this script's.
 *
 * Anchors: every `requests[]` entry of every operation names a `page` that must be a tracked page under `docs/api/`
 * and a `section` that must equal the text of one `##`, `###` or `####` heading of that page, compared after trimming.
 * A heading inside a fenced code block does not count, nor does a `#` heading. A missing page or heading is a finding
 * in both modes: it is a broken reference, not a dating gap.
 *
 * Modes:
 *   report (default): the report lines and the anchor findings.
 *   --strict:         the same, plus one finding per non-exempt undated page. Run before a tag and in the release
 *                     `validate` job.
 *
 * Exit codes:
 *   0: clean (report mode: no anchor finding; strict mode: no anchor finding and no undated non-exempt page)
 *   1: findings (one line per finding on stderr, then a FAIL footer)
 *   2: a usage error, `docs/api/` missing, or the registry could not be imported
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder the pages live in, relative to the repository root. */
export const API_DOCS_DIR = "docs/api";

/** Pages that carry no dated label by design or for now; see the header. */
export const EXEMPT_PAGES: readonly string[] = Object.freeze(["not-verified.md", "README.md", "platform-landscape.md"]);

/** A dated label; the capture is the date. The digits exclude the `YYYY-MM-DD` placeholder. */
export const DATED_LABEL = /Verified live (\d{4}-\d{2}-\d{2})/g;

/** The registry module, relative to this script, imported as `check-secret-leakage.ts` imports `redact.js`. */
const REGISTRY_MODULE = "../packages/core/src/operations/registry.js";

/** The part of an operation this check reads: no zod, so a test can pass a plain list. */
export interface OperationAnchors {
  group: string;
  verb: string;
  requests: readonly { page: string; section: string }[];
}

/** An opening or closing code fence: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/** A closing code fence: the fence run alone on its line. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;

/** An ATX heading of level two to four: up to three spaces, the hashes, then a space or tab and the text. */
const HEADING = /^ {0,3}#{2,4}(?:[ \t]+(.*))?$/u;

/** The text of every `##`, `###` and `####` heading in `markdown`, trimmed, outside fenced code blocks. */
export function headingsOf(markdown: string): string[] {
  const headings: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    if (fence !== undefined) {
      // A closing fence: the same character, at least as long, and nothing but spaces after it.
      const closer = CLOSING_FENCE.exec(line)?.[1];
      if (closer?.[0] === fence[0] && closer.length >= fence.length) fence = undefined;
      continue;
    }
    const opener = FENCE.exec(line);
    if (opener !== null) {
      fence = opener[1];
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading === null) continue;
    // An optional closing sequence of hashes, preceded by a space, is not part of the text.
    const text = (heading[1] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/u, "").trim();
    headings.push(text);
  }
  return headings;
}

/** The latest date among the dated labels of `markdown`, or `undefined` when it holds none. */
export function latestDate(markdown: string): string | undefined {
  let latest: string | undefined;
  for (const match of markdown.matchAll(DATED_LABEL)) {
    const date = match[1];
    if (date !== undefined && (latest === undefined || date > latest)) latest = date;
  }
  return latest;
}

/** One report line per page in sorted page order; in strict mode, one finding per undated non-exempt page. */
export function gradePages(pages: Map<string, string>, strict: boolean): { report: string[]; findings: string[] } {
  const report: string[] = [];
  const findings: string[] = [];
  for (const page of [...pages.keys()].sort()) {
    if (EXEMPT_PAGES.includes(page)) {
      report.push(`exempt ${page}`);
      continue;
    }
    const date = latestDate(pages.get(page) ?? "");
    if (date !== undefined) {
      report.push(`dated ${page} ${date}`);
      continue;
    }
    report.push(`undated ${page}`);
    if (strict) findings.push(`undated ${page}: no "Verified live YYYY-MM-DD" label (strict)`);
  }
  return { report, findings };
}

/** One finding per request shape whose page is not a tracked page or whose section is not a heading of it. */
export function checkAnchors(operations: readonly OperationAnchors[], pages: Map<string, string>): string[] {
  const findings: string[] = [];
  const headings = new Map<string, Set<string>>();
  for (const operation of operations) {
    for (const request of operation.requests) {
      const name = `anchor ${operation.group} ${operation.verb}`;
      const markdown = pages.get(request.page);
      if (markdown === undefined) {
        findings.push(`${name}: page ${request.page} is missing (section "${request.section}")`);
        continue;
      }
      let set = headings.get(request.page);
      if (set === undefined) {
        set = new Set(headingsOf(markdown));
        headings.set(request.page, set);
      }
      if (!set.has(request.section.trim())) {
        findings.push(`${name}: section "${request.section}" not found on ${request.page}`);
      }
    }
  }
  return findings;
}

/** The tracked `docs/api/*.md` pages, by file name, with their content. Pages in subfolders are not read. */
export function readTrackedPages(repoRoot: string): Map<string, string> {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", `${API_DOCS_DIR}/*.md`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages = new Map<string, string>();
  const direct = new RegExp(`^${API_DOCS_DIR}/([^/]+\\.md)$`, "u");
  for (const path of stdout.split("\0").sort()) {
    const name = direct.exec(path)?.[1];
    if (name === undefined) continue;
    pages.set(name, readFileSync(join(repoRoot, path), "utf8"));
  }
  return pages;
}

/** Imports the real registry. */
export async function loadRegistry(): Promise<readonly OperationAnchors[]> {
  const module = (await import(REGISTRY_MODULE)) as { OPERATIONS?: unknown };
  if (!Array.isArray(module.OPERATIONS)) throw new Error("the module does not export an OPERATIONS list");
  return module.OPERATIONS as readonly OperationAnchors[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  repoRoot: string = process.cwd(),
  loadOperations: () => Promise<readonly OperationAnchors[]> = loadRegistry,
): Promise<number> {
  const strict = argv.includes("--strict");
  const unknown = argv.filter((arg) => arg !== "--strict");
  if (unknown.length > 0) {
    process.stderr.write(`usage: check-api-docs-dated [--strict] (unknown argument ${unknown.join(" ")})\n`);
    return 2;
  }

  if (!isDirectory(join(repoRoot, API_DOCS_DIR))) {
    process.stderr.write(`${API_DOCS_DIR}/ not found under ${repoRoot}\n`);
    return 2;
  }

  let operations: readonly OperationAnchors[];
  try {
    operations = await loadOperations();
  } catch (error: unknown) {
    process.stderr.write(
      `the operation registry could not be imported: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const pages = readTrackedPages(repoRoot);
  const graded = gradePages(pages, strict);
  const findings = [...checkAnchors(operations, pages), ...graded.findings];
  const anchors = operations.reduce((count, operation) => count + operation.requests.length, 0);

  for (const line of graded.report) process.stdout.write(`${line}\n`);

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stderr.write(
      `\nFAIL: ${String(findings.length)} finding(s). Every registry request shape names a tracked ${API_DOCS_DIR}/ page and one of its ##, ### or #### headings${strict ? `; every page outside EXEMPT_PAGES carries a "Verified live YYYY-MM-DD" label from a real run` : ""}.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `\n${String(pages.size)} page(s) graded, ${String(anchors)} anchor(s) checked${strict ? " (strict)" : ""}.\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(await main());
}
