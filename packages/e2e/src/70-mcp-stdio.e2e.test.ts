// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 70-mcp-stdio (issue #18 § The nine files, item 9): the built binary as `gripeventsctl mcp` over real
 * stdio on the real home, so the child reads the maintainer's config exactly as a host's child would.
 * The tool list is the v1 set (`lib/write-operations.ts`), one read answers, the child's stderr opens
 * with the start line naming the config path, and `close()` ends the child.
 *
 * The client writes one redacted diagnostic line per request to the server's stderr (issue #5), so the
 * child's stderr holds the start line and those lines, and nothing else: the test asserts that shape,
 * and reads the read's HTTP status from its diagnostic line for the summary line.
 */

import { homedir } from "node:os";

import { spawnMcpStdio } from "@gripeventsctl/testing";
import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, openLive, requestShapes } from "./lib/live-check.js";
import { classify, conclude, drift } from "./lib/outcome.js";
import { runDate, summaryLine } from "./lib/summary.js";
import { V1_TOOL_NAMES } from "./lib/write-operations.js";

const FILE = "70-mcp-stdio";
const READ_TOOL = "gripeventsctl_schedule_info";
const SHAPE = requestShapes(READ_TOOL)[0];

/** A client diagnostic line: the method, the path template and what came of the attempt. */
const DIAGNOSTIC_LINE = /^(GET|POST) (\S+): (.*)$/u;

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

async function waitForLines(read: () => string, count: number, timeoutMs = 10_000): Promise<string[]> {
  const lines = (): string[] =>
    read()
      .split(/\r?\n/u)
      .filter((line) => line !== "");
  for (let waited = 0; lines().length < count && waited < timeoutMs; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lines();
}

describe("[CAP-E2E] 70-mcp-stdio: the built binary over stdio on the real home", () => {
  it("lists exactly the v1 tools, answers one read, opens stderr with the start line, and ends", async (ctx) => {
    const { session } = fixture.ready(ctx);
    if (SHAPE === undefined) return drift(`${READ_TOOL} declares no request shape`);
    const link = await spawnMcpStdio({
      home: homedir(),
      env: { GRIPEVENTSCTL_CONFIG_FILE: process.env["GRIPEVENTSCTL_CONFIG_FILE"] ?? "" },
    });
    try {
      const names = (await link.listTools()).map((tool) => tool.name);
      const missing = V1_TOOL_NAMES.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !V1_TOOL_NAMES.includes(name));
      if (missing.length > 0 || extra.length > 0) {
        drift(
          `the tool list is not the v1 set: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`,
        );
      }
      if (names.some((name) => name.startsWith("gripeventsctl_auth_"))) drift("an auth tool is listed");
      if (names.includes("gripeventsctl_attendance_get")) drift("the held attendance get is listed");

      const result = await link.callTool(READ_TOOL, {});
      const classification = classify(result, ["items"]);

      const lines = await waitForLines(() => link.stderr(), 2);
      const [start, ...rest] = lines;
      if (start === undefined || !start.startsWith(`gripeventsctl mcp: config ${session.configPath}, `)) {
        drift("the child's first stderr line is not the start line naming the config path");
      }
      let status: number | "-" = "-";
      for (const line of rest) {
        const match = DIAGNOSTIC_LINE.exec(line);
        if (match === null)
          drift("the child's stderr holds a line that is neither the start line nor a client diagnostic line");
        const [, method, template, rest2] = match;
        const code = /^(\d{3})\b/u.exec(rest2 ?? "")?.[1];
        if (method === SHAPE.method && template === SHAPE.pathTemplate.split("?")[0] && code !== undefined)
          status = Number(code);
      }
      process.stderr.write(
        `${summaryLine(FILE, classification.outcome, SHAPE.method, SHAPE.pathTemplate, status, runDate())}\n`,
      );
      conclude(ctx, classification.outcome, classification.reason);
    } finally {
      await link.close();
    }
  });
});
