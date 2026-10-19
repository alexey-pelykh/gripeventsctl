// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The static rules of `lib/suite-shape.ts` graded over synthetic trees (issue #18 § The harness unit tests,
 * `suite-shape.test.ts`): a clean tree reports nothing, and a copy with one rule broken names the file and the rule.
 * The run over the tracked tree, the repository gate, is `scripts/__tests__/e2e-suite-shape.test.ts`. The tool
 * lists of `lib/write-operations.ts` are graded against the registry here.
 */

import { OPERATIONS } from "@gripeventsctl/core";
import { describe, expect, it } from "vitest";

import {
  LIVE_DIR,
  LIVE_FILE_NAMES,
  WORKFLOWS_DIR,
  isLiveFile,
  shapeFindings,
  withoutHeader,
} from "../lib/suite-shape.js";
import { V1_TOOL_NAMES, WRITE_TOOL_NAMES } from "../lib/write-operations.js";

const HEADER = "// SPDX-License-Identifier: AGPL-3.0-only\n// Copyright (C) 2026 Oleksii PELYKH\n";

/** A clean synthetic tree: the nine live files with the header and nothing offending, and one clean workflow. */
function cleanTree(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of LIVE_FILE_NAMES)
    files.set(`${LIVE_DIR}${name}`, `${HEADER}\ndescribe("[CAP-E2E] ${name}", () => {});\n`);
  files.set(`${WORKFLOWS_DIR}ci.yml`, "env:\n  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n");
  return files;
}

describe("[CAP-E2E] the rules over the live files and the workflows", () => {
  it("finds nothing over a clean synthetic tree", () => {
    expect(shapeFindings(cleanTree())).toEqual([]);
  });

  it("names the file and the rule for each rule broken in a copy of the tree", () => {
    const first = `${LIVE_DIR}${LIVE_FILE_NAMES[0] ?? ""}`;
    const stdio = `${LIVE_DIR}70-mcp-stdio.e2e.test.ts`;
    const workflow = `${WORKFLOWS_DIR}ci.yml`;
    const broken: [string, string, string][] = [
      [first, 'callTool("gripeventsctl_chat_send", {})', "names the write gripeventsctl_chat_send"],
      [stdio, '"gripeventsctl_interest_show"', "names the write gripeventsctl_interest_show"],
      [first, 'kind === "interest.skip"', "names the write interest.skip"],
      [first, "match_manual", "names the write match_manual"],
      [first, 'callTool("gripeventsctl_attendees_dump", {})', "names attendees_dump"],
      [first, "const containerId = 9840;", "integer literal of four or more digits"],
      [first, "https://matchmaking.grip.events/testevent", "matchmaking.grip.events/"],
      [first, "{ container_id: 7 }", "container_id: followed by a digit"],
      [first, 'await writeFile("x", "y")', "writes a file (writeFile)"],
      [first, '"--out"', "names --out"],
      [first, 'const Password = "x"', "password literal"],
      [first, 'expect.fail("x")', "fails outside the harness (expect.fail("],
      [first, 'throw new Error("x")', "fails outside the harness (throw new Error("],
      [workflow, "env:\n  GRIPEVENTSCTL_E2E: 1\n", "sets GRIPEVENTSCTL_E2E"],
      [workflow, "run: pnpm test:e2e\n", "runs test:e2e"],
      [workflow, "token: ${{ secrets.GRIPEVENTSCTL_TOKEN }}\n", "references secrets.GRIPEVENTSCTL_TOKEN"],
      [workflow, "token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}\n", "references secrets.OP_SERVICE_ACCOUNT_TOKEN"],
    ];
    for (const [path, snippet, rule] of broken) {
      const copy = cleanTree();
      copy.set(path, `${copy.get(path) ?? ""}${snippet}\n`);
      const findings = shapeFindings(copy);
      expect(findings.length, rule).toBeGreaterThan(0);
      expect(
        findings.some((finding) => finding.startsWith(`${path}: `) && finding.includes(rule)),
        rule,
      ).toBe(true);
    }
  });

  it("names a tenth live file, at the top level or nested where the live config would collect it, and a missing one", () => {
    const extra = cleanTree();
    extra.set(`${LIVE_DIR}80-extra.e2e.test.ts`, HEADER);
    expect(shapeFindings(extra)).toEqual([`${LIVE_DIR}80-extra.e2e.test.ts: not one of the nine live file names`]);
    const nested = cleanTree();
    nested.set(`${LIVE_DIR}__tests__/80-nested.e2e.test.ts`, `${HEADER}callTool("gripeventsctl_attendees_dump", {})\n`);
    expect(shapeFindings(nested)).toEqual([
      `${LIVE_DIR}__tests__/80-nested.e2e.test.ts: not one of the nine live file names`,
      `${LIVE_DIR}__tests__/80-nested.e2e.test.ts: names attendees_dump; the suite never dumps`,
    ]);
    const missing = cleanTree();
    missing.delete(`${LIVE_DIR}30-match.e2e.test.ts`);
    expect(shapeFindings(missing)).toEqual([
      `${LIVE_DIR}30-match.e2e.test.ts: missing; the nine live files must exist`,
    ]);
  });

  it("leaves the copyright year out of the integer-literal rule, and only the header lines", () => {
    expect(withoutHeader(HEADER)).toBe("");
    expect(withoutHeader(`${HEADER}// Copyright (C) 2026 Oleksii PELYKH\n`)).toBe(
      "// Copyright (C) 2026 Oleksii PELYKH\n",
    );
    expect(withoutHeader("const x = 1;\n// Copyright (C) 2026 Oleksii PELYKH\n")).toBe(
      "const x = 1;\n// Copyright (C) 2026 Oleksii PELYKH\n",
    );
  });

  it("reads only the tracked files under the two directories", () => {
    expect(isLiveFile(`${LIVE_DIR}00-session.e2e.test.ts`)).toBe(true);
    expect(isLiveFile(`${LIVE_DIR}__tests__/summary.test.ts`)).toBe(false);
    expect(isLiveFile(`${LIVE_DIR}__tests__/80-nested.e2e.test.ts`)).toBe(true);
    expect(isLiveFile(`${LIVE_DIR}lib/outcome.ts`)).toBe(false);
    expect(isLiveFile("packages/core/src/x.e2e.test.ts")).toBe(false);
  });
});

describe("[CAP-E2E] the tool lists", () => {
  it("name the registry's v1 tools in registry order, and its three writes", () => {
    const toolOf = (op: { group: string; verb: string }): string => `gripeventsctl_${op.group}_${op.verb}`;
    expect([...V1_TOOL_NAMES]).toEqual(OPERATIONS.map(toolOf));
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(
      OPERATIONS.filter((op) => op.kind === "write")
        .map(toolOf)
        .sort(),
    );
    expect(V1_TOOL_NAMES.some((name) => name.startsWith("gripeventsctl_auth_"))).toBe(false);
    expect(V1_TOOL_NAMES).not.toContain("gripeventsctl_attendance_get");
  });
});
