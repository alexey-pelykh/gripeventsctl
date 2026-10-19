#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * README posture check.
 *
 * Reads the root README, the package READMEs, the legitimacy page and the package manifests, and
 * checks that the project's unofficial posture ships as decided. It reads files only; it never edits
 * them. Lines are compared after trimming trailing whitespace on each line.
 *
 * The four rules:
 *
 *   1. The disclaimer block: the lines of `README.md` from the heading
 *      `## ⚠️ Unofficial - Personal Use Only` up to the line before the next `## ` heading, trailing
 *      blank lines dropped. `packages/core/README.md`, `packages/cli/README.md` and
 *      `packages/mcp/README.md` each contain that block verbatim: every line equal, in order,
 *      contiguous; the copy's heading may be `##` or `###`. `packages/e2e/README.md` is exempt
 *      (private, never published), and `packages/gripeventsctl` ships the root README.
 *   2. The MCP warning: `README.md` carries the sentence
 *      `Anything that can start \`gripeventsctl mcp\` can use your saved session.` between the heading
 *      `## MCP Integration` and the next `## ` heading.
 *   3. The legitimacy page: `docs/legitimacy.md` exists, holds a line matching
 *      `read on YYYY-MM-DD`, and holds the word `nominative` or the phrase `only to say which
 *      platform`; `README.md` links it as a Markdown link target `](docs/legitimacy.md)`.
 *   4. The unofficial framing: `packages/gripeventsctl/package.json` has a `description` starting
 *      with `Unofficial`, `keywords` holding `unofficial` and `grip-events`, and a `homepage` under
 *      the repository URL; `server.json` has a `description` containing `Unofficial`; no
 *      `package.json` (the root one and every `packages/<dir>/package.json`) has a `name` starting
 *      with `@grip/`, and every `repository.url` present points at the repository.
 *
 * Exit codes:
 *   0: clean (one line on stdout)
 *   1: findings (one line per finding on stderr, naming the file, then a FAIL footer)
 *   2: a usage error (an unknown argument)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The root README heading that opens the disclaimer block. */
export const DISCLAIMER_HEADING = "## ⚠️ Unofficial - Personal Use Only";

/** The published package READMEs that carry the disclaimer block verbatim. */
export const PACKAGE_READMES = ["packages/core/README.md", "packages/cli/README.md", "packages/mcp/README.md"] as const;

/** The heading of the README section that must carry the MCP warning. */
export const MCP_HEADING = "## MCP Integration";

/** The MCP warning sentence. */
export const MCP_WARNING = "Anything that can start `gripeventsctl mcp` can use your saved session.";

/** The repository every manifest points at. */
export const REPOSITORY_URL = "https://github.com/alexey-pelykh/gripeventsctl";

export const ROOT_README = "README.md";
export const LEGITIMACY_PAGE = "docs/legitimacy.md";
export const UMBRELLA_MANIFEST = "packages/gripeventsctl/package.json";
export const SERVER_MANIFEST = "server.json";

/** A `read on YYYY-MM-DD` line of the legitimacy page. */
const READ_ON = /read on \d{4}-\d{2}-\d{2}/u;

/** The nominative-use statement of the legitimacy page. */
const NOMINATIVE = /\bnominative\b|only to say which platform/u;

/** A Markdown link target pointing at the legitimacy page, optionally with an anchor. */
const LEGITIMACY_LINK = /\]\(docs\/legitimacy\.md(?:#[^)]*)?\)/u;

/** What locating the block in a package README gives: where it starts, or the first difference. */
export type BlockResult =
  { index: number } | { firstDifference: { line: number; expected: string; actual: string } | "heading not found" };

/** The lines of `text`, each with its trailing whitespace trimmed. */
function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd());
}

/** The text of a heading line after its `#` run and one space, or `undefined` for a non-heading. */
function headingText(line: string): string | undefined {
  const match = /^#{1,6} (.*)$/u.exec(line);
  return match === null ? undefined : (match[1] ?? "");
}

/**
 * The disclaimer block of the root README: from the heading to the line before the next `## `
 * heading (or the end), trailing whitespace trimmed per line, trailing blank lines dropped.
 */
export function disclaimerBlock(readme: string): string[] | undefined {
  const lines = linesOf(readme);
  const start = lines.indexOf(DISCLAIMER_HEADING);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ") === true) {
      end = index;
      break;
    }
  }
  const block = lines.slice(start, end);
  while (block.length > 1 && block[block.length - 1] === "") block.pop();
  return block;
}

/**
 * Locates `block` in `readme`. The copy's heading line is any heading whose text equals the block
 * heading's text (so `##` or `###`); the lines after it must equal the block's lines one by one.
 * Where several headings match, the first that carries the whole block wins; otherwise the first
 * difference reported is that of the first matching heading. Line numbers are 1-based in `readme`.
 */
