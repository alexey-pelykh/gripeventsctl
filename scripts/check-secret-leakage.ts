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
 * message gives the remedy `SECRET_SHAPES` names for each shape found. A path is printed redacted, then
 * with each line-breaking or direction character escaped (`escapeLineBreaks`), so its line stays whole.
 *
 * The patterns live ONCE, in `packages/core/src/lib/redact.ts`, and are consumed by both this
 * lint-time check and the runtime redaction path. Extending either side means extending
 * `redact.ts`; this script picks the change up automatically.
 *
 * Scope:
 *   - Tracked files only (`git ls-files -z`); untracked and git-ignored files are not the concern.
 *   - Excludes `.tmp/` (where captured tokens may legitimately sit), binary files, lockfiles,
 *     this script, the source-of-truth module and the test that exercises it.
 *   - Every other tracked file is read whole, whatever its size. A file that cannot be read (deleted
 *     from the working tree, a directory, too large for one string) is named with the reason, and
 *     fails the check: the check cannot vouch for a file it did not read.
 *
 * History pass (`--history`):
 *   - Runs after the tree scan, which is unchanged. Without the flag the script scans the tree exactly as before;
 *     the one addition on that path is that an unknown argument now exits 2 with a usage line instead of being ignored.
 *   - Refuses a shallow clone (`git rev-parse --is-shallow-repository` prints `true`): a scan over the few commits a
 *     shallow clone holds must never read as clean. The CI job that runs it checks out with `fetch-depth: 0`.
 *   - Lists every commit (`git rev-list --all`), every blob each one reaches (`git ls-tree -r -l --full-tree -z`), and
 *     keeps each blob id once, under the first path seen at which the tree scan would read it: a path
 *     `shouldSkipPath()` skips is skipped here too, so the source-of-truth module and its test stay out of scope.
 *   - Skips a blob over 1 MiB (the tree scan still reads such a file whole), reads the rest through one
 *     `git cat-file --batch` process and matches each with the same patterns.
 *   - Reports each finding as `history: <blob id> <path>:<line>: …`, in the same redacted form, then names the oldest
 *     commit that introduced each flagged blob (`git log --all --find-object`), so the maintainer can rewrite it or
 *     revoke the value. The value is never printed.
 *
 * Exit codes:
 *   0: no match in tracked source (clean), and every tracked file in scope was read; with `--history`, no match in any
 *      blob of the history either
 *   1: one or more matches found, each reported with file and line; or one or more tracked files
 *      could not be read, each reported with the reason
 *   2: an unknown argument; or, with `--history`, a shallow clone or a `git` command that failed. A history scan that
 *      could not run says nothing about the history, so it never reads as clean.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SECRET_PATTERN_SOURCES, SECRET_SHAPES, redactString } from "../packages/core/src/lib/redact.js";
import { escapeLineBreaks } from "../packages/core/src/transport/errors.js";

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

/**
 * Every tracked path, read NUL-separated: line by line, git quotes a path that holds a byte outside printable ASCII
 * and escapes its bytes (`core.quotePath`), and no file has the quoted name. Each path is kept as git gives it, spaces
 * at its ends included.
 */
