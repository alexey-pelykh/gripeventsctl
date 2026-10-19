// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES and CAP-PACING: `attendees get` at the surface (issue #11 § Acceptance Criteria): the real CLI program
 * through `runCli()` and the real MCP server through `linkMcp()`, over a temporary home holding a synthetic session
 * and `mockGrip()` serving `profile200()`. The request path for a number, `user_id` and `me`; the key-value block and
 * `--json` with exactly the seven keys, extra keys absent; the help naming `user_id` and `me`; the usage errors that
 * send nothing; the id mismatch as the `api` kind on both surfaces; two reads started together spaced by the
 * transport's 1,000 ms; no file written; and every request path matching the documented template.
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
  gripPool,
  linkMcp,
  mockGrip,
  profile200,
  runCli,
  withTempHome,
} from "@gripeventsctl/testing";
import { afterAll, describe, expect, it } from "vitest";

import { buildServer } from "../index.js";

const agent = mockGrip();

const TOOL = "gripeventsctl_attendees_get";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
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

async function withSession<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await storeSession(home, fixtureSecrets().sessionToken);
    return fn(home);
  });
}

function armProfile(segment: string, reply: () => ReturnType<typeof profile200>, times = 1): void {
  gripPool(agent)
    .intercept({ path: `/1/container/1/thing/${segment}`, method: "GET" })
    .reply(reply)
    .times(times);
}