export function findBlock(block: string[], readme: string): BlockResult {
  const [heading, ...body] = block;
  const wanted = heading === undefined ? undefined : headingText(heading);
  if (wanted === undefined) return { firstDifference: "heading not found" };
  const lines = linesOf(readme);
  let firstDifference: { line: number; expected: string; actual: string } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingText(lines[index] ?? "") !== wanted) continue;
    const mismatch = body.findIndex((expected, offset) => lines[index + 1 + offset] !== expected);
    if (mismatch === -1) return { index };
    if (firstDifference === undefined) {
      const at = index + 1 + mismatch;
      firstDifference = { line: at + 1, expected: body[mismatch] ?? "", actual: lines[at] ?? "<end of file>" };
    }
  }
  return { firstDifference: firstDifference ?? "heading not found" };
}

/** True when the README carries the MCP warning between the MCP heading and the next `## ` heading. */
export function hasMcpWarning(readme: string): boolean {
  const lines = linesOf(readme);
  const start = lines.indexOf(MCP_HEADING);
  if (start === -1) return false;
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    section.push(line);
  }
  // Whitespace is normalised so a wrapped sentence still matches.
  return section.join(" ").replace(/\s+/gu, " ").includes(MCP_WARNING);
}

/** True when `url` points at the repository: the URL itself or its `.git` form, with an optional `git+`. */
export function isRepositoryUrl(url: string): boolean {
  const bare = url.startsWith("git+") ? url.slice("git+".length) : url;
  return bare === REPOSITORY_URL || bare === `${REPOSITORY_URL}.git`;
}

/** True when `url` is the repository URL or a path under it. */
export function isUnderRepository(url: string): boolean {
  return url === REPOSITORY_URL || url.startsWith(`${REPOSITORY_URL}/`);
}

/** A JSON file as read: absent, invalid (with its finding), or its top-level fields. */
type JsonFile = { absent: true } | { invalid: string } | { fields: Record<string, unknown> };

/** Reads files relative to a root and remembers which ones it read. */
class Reader {
  readonly read = new Set<string>();

  constructor(private readonly root: string) {}

  text(path: string): string | undefined {
    const absolute = join(this.root, ...path.split("/"));
    if (!existsSync(absolute)) return undefined;
    this.read.add(path);
    return readFileSync(absolute, "utf8");
  }

  /** The JSON object at `path`: absent, invalid (with its finding), or its fields. */
  json(path: string): JsonFile {
    const text = this.text(path);
    if (text === undefined) return { absent: true };
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { invalid: `${path}: not a JSON object` };
      }
      return { fields: value as Record<string, unknown> };
    } catch (error: unknown) {
      return { invalid: `${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})` };
    }
  }

  /** The `packages/<dir>/package.json` paths present, sorted. */
  packageManifests(): string[] {
    const packages = join(this.root, "packages");
    if (!existsSync(packages)) return [];
    return readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((path) => existsSync(join(this.root, ...path.split("/"))))
      .sort();
  }
}

function checkDisclaimer(reader: Reader, readme: string | undefined, findings: string[]): void {
  if (readme === undefined) return;
  const block = disclaimerBlock(readme);
  if (block === undefined) {
    findings.push(`${ROOT_README}: the disclaimer block heading ${JSON.stringify(DISCLAIMER_HEADING)} is missing`);
    return;
  }
  for (const path of PACKAGE_READMES) {
    const copy = reader.text(path);
    if (copy === undefined) {
      findings.push(`${path}: missing (it must carry the disclaimer block from ${ROOT_README})`);
      continue;
    }
    const result = findBlock(block, copy);
    if ("index" in result) continue;
    if (result.firstDifference === "heading not found") {
      findings.push(`${path}: the disclaimer block is missing (no heading ${JSON.stringify(block[0] ?? "")})`);
    } else {
      const { line, expected, actual } = result.firstDifference;
      findings.push(
        `${path}: the disclaimer block differs at line ${String(line)}: expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}`,
      );
    }
  }
}

function checkMcpWarning(readme: string | undefined, findings: string[]): void {
  if (readme === undefined) return;
  if (!linesOf(readme).includes(MCP_HEADING)) {
    findings.push(`${ROOT_README}: the heading ${JSON.stringify(MCP_HEADING)} is missing`);
  } else if (!hasMcpWarning(readme)) {
    findings.push(`${ROOT_README}: the MCP warning sentence is missing under ${JSON.stringify(MCP_HEADING)}`);
  }
}

