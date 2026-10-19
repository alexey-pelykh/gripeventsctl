// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The static rules over the live files and the workflows (issue #18 § The harness unit tests,
 * `suite-shape.test.ts`), as pure functions over a map of tracked paths to contents, so the test runs
 * them over the tracked tree and over a copy with one rule broken. Each finding names the file and the
 * rule. The rules:
 *
 * - every `*.e2e.test.ts` under `packages/e2e/src/`, at any depth (the live config collects
 *   `src/**\/*.e2e.test.ts`), is one of the nine names at the top level, and the nine exist;
 * - only `60-write.e2e.test.ts` names a write tool, a write kind or `match_manual`; `70-mcp-stdio`
 *   reads the expected tool list from `lib/write-operations.ts` and never spells a write name;
 * - no live file names `attendees_dump`;
 * - no live file holds an integer literal of four or more digits outside the two header lines, the
 *   string `matchmaking.grip.events/`, or `container_id:` followed by a digit (the no-event rule);
 * - no live file writes a file, names `--out`, holds a `password` literal, or spells `expect.fail(` or
 *   `throw new Error(`, the two raw failure forms, so a failure goes through the harness's `drift()`,
 *   which redacts (the README's safety policy, made mechanical; the rules are string scans of each
 *   live file's own text, and a reviewer still reads the files for what a scan cannot see);
 * - no workflow under `.github/workflows/` sets `GRIPEVENTSCTL_E2E`, runs `test:e2e` or references a
 *   secret other than `secrets.GITHUB_TOKEN`.
 */

import { WRITE_KIND_NAMES, WRITE_TOOL_NAMES } from "./write-operations.js";

export const LIVE_DIR = "packages/e2e/src/";
export const WORKFLOWS_DIR = ".github/workflows/";
export const WRITE_FILE = "60-write.e2e.test.ts";

/** The nine live files, in run order. */
export const LIVE_FILE_NAMES: readonly string[] = Object.freeze([
  "00-session.e2e.test.ts",
  "05-auth-probe.e2e.test.ts",
  "10-events.e2e.test.ts",
  "20-attendees.e2e.test.ts",
  "30-match.e2e.test.ts",
  "40-chat.e2e.test.ts",
  "50-schedule.e2e.test.ts",
  WRITE_FILE,
  "70-mcp-stdio.e2e.test.ts",
]);

const HEADER_LINE = /^\/\/ (?:SPDX-License-Identifier: AGPL-3\.0-only|Copyright \(C\) \d{4} Oleksii PELYKH)$/u;

/** An integer literal of four or more digits: a run of digits not joined to a word character, a dot or an underscore. */
const LONG_INTEGER = /(?<![\w.])\d{4,}(?![\w.])/u;

/** What a live file must not do to a file (the README: the harness writes no capture to disk). */
const FILE_WRITES = [
  "writeFile",
  "appendFile",
  "createWriteStream",
  "openSync",
  "writeSync",
  "mkdtemp",
  "copyFile",
  "rename(",
];

/** Failures outside the harness: `drift()` is the one path, and it redacts. */
const RAW_FAILURES = ["expect.fail(", "throw new Error("];

/** True for every `*.e2e.test.ts` under the live directory, at any depth: what the live config collects. */
export function isLiveFile(path: string): boolean {
  return path.startsWith(LIVE_DIR) && path.endsWith(".e2e.test.ts");
}

/** `source` without its two header lines, where they open it, so the copyright year never counts as an integer literal. */
export function withoutHeader(source: string): string {
  const lines = source.split("\n");
  const [first, second] = lines;
  if (first !== undefined && second !== undefined && HEADER_LINE.test(first) && HEADER_LINE.test(second)) {
    return lines.slice(2).join("\n");
  }
  return source;
}

function liveFindings(path: string, source: string): string[] {
  const findings: string[] = [];
  const name = path.slice(LIVE_DIR.length);
  const body = withoutHeader(source);
  if (!LIVE_FILE_NAMES.includes(name)) findings.push(`${path}: not one of the nine live file names`);
  if (name !== WRITE_FILE) {
    for (const literal of [...WRITE_TOOL_NAMES, ...WRITE_KIND_NAMES, "match_manual"]) {
      if (body.includes(literal)) findings.push(`${path}: names the write ${literal}; only ${WRITE_FILE} may`);
    }
  }
  if (body.includes("attendees_dump")) findings.push(`${path}: names attendees_dump; the suite never dumps`);
  if (LONG_INTEGER.test(body))
    findings.push(`${path}: holds an integer literal of four or more digits (the no-event rule)`);
  if (body.includes("matchmaking.grip.events/"))
    findings.push(`${path}: holds matchmaking.grip.events/ (the no-event rule)`);
  if (/container_id:\s*\d/u.test(body))
    findings.push(`${path}: holds container_id: followed by a digit (the no-event rule)`);
  for (const call of FILE_WRITES) {
    if (body.includes(call)) findings.push(`${path}: writes a file (${call}); a live file writes nothing to disk`);
  }
  if (body.includes("--out")) findings.push(`${path}: names --out; the suite never exports`);
  if (/password/iu.test(body)) findings.push(`${path}: holds a password literal`);
  for (const raw of RAW_FAILURES) {
    if (body.includes(raw)) findings.push(`${path}: fails outside the harness (${raw}); use drift(), which redacts`);
  }
  return findings;
}

function workflowFindings(path: string, source: string): string[] {
  const findings: string[] = [];
  if (source.includes("GRIPEVENTSCTL_E2E"))
    findings.push(`${path}: sets GRIPEVENTSCTL_E2E; CI never runs the live suite`);
  if (source.includes("test:e2e")) findings.push(`${path}: runs test:e2e; CI holds no session`);
  for (const match of source.matchAll(/secrets\.([A-Za-z0-9_]+)/gu)) {
    const name = match[1] ?? "";
    if (name !== "GITHUB_TOKEN")
      findings.push(
        `${path}: references secrets.${name}; the only secret a workflow may reference is secrets.GITHUB_TOKEN`,
      );
  }
  return findings;
}

/** Every finding over `files` (tracked path to content): empty when the tree has the shape the suite requires. */
export function shapeFindings(files: ReadonlyMap<string, string>): string[] {
  const findings: string[] = [];
  const present = new Set<string>();
  for (const [path, source] of files) {
    if (isLiveFile(path)) {
      present.add(path.slice(LIVE_DIR.length));
      findings.push(...liveFindings(path, source));
    } else if (path.startsWith(WORKFLOWS_DIR)) {
      findings.push(...workflowFindings(path, source));
    }
  }
  for (const name of LIVE_FILE_NAMES) {
    if (!present.has(name)) findings.push(`${LIVE_DIR}${name}: missing; the nine live files must exist`);
  }
  return findings;
}
