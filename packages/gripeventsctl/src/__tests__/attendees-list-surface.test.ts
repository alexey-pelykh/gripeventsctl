// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES: `attendees list` at the surface (issue #11 § Acceptance Criteria): the real CLI program through
 * `runCli()` and the real MCP server through `linkMcp()`, over a temporary home holding a synthetic session and
 * `mockGrip()` serving the directory-search builders. The request URL with the trailing slash and the literal comma,
 * the headers, the table followed by the two lines, `--json` as the bare object, the MCP `structuredContent` equal to
 * it, the last page and the empty page, the usage errors that send nothing, the duplicated id sent once, the gated
 * set and the other refusals with their exit codes, the hostile strings escaped for a human and raw for a machine,
 * the registered secret redacted everywhere, no file written, and every request path matching the documented
 * template.
 */

import { readdir, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";

import {
  MOCK_API_ORIGIN,
  type McpLink,
  type TempHome,
  fakeClock,
  fakeTerminal,
  fixtureSecrets,
  gatedType403,
  gripPool,
  linkMcp,
  loadBalancer403,
  mockGrip,
  runCli,
  searchEmpty200,
  searchEntries200,
  unauthorized401,
  withTempHome,
} from "@gripeventsctl/testing";
import { afterAll, describe, expect, it } from "vitest";

import { buildServer } from "../index.js";

const agent = mockGrip();

const TOOL = "gripeventsctl_attendees_list";
const SEARCH = "/1/container/1/search/";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function lowerHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || headers === undefined) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    return out;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

class Sink extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

async function storeSession(home: TempHome, token: string): Promise<void> {
  const config = [
    "version: 1",
    "session:",
    "  slug: testevent1",
    "  container_id: 1",
    `  token: ${token}`,
    '  signed_in_at: "2026-10-12T10:00:00.000Z"',
    "writes:",
    "  enabled: false",
    "",
  ].join("\n");
  await writeFile(home.configFile, config, { mode: 0o600 });
}

async function withSession<T>(fn: (home: TempHome, token: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const { sessionToken } = fixtureSecrets();
    await storeSession(home, sessionToken);
    return fn(home, sessionToken);
  });
}

function armSearch(reply: () => ReturnType<typeof searchEmpty200>): void {
  gripPool(agent)
    .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
    .reply(reply);
}

function io(home: TempHome) {
  return { terminal: fakeTerminal().terminal, dispatcher: agent, clock: fakeClock(), env: home.env };
}

async function withServer<T>(home: TempHome, fn: (link: McpLink) => Promise<T>): Promise<T> {
  const link = await linkMcp(
    buildServer("0.0.0", { env: home.env, clock: fakeClock(), dispatcher: agent, stderr: new Sink() }),
  );
  try {
    return await fn(link);
  } finally {
    await link.close();
  }
}

