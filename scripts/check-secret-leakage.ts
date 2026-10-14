#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Secret-leakage guard.
 *
 * Scans every tracked file for the secret shapes GripEventsCtl handles (`SECRET_PATTERN_SOURCES`, each
 * named in `SECRET_SHAPES`) and fails when one is found. A match in tracked source is almost certainly
 * a leak: a token that landed in a fixture, a snapshot or a captured response during local
 * development. Each file is matched as a whole, not line by line, so a pretty-printed capture whose
 * key context sits on an earlier line than the value is caught too; a finding is reported at the line
 * its match starts on, with the name of its shape and a prefix of the match redacted, and the FAIL
 * message gives the remedy `SECRET_SHAPES` names for each shape found.
 *
 * The patterns live ONCE, in `packages/core/src/lib/redact.ts`, and are consumed by both this
 * lint-time check and the runtime redaction path. Extending either side means extending
 * `redact.ts`; this script picks the change up automatically.
 *
 * Scope:
 *   - Tracked files only (`git ls-files`); untracked and git-ignored files are not the concern.
 *   - Excludes `.tmp/` (where captured tokens may legitimately sit), binary files, lockfiles,
 *     this script, the source-of-truth module and the test that exercises it.
 *
 * Exit codes:
 *   0: no match in tracked source (clean)
 *   1: one or more matches found; each is reported with file and line
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SECRET_PATTERN_SOURCES, SECRET_SHAPES, redactString } from "../packages/core/src/lib/redact.js";

const EXCLUDED_PATH_PREFIXES = [
  ".tmp/",
  "node_modules/",
  "scripts/check-secret-leakage.ts",
  "packages/core/src/lib/redact.ts",
  "packages/core/src/__tests__/redact.test.ts",
];

const EXCLUDED_EXTENSIONS = new Set<string>([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".ico",
  ".lock",
]);

const EXCLUDED_FILENAMES = new Set<string>(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

function shouldSkipPath(relativePath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (relativePath === prefix || relativePath.startsWith(prefix)) return true;
  }
  const lastSlash = relativePath.lastIndexOf("/");
  const filename = lastSlash >= 0 ? relativePath.slice(lastSlash + 1) : relativePath;
  if (EXCLUDED_FILENAMES.has(filename)) return true;
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0) {
    const ext = filename.slice(lastDot).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function listTrackedFiles(repoRoot: string): string[] {
  const stdout = execSync("git ls-files", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A pattern the lint applies, with the name and the remedy `SECRET_SHAPES` gives its source. */
interface Shape {
  source: string;
  name: string;
  remedy: string;
}

// Every source of SECRET_PATTERN_SOURCES, named from SECRET_SHAPES; a source with no entry there is still matched.
const SHAPES: Shape[] = SECRET_PATTERN_SOURCES.map((source) => {
  const shape = SECRET_SHAPES.find((candidate) => candidate.source === source);
  return { source, name: shape?.name ?? "a secret-shaped value", remedy: shape?.remedy ?? "remove it" };
});

interface Finding {
  line: number;
  match: string;
  shape: Shape;
}

function scanFile(filePath: string): Finding[] {
  let content: string;
  try {
    const stat = statSync(filePath);
    if (stat.size > 1024 * 1024) return [];
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  for (const shape of SHAPES) {
    const pattern = new RegExp(shape.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // Every pattern matches at least one character; the guard keeps an empty match from looping forever.
      if (match[0].length === 0) pattern.lastIndex += 1;
      // Report the shape, never the value: the value is what must not reach a log. The prefix is taken from the match
      // redacted, so it holds the key or the scheme word and `<REDACTED>`, never a character of the value. A match may
      // span lines, so the prefix collapses whitespace runs to one space and stays at most 12 characters.
      const prefix = redactString(match[0]).replace(/\s+/g, " ").slice(0, 12);
      findings.push({
        line: lineOf(content, match.index),
        match: `${prefix}… (${String(match[0].length)} chars)`,
        shape,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * The FAIL message: what to do with every finding, then one line per remedy the shapes found need, naming those
 * shapes in the order the patterns list them.
 */
function failMessage(findings: readonly Finding[]): string {
  const byRemedy = new Map<string, Set<string>>();
  for (const shape of SHAPES) {
    if (!findings.some((finding) => finding.shape.source === shape.source)) continue;
    const names = byRemedy.get(shape.remedy) ?? new Set<string>();
    names.add(shape.name);
    byRemedy.set(shape.remedy, names);
  }
  const remedies = [...byRemedy].map(([remedy, names]) => `  - ${[...names].join("; ")}: ${remedy}.\n`);
  return (
    `\nFAIL: found ${String(findings.length)} secret-shaped value(s) in tracked source; none may appear in committed code.\n` +
    `Remove each value, or move its file under .tmp/ (git-ignored); a value already committed stays in the history until that commit is rewritten. If a value is real:\n` +
    remedies.join("")
  );
}

/** The 1-based line `offset` falls on: one more than the number of newlines before it. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (
    let newline = content.indexOf("\n");
    newline !== -1 && newline < offset;
    newline = content.indexOf("\n", newline + 1)
  ) {
    line += 1;
  }
  return line;
}

function main(): void {
  const repoRoot = process.cwd();
  const tracked = listTrackedFiles(repoRoot);

  const allFindings: Finding[] = [];
  for (const relativePath of tracked) {
    if (shouldSkipPath(relativePath)) continue;
    const absPath = join(repoRoot, relativePath);
    const findings = scanFile(absPath);
    for (const f of findings) {
      process.stderr.write(`${relativePath}:${String(f.line)}: secret-shaped value [${f.shape.name}]: ${f.match}\n`);
      allFindings.push(f);
    }
  }

  if (allFindings.length > 0) {
    process.stderr.write(failMessage(allFindings));
    process.exit(1);
  }
}

main();