function checkLegitimacy(reader: Reader, readme: string | undefined, findings: string[]): void {
  const page = reader.text(LEGITIMACY_PAGE);
  if (page === undefined) {
    findings.push(`${LEGITIMACY_PAGE}: missing`);
  } else {
    if (!linesOf(page).some((line) => READ_ON.test(line))) {
      findings.push(`${LEGITIMACY_PAGE}: no "read on YYYY-MM-DD" line`);
    }
    if (!NOMINATIVE.test(page)) {
      findings.push(`${LEGITIMACY_PAGE}: neither the word "nominative" nor the phrase "only to say which platform"`);
    }
  }
  if (readme !== undefined && !LEGITIMACY_LINK.test(readme)) {
    findings.push(`${ROOT_README}: no link to ${LEGITIMACY_PAGE} (a Markdown link target "](${LEGITIMACY_PAGE})")`);
  }
}

function checkManifests(reader: Reader, findings: string[]): void {
  for (const path of ["package.json", ...reader.packageManifests()]) {
    const file = reader.json(path);
    if ("absent" in file) continue;
    if ("invalid" in file) {
      findings.push(file.invalid);
      continue;
    }
    const manifest = file.fields;
    const name = manifest["name"];
    if (typeof name === "string" && name.startsWith("@grip/")) {
      findings.push(`${path}: name starts with @grip/ (${JSON.stringify(name)})`);
    }
    const repository = manifest["repository"];
    const url =
      typeof repository === "string"
        ? repository
        : typeof repository === "object" && repository !== null
          ? (repository as Record<string, unknown>)["url"]
          : undefined;
    if (url !== undefined && (typeof url !== "string" || !isRepositoryUrl(url))) {
      findings.push(`${path}: repository.url ${JSON.stringify(url)} does not point at ${REPOSITORY_URL}`);
    }
  }

  // An invalid umbrella manifest is already a finding from the loop above.
  const umbrellaFile = reader.json(UMBRELLA_MANIFEST);
  if ("absent" in umbrellaFile) {
    findings.push(`${UMBRELLA_MANIFEST}: missing`);
  } else if ("fields" in umbrellaFile) {
    const umbrella = umbrellaFile.fields;
    const description = umbrella["description"];
    if (typeof description !== "string" || !description.startsWith("Unofficial")) {
      findings.push(`${UMBRELLA_MANIFEST}: description does not start with "Unofficial"`);
    }
    const keywords = umbrella["keywords"];
    for (const keyword of ["unofficial", "grip-events"]) {
      if (!Array.isArray(keywords) || !keywords.includes(keyword)) {
        findings.push(`${UMBRELLA_MANIFEST}: keywords do not include ${JSON.stringify(keyword)}`);
      }
    }
    const homepage = umbrella["homepage"];
    if (typeof homepage !== "string" || !isUnderRepository(homepage)) {
      findings.push(
        `${UMBRELLA_MANIFEST}: homepage ${JSON.stringify(homepage ?? null)} is not under ${REPOSITORY_URL}`,
      );
    }
  }

  const server = reader.json(SERVER_MANIFEST);
  if ("absent" in server) {
    findings.push(`${SERVER_MANIFEST}: missing`);
  } else if ("invalid" in server) {
    findings.push(server.invalid);
  } else {
    const description = server.fields["description"];
    if (typeof description !== "string" || !description.includes("Unofficial")) {
      findings.push(`${SERVER_MANIFEST}: description does not contain "Unofficial"`);
    }
  }
}

/** The findings of the four rules over the tree at `repoRoot`, in rule order. */
export function checkPosture(repoRoot: string): string[] {
  return postureReport(repoRoot).findings;
}

/** The findings of the four rules over the tree at `repoRoot`, and how many files were read. */
export function postureReport(repoRoot: string): { findings: string[]; filesChecked: number } {
  const reader = new Reader(repoRoot);
  const findings: string[] = [];
  const readme = reader.text(ROOT_README);
  if (readme === undefined) findings.push(`${ROOT_README}: missing`);
  checkDisclaimer(reader, readme, findings);
  checkMcpWarning(readme, findings);
  checkLegitimacy(reader, readme, findings);
  checkManifests(reader, findings);
  return { findings, filesChecked: reader.read.size };
}

export function main(argv: readonly string[] = process.argv.slice(2), repoRoot: string = process.cwd()): number {
  if (argv.length > 0) {
    process.stderr.write(`usage: check-readme-posture (unknown argument ${argv.join(" ")})\n`);
    return 2;
  }
  const { findings, filesChecked } = postureReport(repoRoot);
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stderr.write(
      `\nFAIL: ${String(findings.length)} finding(s). The disclaimer block, the MCP warning, the legitimacy page and the unofficial framing ship as decided (issue #19); this check reads files only.\n`,
    );
    return 1;
  }
  process.stdout.write(`posture: ${String(filesChecked)} file(s) checked, nothing to report\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
