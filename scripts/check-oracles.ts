#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Oracle ledger check.
 *
 * Runs every pre-authored oracle file (`*.oracle.test.ts` under a package's `src/`) in strict mode, where
 * a missing subject module throws `oracle subject missing` instead of skipping, and grades each file
 * against the pending ledger `oracles.pending` at the repository root:
 *
 *   - A file listed in the ledger may fail only because its subject is missing: every failure message
 *     of that file is an `oracle subject missing` error.
 *   - A file not listed in the ledger must pass.
 *   - A file listed in the ledger whose cases pass must be removed from the ledger.
 *   - A ledger line naming a file that does not exist fails.
 *   - Any other failure fails.
 *
 * One line per file reports its state. The exit code is 0 only when every file is in its expected
 * state. The ledger format is one repository-relative path per line; a line starting with `#` is a
 * comment and a blank line is ignored.
 *
 * The strict run is `vitest run --config vitest.oracles.config.ts` with the JSON reporter. Build the
 * packages first (`pnpm build`): several oracle files import a subject through a built `dist/`.
 *
 * Exit codes:
 *   0: every oracle file is in the state the ledger says
 *   1: at least one file is not, or the strict run produced no result
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_FILE = "oracles.pending";
export const ORACLES_CONFIG = "vitest.oracles.config.ts";
export const SUBJECT_MISSING = "oracle subject missing";

/** The parts of the vitest JSON reporter output this check reads. */
export interface VitestJsonResult {
  testResults: VitestFileResult[];
}

export interface VitestFileResult {
  /** Absolute path of the test file. */
  name: string;
  status: "passed" | "failed" | "skipped" | "pending" | string;
  /** The collection-level error message, when the file failed before any case ran. */
  message?: string;
  assertionResults: VitestAssertionResult[];
}

export interface VitestAssertionResult {
  status: "passed" | "failed" | "skipped" | "pending" | "todo" | string;
  failureMessages?: string[];
}

export interface FileGrade {
  /** Repository-relative path with forward slashes. */
  file: string;
  /** One phrase printed next to the file. */
  state: string;
  /** True when the file is in the state the ledger says. */
  ok: boolean;
}

/** Reads the ledger text into the set of repository-relative paths it lists. */
export function parseLedger(text: string): string[] {
  const files = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    files.add(line);
  }
  return [...files];
}

/** True when a failure message is the strict-mode probe error and nothing else. */
export function isSubjectMissingMessage(message: string): boolean {
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  return firstLine.replace(/^Error:\s*/u, "").startsWith(SUBJECT_MISSING);
}

/** Every failure message a file produced: the collection error, then each failed case's messages. */
export function collectFailureMessages(result: VitestFileResult): string[] {
  const messages: string[] = [];
  if (typeof result.message === "string" && result.message.trim().length > 0) messages.push(result.message);
  for (const assertion of result.assertionResults) {
    if (assertion.status !== "failed") continue;
    const failureMessages = assertion.failureMessages ?? [];
    if (failureMessages.length === 0) messages.push("(failed without a message)");
    messages.push(...failureMessages);
  }
  if (result.status === "failed" && messages.length === 0) messages.push("(failed without a message)");
  return messages;
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

/** Every `*.oracle.test.ts` under `packages/<name>/src/`, repository-relative, sorted. */
export function listOracleFilesOnDisk(repoRoot: string): string[] {
  const found: string[] = [];
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return found;
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, "src");
    if (!existsSync(srcDir)) continue;
    walk(srcDir, (filePath) => {
      if (filePath.endsWith(".oracle.test.ts")) found.push(toRepoRelative(repoRoot, filePath));
    });
  }
  return found.sort();
}

function walk(dir: string, visit: (filePath: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) walk(entryPath, visit);
    else if (entry.isFile()) visit(entryPath);
  }
}

/**
 * Grades every oracle file against the ledger. `repoRoot` is used to resolve the absolute file names
 * in the vitest result and to check that each ledger line names a file that exists.
 */