function textOf(result: Awaited<ReturnType<McpLink["callTool"]>>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function errorKindOf(stderr: string): string {
  const last =
    stderr
      .split("\n")
      .filter((line) => line !== "")
      .at(-1) ?? "";
  return (JSON.parse(last) as { error: { kind: string } }).error.kind;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

function entries(from: number, count: number): { id: number; name: string }[] {
  return Array.from({ length: count }, (_u, i) => ({ id: from + i, name: `Test Person ${String(from + i)}` }));
}

describe("[CAP-ATTENDEES] attendees list at the surface: the CLI leaf and the MCP twin over the mocked directory search", () => {
  afterAll(() => {
    // AC-17: every request this file sent matches the documented template; none is an organiser path or thing/type.
    for (const call of calls()) {
      expect(call.path, call.fullUrl).toBe(SEARCH);
      expect(call.fullUrl).not.toContain("thing/type");
    }
  });

  it("AC-1: --type 1,2 --page 2 sends one GET to container/1/search/?page=2&sort=name&type_id=1,2 with the headers; stdout is the id-first table then page: 2 and next_page: 3; --json and structuredContent are the same object", async () => {
    await withSession(async (home, token) => {
      armSearch(() => searchEntries200(entries(21, 20)));
      const before = calls().length;
      const human = await runCli(["attendees", "list", "--type", "1,2", "--page", "2"], io(home));
      expect(human.exitCode, human.stderr).toBe(0);
      const out = lines(human.stdout);
      expect(out[0]).toBe("id | name");
      expect(out[1]).toBe("21 | Test Person 21");
      expect(out).toHaveLength(23);
      expect(out.slice(-2)).toEqual(["page: 2", "next_page: 3"]);
      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}${SEARCH}?page=2&sort=name&type_id=1,2`);
      expect(call?.fullUrl).not.toContain("%2C");
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");

      armSearch(() => searchEntries200(entries(21, 20)));
      const machine = await runCli(["--json", "attendees", "list", "--type", "1,2", "--page", "2"], io(home));
      expect(machine.exitCode, machine.stderr).toBe(0);
      const json = JSON.parse(machine.stdout) as unknown;
      expect(json).toStrictEqual({ page: 2, next_page: 3, entries: entries(21, 20) });

      armSearch(() => searchEntries200(entries(21, 20)));
      const result = await withServer(home, (link) => link.callTool(TOOL, { type_ids: [1, 2], page: 2 }));
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toStrictEqual(json);
      expect(textOf(result)).toBe(human.stdout.trimEnd());
      expect(calls().length - before).toBe(3);
    });
  });

  it("AC-2: 7 entries give next_page null as the last line; an empty page prints the empty sentence then page: 1 and next_page: null, exit 0, and --json holds entries []", async () => {
    await withSession(async (home) => {
      armSearch(() => searchEntries200(entries(1, 7)));
      const seven = await runCli(["attendees", "list", "--type", "1"], io(home));
      expect(seven.exitCode, seven.stderr).toBe(0);
      expect(lines(seven.stdout).at(-1)).toBe("next_page: null");
      expect(lines(seven.stdout)).toHaveLength(10);

      armSearch(() => searchEmpty200());
      const empty = await runCli(["attendees", "list", "--type", "1"], io(home));
      expect(empty.exitCode, empty.stderr).toBe(0);
      expect(lines(empty.stdout)).toEqual(["no attendees of these types", "page: 1", "next_page: null"]);

      armSearch(() => searchEmpty200());
      const machine = await runCli(["--json", "attendees", "list", "--type", "1"], io(home));
      expect(JSON.parse(machine.stdout)).toStrictEqual({ page: 1, next_page: null, entries: [] });
    });
  });

  it.each([
    ["--page 0", ["--type", "1,2", "--page", "0"], "page"],
    ["--type x", ["--type", "x"], "type_ids"],
    ["--type with no value", ["--type"], "type"],
    ["no --type", [], "type"],
    ["--type-ids 1, which is not the flag", ["--type-ids", "1"], "--type <ids>"],
  ])(
    "AC-3: %s exits 2 with a usage message naming the key and the help on stderr, and sends no request",
    async (_label, args, key) => {
      await withSession(async (home) => {
        const before = calls().length;
        const result = await runCli(["attendees", "list", ...args], io(home));
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(key);
        expect(result.stderr).toContain("Usage:");
        expect(result.stderr).not.toMatch(/^\s+--type-ids/m);
        expect(calls().length - before).toBe(0);
      });
    },
  );

  it("AC-3: a duplicated id --type 1,1 sends type_id=1", async () => {
    await withSession(async (home) => {
      armSearch(() => searchEmpty200());
      const result = await runCli(["attendees", "list", "--type", "1,1"], io(home));
      expect(result.exitCode, result.stderr).toBe(0);
      expect(calls().at(-1)?.fullUrl).toBe(`${MOCK_API_ORIGIN}${SEARCH}?page=1&sort=name&type_id=1`);
    });
  });

  it("AC-4: a gated set is gated-type, exit 6, the hint naming events check and one id per call, one request; MCP answers isError gated-type; a 401 is auth-failed exit 3; the HTML 403 is load-balancer-rejected exit 6", async () => {
    await withSession(async (home) => {
      const before = calls().length;
      armSearch(() => gatedType403(2));
      const gated = await runCli(["attendees", "list", "--type", "1,2"], io(home));
      expect(gated.exitCode).toBe(6);
      expect(gated.stdout).toBe("");
      expect(gated.stderr).toContain("events check");
      expect(gated.stderr).toContain("one id per call");
      expect(gated.stderr).toContain("the answer names id 2");
      expect(calls().length - before).toBe(1);

      armSearch(() => gatedType403(2));
      const result = await withServer(home, (link) => link.callTool(TOOL, { type_ids: [1, 2] }));
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { kind: string } }).error.kind).toBe("gated-type");
      expect(calls().length - before).toBe(2);

      armSearch(() => unauthorized401());
      const unauthorized = await runCli(["--json", "attendees", "list", "--type", "1"], io(home));
      expect(unauthorized.exitCode).toBe(3);
      expect(errorKindOf(unauthorized.stderr)).toBe("auth-failed");

      armSearch(() => loadBalancer403());
      const rejected = await runCli(["--json", "attendees", "list", "--type", "1"], io(home));
      expect(rejected.exitCode).toBe(6);
      expect(errorKindOf(rejected.stderr)).toBe("load-balancer-rejected");
      expect(calls().length - before).toBe(4);
    });
  });

  it("AC-18: an entry holding an escape sequence, a right-to-left override or a zero-width space renders escaped for a human and in the MCP text, and raw in --json and structuredContent; a registered secret is <REDACTED> in every form", async () => {
    await withSession(async (home, token) => {
      const hostile = [
        { id: 1, name: "Test\x1b[2J Person" },
        { id: 2, name: "Test ‮Person" },
        { id: 3, name: "Test​ Person" },
        { id: 4, name: "Test Person 4", note: `token ${token}` },
      ];
      armSearch(() => searchEntries200(hostile));
      const human = await runCli(["attendees", "list", "--type", "1"], io(home));
      expect(human.exitCode, human.stderr).toBe(0);
      expect(human.stdout).toContain("1 | Test\\x1b[2J Person");
      expect(human.stdout).toContain("2 | Test \\u{202e}Person");
      expect(human.stdout).toContain("3 | Test\\u{200b} Person");
      expect(human.stdout).toContain("token <REDACTED>");
      expect(human.stdout).not.toContain("\x1b");
      expect(human.stdout).not.toContain("‮");
      expect(human.stdout).not.toContain("​");
      expect(human.stdout).not.toContain(token);

      armSearch(() => searchEntries200(hostile));
      const machine = await runCli(["--json", "attendees", "list", "--type", "1"], io(home));
      const json = JSON.parse(machine.stdout) as { entries: { name: string; note?: string }[] };
      expect(json.entries.map((entry) => entry.name)).toEqual(hostile.map((entry) => entry.name));
      expect(json.entries[3]?.note).toBe("token <REDACTED>");
      expect(machine.stdout).not.toContain(token);

      armSearch(() => searchEntries200(hostile));
      const result = await withServer(home, (link) => link.callTool(TOOL, { type_ids: [1] }));
      expect(textOf(result)).toContain("1 | Test\\x1b[2J Person");
      expect(textOf(result)).toContain("2 | Test \\u{202e}Person");
      expect(textOf(result)).toContain("token <REDACTED>");
      const structured = result.structuredContent as { entries: { name: string; note?: string }[] };
      expect(structured.entries.map((entry) => entry.name)).toEqual(hostile.map((entry) => entry.name));
      expect(structured.entries[3]?.note).toBe("token <REDACTED>");
      expect(JSON.stringify(result)).not.toContain(token);
    });
  });

  it("AC-16: a list run on either surface leaves no new file in the temporary home", async () => {
    await withSession(async (home) => {
      armSearch(() => searchEntries200(entries(1, 2)));
      await runCli(["attendees", "list", "--type", "1"], io(home));
      armSearch(() => searchEntries200(entries(1, 2)));
      await withServer(home, (link) => link.callTool(TOOL, { type_ids: [1] }));
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });

  it("AC-19: attendees --help lists list, dump and get, and attendees list --help shows --type <ids> and --page <n> with the default", async () => {
    await withSession(async (home) => {
      const before = calls().length;
      const group = await runCli(["attendees", "--help"], io(home));
      expect(group.exitCode).toBe(0);
      for (const verb of ["list", "dump", "get"]) expect(group.stdout).toContain(verb);
      const leaf = await runCli(["attendees", "list", "--help"], io(home));
      expect(leaf.exitCode).toBe(0);
      expect(leaf.stdout).toContain("--type <ids>");
      expect(leaf.stdout).toContain("--page <n>");
      // Commander wraps the option help at the terminal width; the default is read with its line breaks joined.
      expect(leaf.stdout.replace(/\s+/g, " ")).toContain("(default: 1)");
      expect(leaf.stdout).toContain("events check");
      expect(leaf.stdout).not.toContain("--type-ids");
      expect(calls().length - before).toBe(0);
    });
  });
});