function listTrackedFiles(repoRoot: string): string[] {
  const stdout = execSync("git ls-files -z", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((path) => path.length > 0);
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

/** What scanning one file gives: its findings, or why it could not be read. */
type ScanResult = { findings: Finding[] } | { unreadable: string };

function scanFile(filePath: string): ScanResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
  return { findings: scanContent(content) };
}

/** Every match of every shape in `content`, in line order. The tree scan and the history pass both match through it. */
function scanContent(content: string): Finding[] {
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
  const remedies = remedyLines(findings);
  return (
    `\nFAIL: found ${String(findings.length)} secret-shaped value(s) in tracked source; none may appear in committed code.\n` +
    `Remove each value, or move its file under .tmp/ (git-ignored); a value already committed stays in the history until that commit is rewritten. If a value is real:\n` +
    remedies.join("")
  );
}

/** One line per remedy the shapes found need, naming those shapes in the order the patterns list them. */
function remedyLines(findings: readonly Finding[]): string[] {
  const byRemedy = new Map<string, Set<string>>();
  for (const shape of SHAPES) {
    if (!findings.some((finding) => finding.shape.source === shape.source)) continue;
    const names = byRemedy.get(shape.remedy) ?? new Set<string>();
    names.add(shape.name);
    byRemedy.set(shape.remedy, names);
  }
  return [...byRemedy].map(([remedy, names]) => `  - ${[...names].join("; ")}: ${remedy}.\n`);
}

/** The FAIL message of the history pass: a value in the history outlives the deletion of its file. */
function historyFailMessage(findings: readonly Finding[]): string {
  return (
    `\nFAIL: found ${String(findings.length)} secret-shaped value(s) in the git history; a value stays in the history, deleted file or not, until the commit that introduced it is rewritten.\n` +
    `Rewrite each commit named above before the history is published, or treat the value as public. If a value is real:\n` +
    remedyLines(findings).join("")
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

/**
 * The tree scan, unchanged: every tracked file in scope, read from the working tree. It writes its findings and its FAIL
 * messages to stderr and says whether it failed.
 */
function scanTree(repoRoot: string): boolean {
  const tracked = listTrackedFiles(repoRoot);

  const allFindings: Finding[] = [];
  let unreadable = 0;
  for (const relativePath of tracked) {
    if (shouldSkipPath(relativePath)) continue;
    const absPath = join(repoRoot, relativePath);
    const result = scanFile(absPath);
    // Every line names the file through redactString too: a path is text a token can sit in. Then each line-breaking or
    // direction character is escaped: `git ls-files -z` gives a path as it is, and such a character would split the
    // line or reorder it as a terminal shows it. The reason a file could not be read names the path as well.
    const shown = escapeLineBreaks(redactString(relativePath));
    if ("unreadable" in result) {
      process.stderr.write(`${shown}: not scanned: ${escapeLineBreaks(redactString(result.unreadable))}\n`);
      unreadable += 1;
      continue;
    }
    for (const f of result.findings) {
      process.stderr.write(`${shown}:${String(f.line)}: secret-shaped value [${f.shape.name}]: ${f.match}\n`);
      allFindings.push(f);
    }
  }

  if (allFindings.length > 0) process.stderr.write(failMessage(allFindings));
  if (unreadable > 0) {
    process.stderr.write(
      `\nFAIL: ${String(unreadable)} tracked file(s) could not be read, so the check cannot vouch for them.\n` +
        `Restore each file, or stage its removal (git rm), then run the check again.\n`,
    );
  }
  return allFindings.length > 0 || unreadable > 0;
}

/** A blob larger than this is skipped by the history pass: 1 MiB. The tree scan still reads such a file whole. */
const HISTORY_MAX_BLOB_BYTES = 1024 * 1024;

/** One entry of `git ls-tree -r -l --full-tree -z`: `<mode> <type> <id> <size>\t<path>`, the size padded with spaces. */
interface TreeEntry {
  type: string;
  id: string;
  /** The size in bytes, or `undefined` where git prints `-` (a tree or a submodule commit, never a blob). */
  size: number | undefined;
  path: string;
}

/** A `git` command the history pass needed failed, or answered in a form it does not read. */
class GitFailure extends Error {}

/** The entries of `git ls-tree -r -l --full-tree -z` output. The path is everything after the first tab, as it is. */
function parseLsTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const fields = tab >= 0 ? /^(\d+) (\S+) ([0-9a-f]+) +(\S+)$/u.exec(record.slice(0, tab)) : null;
    if (fields === null)
      throw new GitFailure(`git ls-tree printed a record it does not read: ${JSON.stringify(record)}`);
    const size = fields[4] === "-" ? undefined : Number(fields[4]);
    entries.push({ type: fields[2] ?? "", id: fields[3] ?? "", size, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * The contents of the frames `git cat-file --batch` prints, by blob id: a header `<id> <type> <size>\n`, then `<size>`
 * bytes, then `\n`. A `<id> missing` header, or a frame cut short, is a git failure: a blob the history pass listed
 * and could not read is a blob it cannot vouch for.
 */
function parseCatFileBatch(stdout: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < stdout.length) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) throw new GitFailure("git cat-file --batch printed a header with no end");
    const header = stdout.subarray(offset, newline).toString("utf8");
    const fields = /^([0-9a-f]+) (\S+) (\d+)$/u.exec(header);
    if (fields === null) throw new GitFailure(`git cat-file --batch could not read an object: ${header}`);
    const size = Number(fields[3]);
    const start = newline + 1;
    if (start + size + 1 > stdout.length || stdout[start + size] !== 0x0a) {
      throw new GitFailure(`git cat-file --batch printed a short frame for ${fields[1] ?? ""}`);
    }
    blobs.set(fields[1] ?? "", stdout.subarray(start, start + size));
    offset = start + size + 1;
  }
  return blobs;
}

/** The stdout of `git <args>` in `repoRoot`, or a `GitFailure` naming the command and what git printed on stderr. */
function gitOutput(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error);
    throw new GitFailure(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/** A history finding: where the blob was first seen, and what matched in it. */
interface HistoryFinding {
  blobId: string;
  path: string;
  finding: Finding;
}

/**
 * The blobs of every commit, each id once, under the first path seen that `shouldSkipPath()` does not skip; a blob over
 * `HISTORY_MAX_BLOB_BYTES` is left out. A path skipped is skipped before the blob id is kept, so a blob that also sits
 * at a path in scope is still scanned under that path.
 */
function listHistoryBlobs(repoRoot: string): Map<string, string> {
  const commits = gitOutput(repoRoot, ["rev-list", "--all"])
    .split("\n")
    .filter((line) => line.length > 0);
  const blobs = new Map<string, string>();
  for (const commit of commits) {
    for (const entry of parseLsTree(gitOutput(repoRoot, ["ls-tree", "-r", "-l", "--full-tree", "-z", commit]))) {
      if (entry.type !== "blob" || blobs.has(entry.id) || shouldSkipPath(entry.path)) continue;
      if (entry.size === undefined) throw new GitFailure(`git ls-tree printed no size for blob ${entry.id}`);
      if (entry.size > HISTORY_MAX_BLOB_BYTES) continue;
      blobs.set(entry.id, entry.path);
    }
  }
  return blobs;
}

/** Every finding in the blobs given, read through one `git cat-file --batch` process, in blob order then line order. */
function scanHistoryBlobs(repoRoot: string, blobs: ReadonlyMap<string, string>): HistoryFinding[] {
  if (blobs.size === 0) return [];
  const run = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${[...blobs.keys()].join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (run.error !== undefined) throw new GitFailure(`git cat-file --batch failed: ${run.error.message}`);
  if (run.status !== 0) {
    throw new GitFailure(
      `git cat-file --batch failed: ${run.stderr.toString("utf8").trim() || `exit ${String(run.status)}`}`,
    );
  }
  const contents = parseCatFileBatch(run.stdout);
  const findings: HistoryFinding[] = [];
  for (const [blobId, path] of blobs) {
    const content = contents.get(blobId);
    if (content === undefined) throw new GitFailure(`git cat-file --batch did not print blob ${blobId}`);
    for (const finding of scanContent(content.toString("utf8"))) findings.push({ blobId, path, finding });
  }
  return findings;
}

/**
 * The commit that introduced `blobId`: the last line `git log --all --find-object` prints, the oldest commit that
 * changed how often the blob occurs. `undefined` when git names none.
 */
function firstCommitOf(repoRoot: string, blobId: string): string | undefined {
  const commits = gitOutput(repoRoot, ["log", "--all", `--find-object=${blobId}`, "--format=%H"])
    .split("\n")
    .filter((line) => /^[0-9a-f]{40,64}$/u.test(line));
  return commits.at(-1);
}

/**
 * The history pass. It writes its findings, the commit that introduced each flagged blob and its FAIL message to
 * stderr, and gives `"clean"`, `"findings"`, or `"failed"` for a shallow clone or a git failure.
 */
function scanHistory(repoRoot: string): "clean" | "findings" | "failed" {
  try {
    const shallow = gitOutput(repoRoot, ["rev-parse", "--is-shallow-repository"]).trim();
    if (shallow === "true") {
      process.stderr.write("history scan needs a full clone (fetch-depth: 0)\n");
      return "failed";
    }
    // An older git prints the option back; only `false` says the clone is whole.
    if (shallow !== "false")
      throw new GitFailure(`git rev-parse --is-shallow-repository answered ${JSON.stringify(shallow)}`);

    const findings = scanHistoryBlobs(repoRoot, listHistoryBlobs(repoRoot));
    if (findings.length === 0) return "clean";
    for (const { blobId, path, finding } of findings) {
      process.stderr.write(
        `history: ${blobId} ${escapeLineBreaks(redactString(path))}:${String(finding.line)}: secret-shaped value [${finding.shape.name}]: ${finding.match}\n`,
      );
    }
    for (const blobId of new Set(findings.map((entry) => entry.blobId))) {
      const commit = firstCommitOf(repoRoot, blobId);
      process.stderr.write(
        commit === undefined
          ? `history: blob ${blobId}: git log --find-object named no commit that introduced it\n`
          : `history: blob ${blobId} first introduced by commit ${commit}\n`,
      );
    }
    process.stderr.write(historyFailMessage(findings.map((entry) => entry.finding)));
    return "findings";
  } catch (error: unknown) {
    if (!(error instanceof GitFailure)) throw error;
    process.stderr.write(`history scan: ${escapeLineBreaks(redactString(error.message))}\n`);
    return "failed";
  }
}

/**
 * The check: the tree scan, then the history pass when `--history` is given. Exit 2 when the history pass could not
 * run (a shallow clone, a git failure) or for an unknown argument; else 1 when either pass found something or a tracked
 * file could not be read; else 0.
 */
function main(argv: readonly string[] = process.argv.slice(2), repoRoot: string = process.cwd()): number {
  const unknown = argv.filter((arg) => arg !== "--history");
  if (unknown.length > 0) {
    process.stderr.write(`usage: check-secret-leakage [--history] (unknown argument ${unknown.join(" ")})\n`);
    return 2;
  }
  const treeFailed = scanTree(repoRoot);
  if (!argv.includes("--history")) return treeFailed ? 1 : 0;
  const history = scanHistory(repoRoot);
  if (history === "failed") return 2;
  return treeFailed || history === "findings" ? 1 : 0;
}

// Run unconditionally, as before: nothing imports this script, and a guard comparing `process.argv[1]` with the module
// path would skip the check, and pass, wherever the two name the same file through different paths (a symlink).
process.exitCode = main();
