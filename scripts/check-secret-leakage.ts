#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Secret-leakage guard.
 *
 * Scans every tracked file for the secret shapes GripEventsCtl handles (a Grip session token in
 * its header or JSON-key context, and a JWT-shaped chat token) and fails when one is found. A
 * match in tracked source is almost certainly a leak: a token that landed in a fixture, a snapshot
 * or a captured response during local development.
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

import { SECRET_PATTERN_SOURCES } from "../packages/core/src/lib/redact.js";

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

interface Finding {
  line: number;
  match: string;
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

  const patterns = SECRET_PATTERN_SOURCES.map((source) => new RegExp(source, "gi"));
  const findings: Finding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        // Report the shape, never the value: the value is what must not reach a log.
        findings.push({ line: i + 1, match: `${match[0].slice(0, 12)}… (${String(match[0].length)} chars)` });
      }
    }
  }
  return findings;
}

function main(): void {
  const repoRoot = process.cwd();
  const tracked = listTrackedFiles(repoRoot);

  let totalFindings = 0;
  for (const relativePath of tracked) {
    if (shouldSkipPath(relativePath)) continue;
    const absPath = join(repoRoot, relativePath);
    const findings = scanFile(absPath);
    for (const f of findings) {
      process.stderr.write(`${relativePath}:${String(f.line)}: secret-shaped value: ${f.match}\n`);
      totalFindings += 1;
    }
  }

  if (totalFindings > 0) {
    process.stderr.write(
      `\nFAIL: found ${String(totalFindings)} secret-shaped value(s) in tracked source.\n` +
        `These look like Grip session tokens or chat tokens and must NOT appear in committed code.\n` +
        `Move them under .tmp/ (git-ignored), redact them, or sign out to revoke the session if they are real.\n`,
    );
    process.exit(1);
  }
}

main();