export function grade(repoRoot: string, ledger: string[], result: VitestJsonResult): FileGrade[] {
  const listed = new Set(ledger);
  const grades: FileGrade[] = [];
  const seen = new Set<string>();

  for (const fileResult of result.testResults) {
    const file = toRepoRelative(repoRoot, fileResult.name);
    seen.add(file);
    const failures = collectFailureMessages(fileResult);
    const failed = fileResult.status === "failed" || failures.length > 0;
    const onlySubjectMissing = failed && failures.every(isSubjectMissingMessage);

    if (listed.has(file)) {
      if (!failed) {
        grades.push({
          file,
          state: `listed in ${LEDGER_FILE} but its cases pass: remove it from the ledger`,
          ok: false,
        });
      } else if (onlySubjectMissing) {
        grades.push({ file, state: "pending, subject missing", ok: true });
      } else {
        grades.push({ file, state: `listed in ${LEDGER_FILE} but fails for another reason`, ok: false });
      }
    } else if (!failed) {
      grades.push({ file, state: "passing", ok: true });
    } else if (onlySubjectMissing) {
      grades.push({ file, state: `subject missing and not listed in ${LEDGER_FILE}`, ok: false });
    } else {
      grades.push({ file, state: "failing", ok: false });
    }
  }

  for (const file of ledger) {
    if (seen.has(file)) continue;
    if (!existsSync(join(repoRoot, ...file.split("/")))) {
      grades.push({ file, state: `listed in ${LEDGER_FILE} but does not exist`, ok: false });
    } else {
      grades.push({ file, state: `listed in ${LEDGER_FILE} but the strict run did not report it`, ok: false });
    }
  }

  for (const file of listOracleFilesOnDisk(repoRoot)) {
    if (seen.has(file) || listed.has(file)) continue;
    grades.push({ file, state: "on disk but the strict run did not report it", ok: false });
  }

  return grades.sort((a, b) => a.file.localeCompare(b.file));
}

/** Runs the oracle files in strict mode and returns the JSON reporter output. */
export function runOraclesStrict(repoRoot: string): VitestJsonResult {
  const require = createRequire(import.meta.url);
  const vitestEntry = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const outDir = mkdtempSync(join(tmpdir(), "gripeventsctl-oracles-"));
  const outFile = join(outDir, "result.json");
  try {
    const run = spawnSync(
      process.execPath,
      [vitestEntry, "run", "--config", ORACLES_CONFIG, "--reporter=json", "--outputFile", outFile],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    if (!existsSync(outFile)) {
      process.stderr.write(run.stdout);
      process.stderr.write(run.stderr);
      throw new Error(`the strict oracle run wrote no JSON result (exit status ${String(run.status)})`);
    }
    return JSON.parse(readFileSync(outFile, "utf8")) as VitestJsonResult;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export function main(): number {
  const repoRoot = process.cwd();
  const ledgerPath = join(repoRoot, LEDGER_FILE);
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`FAIL: ${LEDGER_FILE} not found at the repository root.\n`);
    return 1;
  }
  const ledger = parseLedger(readFileSync(ledgerPath, "utf8"));
  const result = runOraclesStrict(repoRoot);
  const grades = grade(repoRoot, ledger, result);

  for (const g of grades) {
    process.stdout.write(`${g.ok ? "ok  " : "FAIL"} ${g.file}: ${g.state}\n`);
  }
  const failures = grades.filter((g) => !g.ok);
  if (failures.length > 0) {
    process.stderr.write(
      `\nFAIL: ${String(failures.length)} oracle file(s) not in the state ${LEDGER_FILE} says.\n` +
        `A file whose subject is now built leaves the ledger; a file that fails for another reason is a defect.\n`,
    );
    return 1;
  }
  process.stdout.write(`\n${String(grades.length)} oracle file(s) in the state ${LEDGER_FILE} says.\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