function io(home: TempHome, clock = fakeClock()) {
  return { terminal: fakeTerminal().terminal, dispatcher: agent, clock, env: home.env };
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

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

const SPEAKER = [
  { session_name: "Session 1", description: "d", track: "t", location: "Room 1", date_start: 1760000000 },
];

const FULL = {
  rtm: { "Job Level": "Test Level" },
  rtm_raw: { job_level: "test-level" },
  speaker: SPEAKER,
  common_containers: [{ id: 2 }],
  common_connections_count: 3,
  rtm_score: 0.5,
};

const PROJECTED = {
  id: 42,
  rtm: { "Job Level": "Test Level" },
  rtm_raw: { job_level: "test-level" },
  sessions_speaker: SPEAKER,
  common_containers: [{ id: 2 }],
  common_connections_count: 3,
  rtm_score: 0.5,
};

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("[CAP-ATTENDEES] [CAP-PACING] attendees get at the surface: the CLI leaf and the MCP twin over the mocked profile", () => {
  afterAll(() => {
    // AC-17: every request this file sent matches the documented template; none is an organiser path or thing/type.
    for (const call of calls()) {
      expect(call.path, call.fullUrl).toMatch(/^\/1\/container\/1\/thing\/(\d+|user_id)$/);
      expect(call.fullUrl).not.toContain("thing/type");
    }
  });

  it("AC-13: attendees get 42 requests container/1/thing/42; stdout is the key-value block with the seven keys; --json carries exactly those keys; extra keys of the answer are absent from every form", async () => {
    await withSession(async (home) => {
      armProfile("42", () => profile200(42, { ...FULL, extra: { email: "test.person.42@example.com" } }), 3);
      const clock = fakeClock();
      const human = await runCli(["attendees", "get", "42"], io(home, clock));
      expect(human.exitCode, human.stderr).toBe(0);
      expect(lines(human.stdout)).toEqual([
        "id: 42",
        'rtm: {"Job Level":"Test Level"}',
        'rtm_raw: {"job_level":"test-level"}',
        `sessions_speaker: ${JSON.stringify(SPEAKER)}`,
        'common_containers: [{"id":2}]',
        "common_connections_count: 3",
        "rtm_score: 0.5",
      ]);
      expect(calls().at(-1)?.fullUrl).toBe(`${MOCK_API_ORIGIN}/1/container/1/thing/42`);
      expect(human.stdout).not.toContain("Test Person");
      expect(human.stdout).not.toContain("email");

      await clock.advance(1_000);
      const machine = await runCli(["--json", "attendees", "get", "42"], io(home, clock));
      expect(machine.exitCode, machine.stderr).toBe(0);
      const json = JSON.parse(machine.stdout) as Record<string, unknown>;
      expect(json).toStrictEqual(PROJECTED);
      expect(Object.keys(json)).toEqual(Object.keys(PROJECTED));

      await clock.advance(1_000);
      const result = await withServer(home, (link) => link.callTool(TOOL, { thing_id: 42 }));
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toStrictEqual(PROJECTED);
    });
  });

  it("AC-14: user_id and me both request container/1/thing/user_id and show the id the answer carried; --help says user_id is your own record and me is its alias", async () => {
    await withSession(async (home) => {
      armProfile("user_id", () => profile200(7), 2);
      const clock = fakeClock();
      const own = await runCli(["--json", "attendees", "get", "user_id"], io(home, clock));
      expect(own.exitCode, own.stderr).toBe(0);
      expect((JSON.parse(own.stdout) as { id: number }).id).toBe(7);
      await clock.advance(1_000);
      const alias = await runCli(["--json", "attendees", "get", "me"], io(home, clock));
      expect(alias.exitCode, alias.stderr).toBe(0);
      expect((JSON.parse(alias.stdout) as { id: number }).id).toBe(7);
      expect(
        calls()
          .slice(-2)
          .map((call) => call.path),
      ).toEqual(["/1/container/1/thing/user_id", "/1/container/1/thing/user_id"]);

      const help = await runCli(["attendees", "get", "--help"], io(home));
      expect(help.exitCode).toBe(0);
      // Commander wraps the argument help at the terminal width; the sentence is read with its line breaks joined.
      const unwrapped = help.stdout.replace(/\s+/g, " ");
      expect(unwrapped).toContain("user_id is your own record");
      expect(unwrapped).toContain("me is its alias");
      expect(help.stdout).toContain("<thing_id>");
    });
  });

  it.each([["abc"], ["0"], ["-1"], ["1.5"]])(
    "AC-14: attendees get %s exits 2 with a usage message naming thing_id and sends no request",
    async (value) => {
      await withSession(async (home) => {
        const before = calls().length;
        const result = await runCli(["attendees", "get", value], io(home));
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("thing_id");
        expect(calls().length - before).toBe(0);
      });
    },
  );

  it("AC-15: an answer carrying id 43 for a request of 42 is the api kind, exit 1, with the fixed message, and isError api on MCP", async () => {
    await withSession(async (home) => {
      armProfile("42", () => profile200(43), 2);
      const clock = fakeClock();
      const result = await runCli(["attendees", "get", "42"], io(home, clock));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("profile id mismatch: requested 42, answer carries 43");
      await clock.advance(1_000);
      const mcp = await withServer(home, (link) => link.callTool(TOOL, { thing_id: 42 }));
      expect(mcp.isError).toBe(true);
      const error = (mcp.structuredContent as { error: { kind: string; message: string } }).error;
      expect(error.kind).toBe("api");
      expect(error.message).toBe("profile id mismatch: requested 42, answer carries 43");
    });
  });

  it("AC-16: two attendees get runs started together on one clock do not overlap, the second is sent at least 1,000 ms after the first, and the home holds no new file", async () => {
    await withSession(async (home) => {
      const clock = fakeClock();
      const sentAt: number[] = [];
      let inFlight = 0;
      let overlapped = false;
      gripPool(agent)
        .intercept({ path: "/1/container/1/thing/1", method: "GET" })
        .reply(async () => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          sentAt.push(clock.now().getTime());
          await new Promise<void>((resolve) => setImmediate(resolve));
          inFlight -= 1;
          return profile200(1);
        })
        .times(2);
      const first = runCli(["attendees", "get", "1"], io(home, clock));
      const second = runCli(["attendees", "get", "1"], io(home, clock));
      await settle();
      expect(sentAt).toHaveLength(1);
      await clock.advance(999);
      await settle();
      expect(sentAt).toHaveLength(1);
      await clock.advance(1);
      const results = await Promise.all([first, second]);
      for (const result of results) expect(result.exitCode, result.stderr).toBe(0);
      expect(sentAt).toHaveLength(2);
      expect((sentAt[1] ?? 0) - (sentAt[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
      expect(overlapped).toBe(false);
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
