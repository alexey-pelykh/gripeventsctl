// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-WRITES and CAP-GATE, surface, the MCP path of the three gated writes (issue #17 § Acceptance Criteria), driven
 * through the real server over the in-memory link with the registry `OPERATIONS`, a temporary home holding a
 * synthetic session with writes enabled unless stated, `mockGrip()` serving the envelope builders and a fake clock.
 * `tools/list` carries the three twins with the documented input schemas, the two write sentences and the
 * destructive and open-world hints, and no secret-named key; a string thing id is a schema error with no request;
 * a missing go-ahead for `interest show` with a text proposes one after the status read and refuses with the fixed
 * hint, an approved record for the exact text is consumed and the POST sent, and a record for another text does not
 * match; `interest show` without a text and `interest skip` send with no go-ahead and no proposal; `dry_run` reads
 * the status for the two interest writes and nothing for chat, sends nothing, reports the real request with a
 * registered secret redacted, and leaves a flagged line; safe mode refuses each write before any request while a
 * read still runs; a 401 on the status read is `auth-failed` with no line and `auth_failed_at` recorded, a 401 on
 * the POST a failed line; and the text block renders an echoed message escaped while `structuredContent` stays raw.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";

import { GO_AHEAD_TTL_MS, OPERATIONS, loadConfig } from "@gripeventsctl/core";
import {
  type Clock,
  type GripReply,
  type McpLink,
  type TempHome,
  appendJsonLine,
  chatSend200,
  eventFields,
  fixtureSecrets,
  gripPool,
  journalEvent,
  linkMcp,
  matchAnswer201,
  matchStatus200,
  mockGrip,
  readJournal,
  readSendLog,
  sha256Of,
  unauthorized401,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { buildServer } from "../index.js";
import { WRITE_BOUNDARY, WRITE_POSTURE } from "../lib/tool-from-operation.js";

const agent = mockGrip();
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const SHOW = "gripeventsctl_interest_show";
const SKIP = "gripeventsctl_interest_skip";
const CHAT = "gripeventsctl_chat_send";
const STATUS_PATH = "/1/container/1/thing/user_id/match/42/status";
const YES_PATH = "/1/container/1/thing/user_id/match_manual/yes/to_thing/42";
const NO_PATH = "/1/container/1/thing/user_id/match_manual/no/to_thing/42";
const CHAT_PATH = "/1/chat/thing/42";
const YES_REQUEST = "container/1/thing/user_id/match_manual/yes/to_thing/42";
const NO_REQUEST = "container/1/thing/user_id/match_manual/no/to_thing/42";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function summary(since: number): string[] {
  return calls()
    .slice(since)
    .map((call) => `${call.method} ${call.path}`);
}

function bodyText(call: CallLog): string {
  const body: unknown = call.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body);
}

class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

function advancingClock(start = T0): Clock & { sleeps: number[] } {
  let current = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(current),
    sleep: (ms) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

/** Seed the home's config with a synthetic session in container 1; returns the token it holds. */
async function seed(home: TempHome, writesEnabled: boolean): Promise<string> {
  const { sessionToken } = fixtureSecrets();
  await writeFile(
    home.configFile,
    [
      "version: 1",
      "session:",
      "  slug: test-event-1",
      "  container_id: 1",
      `  token: ${sessionToken}`,
      '  signed_in_at: "2026-10-12T10:00:00.000Z"',
      "writes:",
      `  enabled: ${String(writesEnabled)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return sessionToken;
}

const paths = (home: TempHome) => ({
  sendLog: join(home.dir, ".gripeventsctl.send-log.jsonl"),
  journal: join(home.dir, ".gripeventsctl.go-aheads.jsonl"),
});

interface Outcome {
  isError: boolean;
  result: Record<string, unknown>;
  text: string;
  sleeps: number[];
}

/** One tool call through a fresh server over the registry: the SDK client validates error results per link. */
async function call(home: TempHome, tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const clock = advancingClock();
  const server = buildServer("0.0.0", { env: home.env, clock, dispatcher: agent, stderr: new Sink() });
  const link: McpLink = await linkMcp(server);
  try {
    const outcome = await link.callTool(tool, args);
    return {
      isError: outcome.isError === true,
      result: (outcome.structuredContent as Record<string, unknown> | undefined) ?? {},
      text: outcome.content.map((block) => ("text" in block ? String(block.text) : "")).join("\n"),
      sleeps: clock.sleeps,
    };
  } finally {
    await link.close();
  }
}

/** The write result's plan, typed for the assertions. */
interface Plan {
  kind: string;
  container_id: number;
  target_thing_id: number;
  request: { method: string; path: string; body: unknown };
  status_before: string | null;
  verdicts: Record<string, unknown>;
}

const planOf = (result: Record<string, unknown>): Plan => result["plan"] as Plan;

const errorOf = (result: Record<string, unknown>): { kind: string; message: string; hint: string } =>
  result["error"] as { kind: string; message: string; hint: string };

function armStatus(status: "has_match_none" | "has_match_yes" | "has_match_no" | "has_connection"): void {
  gripPool(agent)
    .intercept({ path: STATUS_PATH, method: "GET" })
    .reply(() => matchStatus200(status));
}

function armPost(path: string, reply: () => GripReply): void {
  gripPool(agent).intercept({ path, method: "POST" }).reply(reply);
}

/** A proposed and approved record for `message` to thing 42, approved an hour before T0; returns its id. */
async function approved(home: TempHome, kind: string, message: string): Promise<string> {
  const proposed = journalEvent({
    kind,
    target_thing_id: 42,
    message,
    time: new Date(T0 - 2 * 3_600_000).toISOString(),
  });
  await appendJsonLine(paths(home).journal, proposed);
  await appendJsonLine(paths(home).journal, {
    ...eventFields(proposed),
    event: "approved",
    time: new Date(T0 - 3_600_000).toISOString(),
    source: "cli",
  });
  return proposed.id;
}

const missingHint = (id: string): string =>
  `No recorded go-ahead for this text. Ask the user to run gripeventsctl writes go-ahead ${id} in a terminal of their own (not through the host's shell, which has no TTY), then call again with the same thing id and the same text.`;

describe("[CAP-WRITES] [CAP-GATE] the MCP path of the three gated writes: the documented twins, the go-ahead on a text, the dry run, safe mode and the failed reads", () => {
  it("tools/list carries the three twins with the documented input schemas, the two write sentences and the destructive and open-world hints, no secret-named key, and the registry's fourteen tools", async () => {
    await withTempHome(async (home) => {
      const link = await linkMcp(buildServer("0.0.0", { env: home.env, dispatcher: agent, stderr: new Sink() }));
      try {
        const tools = await link.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toHaveLength(14);
        expect(names).toEqual(OPERATIONS.map((op) => `gripeventsctl_${op.group}_${op.verb}`));
        expect(names.filter((name) => name.includes("attendance"))).toEqual([]);
        const expected: Record<string, { properties: string[]; required: string[]; sentence: string }> = {
          [SHOW]: {
            properties: ["thing_id", "message", "dry_run"],
            required: ["thing_id"],
            sentence:
              "Show interest in a person, with an optional intro message of at most 250 characters; this notifies them.",
          },
          [SKIP]: {
            properties: ["thing_id", "dry_run"],
            required: ["thing_id"],
            sentence: "Skip a person: record a no answer about them.",
          },
          [CHAT]: {
            properties: ["thing_id", "message", "dry_run"],
            required: ["thing_id", "message"],
            sentence: "Send a chat message to a person you are connected with; this reaches them.",
          },
        };
        for (const [name, shape] of Object.entries(expected)) {
          const tool = tools.find((candidate) => candidate.name === name);
          expect(tool, name).toBeDefined();
          const schema = tool?.inputSchema as {
            properties?: Record<string, { type?: string; default?: unknown }>;
            required?: string[];
          };
          expect(Object.keys(schema.properties ?? {}), name).toEqual(shape.properties);
          expect(schema.required ?? [], name).toEqual(shape.required);
          expect(schema.properties?.["thing_id"]?.type, name).toBe("integer");
          expect(schema.properties?.["dry_run"]?.type, name).toBe("boolean");
          expect(schema.properties?.["dry_run"]?.default, name).toBe(false);
          if (shape.properties.includes("message")) expect(schema.properties?.["message"]?.type, name).toBe("string");
          for (const banned of ["password", "token", "config", "config_path"]) {
            expect(Object.keys(schema.properties ?? {}), name).not.toContain(banned);
          }
          expect(tool?.description, name).toBe(`${shape.sentence} ${WRITE_POSTURE} ${WRITE_BOUNDARY}`);
          expect(tool?.annotations?.destructiveHint, name).toBe(true);
          expect(tool?.annotations?.openWorldHint, name).toBe(true);
          expect(tool?.annotations?.readOnlyHint, name).toBeUndefined();
        }
      } finally {
        await link.close();
      }
    });
  });

  it("a string thing id is a schema error on each twin, with no request and no send log line", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const before = calls().length;
      for (const [tool, args] of [
        [SHOW, { thing_id: "42" }],
        [SKIP, { thing_id: "42" }],
        [CHAT, { thing_id: "42", message: "Hi" }],
        [CHAT, { thing_id: 42, message: "" }],
      ] as const) {
        let outcome: Outcome | undefined;
        let thrown: unknown;
        try {
          outcome = await call(home, tool, { ...args });
        } catch (error: unknown) {
          thrown = error;
        }
        // The SDK refuses the arguments before the handler, as a thrown error or an error result; never a run.
        if (outcome !== undefined) {
          expect(outcome.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
          expect(outcome.result["plan"], `${tool}: no write result`).toBeUndefined();
        } else {
          expect(thrown, tool).toBeInstanceOf(Error);
        }
      }
      expect(calls().slice(before)).toEqual([]);
      await expect(stat(paths(home).sendLog)).rejects.toThrow();
    });
  });

  it("interest show with a text and no journal record: the status GET, no POST, go-ahead-missing with an id, an expiry and the fixed hint, one proposed event; an approved record for the text is consumed and the POST sent; a record for another text does not match", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      armStatus("has_match_none");
      let before = calls().length;
      const missing = await call(home, SHOW, { thing_id: 42, message: "Hello" });
      expect(missing.isError, missing.text).toBe(false);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(missing.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      const id = String(missing.result["go_ahead_id"]);
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(Date.parse(String(missing.result["go_ahead_expires_at"]))).toBe(T0 + GO_AHEAD_TTL_MS);
      expect(missing.result["hint"]).toBe(missingHint(id));
      expect(planOf(missing.result).status_before).toBe("has_match_none");
      expect(planOf(missing.result).verdicts).toEqual({
        writes_enabled: true,
        repeat_guard: "clear",
        status: "allowed",
        go_ahead: "missing",
      });
      expect(await readJournal(paths(home).journal)).toEqual([
        expect.objectContaining({
          event: "proposed",
          id,
          kind: "interest.show",
          container_id: 1,
          target_thing_id: 42,
          message: "Hello",
          message_sha256: sha256Of("Hello"),
          source: "mcp",
        }),
      ]);
      expect(await readSendLog(paths(home).sendLog)).toEqual([
        expect.objectContaining({ source: "mcp", outcome: "refused", refusal: "go-ahead-missing", go_ahead: null }),
      ]);

      // An approved record for another text never matches: a new proposal, still no POST.
      await approved(home, "interest.show", "Hello!");
      armStatus("has_match_none");
      before = calls().length;
      const mismatch = await call(home, SHOW, { thing_id: 42, message: "Hello" });
      expect(mismatch.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);

      // An approved record for the exact four fields: consumed before the POST, the line names the id.
      const approvedId = await approved(home, "interest.show", "Hello");
      armStatus("has_match_none");
      armPost(YES_PATH, () => matchAnswer201(0));
      before = calls().length;
      const sent = await call(home, SHOW, { thing_id: 42, message: "Hello" });
      expect(sent.isError, sent.text).toBe(false);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(bodyText(calls().slice(before)[1] as CallLog)).toBe('{"message":"Hello"}');
      expect(sent.result).toMatchObject({ outcome: "sent", connection: 0, go_ahead_id: approvedId });
      expect(sent.text).toContain("sent: interest shown");
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        source: "mcp",
        outcome: "sent",
        go_ahead: approvedId,
        http_status: 201,
        connection: 0,
      });
      expect((await readJournal(paths(home).journal)).filter((event) => event.id === approvedId).at(-1)?.event).toBe(
        "consumed",
      );
    });
  });

  it("interest show without a text and interest skip send with no go-ahead and no proposal: the lines have go_ahead null; the skip ignores a message key and sends {}", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      armStatus("has_match_none");
      armPost(YES_PATH, () => matchAnswer201(1));
      let before = calls().length;
      const show = await call(home, SHOW, { thing_id: 42 });
      expect(show.isError, show.text).toBe(false);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(bodyText(calls().slice(before)[1] as CallLog)).toBe('{"message":""}');
      expect(show.result).toMatchObject({ outcome: "sent", connection: 1 });
      expect(show.result["go_ahead_id"]).toBeUndefined();
      expect(show.text).toContain("sent: interest shown; mutual connection");

      armStatus("has_match_none");
      armPost(NO_PATH, () => matchAnswer201(0));
      before = calls().length;
      let skip: Outcome | undefined;
      try {
        skip = await call(home, SKIP, { thing_id: 42, message: "x" });
      } catch {
        // The SDK may reject the unknown key outright; then the plain call must send.
      }
      if (skip === undefined || skip.isError) {
        skip = await call(home, SKIP, { thing_id: 42 });
      }
      expect(skip.isError, skip.text).toBe(false);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${NO_PATH}`]);
      expect(bodyText(calls().slice(before)[1] as CallLog)).toBe("{}");
      expect(skip.result).toMatchObject({ outcome: "sent" });
      expect("connection" in skip.result).toBe(false);
      expect(skip.text).toContain("sent: person skipped");
      expect((await readSendLog(paths(home).sendLog)).map((line) => [line.kind, line.go_ahead, line.message])).toEqual([
        ["interest.show", null, null],
        ["interest.skip", null, null],
      ]);
      await expect(stat(paths(home).journal)).rejects.toThrow();
    });
  });

  it("dry_run on each twin: the status GET for the two interest writes and nothing for chat, no POST, the plan's request equal to the real one with a registered secret redacted, outcome dry-run, a flagged line; with a text and no go-ahead, go-ahead-missing without an id and no proposal", async () => {
    await withTempHome(async (home) => {
      const sessionToken = await seed(home, true);
      armStatus("has_match_none");
      let before = calls().length;
      const show = await call(home, SHOW, { thing_id: 42, dry_run: true });
      expect(show.isError, show.text).toBe(false);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(show.result).toMatchObject({ outcome: "dry-run" });
      expect(planOf(show.result).request).toEqual({ method: "POST", path: YES_REQUEST, body: { message: "" } });
      expect(show.text).toContain("dry run: nothing sent");

      armStatus("has_match_none");
      before = calls().length;
      const skip = await call(home, SKIP, { thing_id: 42, dry_run: true });
      expect(skip.result).toMatchObject({ outcome: "dry-run" });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(planOf(skip.result).request).toEqual({ method: "POST", path: NO_REQUEST, body: {} });

      const text = `my token is ${sessionToken}`;
      await approved(home, "chat.send", text);
      before = calls().length;
      const chat = await call(home, CHAT, { thing_id: 42, message: text, dry_run: true });
      expect(chat.isError, chat.text).toBe(false);
      expect(calls().slice(before)).toEqual([]);
      expect(chat.result).toMatchObject({ outcome: "dry-run" });
      expect(planOf(chat.result).request).toEqual({
        method: "POST",
        path: "chat/thing/42",
        body: { message: "my token is <REDACTED>", container_id: 1 },
      });
      expect(JSON.stringify(chat.result)).not.toContain(sessionToken);
      expect(chat.text).not.toContain(sessionToken);
      expect(chat.text).toContain("dry run: nothing sent");

      armStatus("has_match_none");
      before = calls().length;
      const noGoAhead = await call(home, SHOW, { thing_id: 42, message: "Hello", dry_run: true });
      expect(noGoAhead.result).toMatchObject({
        outcome: "refused",
        refusal: "go-ahead-missing",
        hint: "no recorded go-ahead for this text; a run that is not a dry run proposes one for the user to approve",
      });
      expect(noGoAhead.result["go_ahead_id"]).toBeUndefined();
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect((await readJournal(paths(home).journal)).map((event) => event.event)).toEqual(["proposed", "approved"]);

      expect((await readSendLog(paths(home).sendLog)).map((line) => [line.kind, line.dry_run, line.outcome])).toEqual([
        ["interest.show", true, "dry-run"],
        ["interest.skip", true, "dry-run"],
        ["chat.send", true, "dry-run"],
        ["interest.show", true, "refused"],
      ]);
    });
  });

  it("safe mode refuses each of the three before any request with the hint naming writes.enabled and the config path, a dry run still shows the plan, and a read tool still runs", async () => {
    await withTempHome(async (home) => {
      await seed(home, false);
      const before = calls().length;
      for (const [tool, args] of [
        [SHOW, { thing_id: 42, message: "Hello" }],
        [SKIP, { thing_id: 42 }],
        [CHAT, { thing_id: 42, message: "Hello" }],
      ] as const) {
        const outcome = await call(home, tool, { ...args });
        expect(outcome.isError, tool).toBe(false);
        expect(outcome.result, tool).toMatchObject({
          outcome: "refused",
          refusal: "safe-mode",
          hint: `set writes.enabled: true in ${home.configFile} to leave safe mode`,
        });
        expect(outcome.text, tool).toContain("refused: safe-mode");
      }
      expect(calls().slice(before)).toEqual([]);
      await expect(stat(paths(home).journal)).rejects.toThrow();

      armStatus("has_match_none");
      const dry = await call(home, SHOW, { thing_id: 42, dry_run: true });
      expect(dry.result).toMatchObject({ outcome: "refused", refusal: "safe-mode" });
      expect(planOf(dry.result).request).toEqual({ method: "POST", path: YES_REQUEST, body: { message: "" } });
      expect(planOf(dry.result).verdicts["writes_enabled"]).toBe(false);
      expect(dry.text).toContain(`request: POST ${YES_REQUEST}`);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);

      armStatus("has_match_yes");
      const read = await call(home, "gripeventsctl_match_status", { thing_id: 42 });
      expect(read.isError).toBe(false);
      expect(read.result).toEqual({ status: "has_match_yes" });
      expect((await readSendLog(paths(home).sendLog)).map((line) => line.refusal)).toEqual([
        "safe-mode",
        "safe-mode",
        "safe-mode",
        "safe-mode",
      ]);
    });
  });

  it("a 401 on the status GET is auth-failed with one request, no POST, no line and auth_failed_at recorded; a 401 on the POST is a failed line with http_status 401", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      gripPool(agent)
        .intercept({ path: STATUS_PATH, method: "GET" })
        .reply(() => unauthorized401());
      let before = calls().length;
      const onRead = await call(home, SHOW, { thing_id: 42 });
      expect(onRead.isError).toBe(true);
      expect(errorOf(onRead.result).kind).toBe("auth-failed");
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      await expect(stat(paths(home).sendLog)).rejects.toThrow();
      const loaded = await loadConfig({ env: home.env });
      expect(loaded.config.session?.auth_failed_at).toBeDefined();
      expect(await readFile(home.configFile, "utf8")).toContain("auth_failed_at");

      await seed(home, true);
      armStatus("has_match_none");
      gripPool(agent)
        .intercept({ path: YES_PATH, method: "POST" })
        .reply(() => unauthorized401());
      before = calls().length;
      const onPost = await call(home, SHOW, { thing_id: 42 });
      expect(onPost.isError).toBe(true);
      expect(errorOf(onPost.result).kind).toBe("auth-failed");
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(await readSendLog(paths(home).sendLog)).toEqual([
        expect.objectContaining({ outcome: "failed", http_status: 401, status_before: "has_match_none" }),
      ]);
    });
  });

  it("an echoed message holding U+202E or an escape renders escaped in the text block and raw in structuredContent", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const before = calls().length;
      const override = await call(home, SHOW, { thing_id: 42, message: "Hello‮world" });
      expect(override.isError).toBe(false);
      expect(override.result).toMatchObject({ outcome: "refused", refusal: "message-characters" });
      expect(planOf(override.result).request.body).toEqual({ message: "Hello‮world" });
      expect(override.text).not.toContain("‮");
      expect(override.text).toContain("\\u{202e}");
      expect(override.text).toContain("refused: message-characters");

      const escape = await call(home, CHAT, { thing_id: 42, message: "\x1b[2Jhi" });
      expect(escape.result).toMatchObject({ outcome: "refused", refusal: "message-characters" });
      expect(planOf(escape.result).request.body).toEqual({ message: "\x1b[2Jhi", container_id: 1 });
      expect(escape.text).not.toContain("\x1b");
      expect(calls().slice(before)).toEqual([]);
    });
  });

  it("a sent chat message over MCP with an approved record: one POST with the documented body, message_id in the result, the text block and the line", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const id = await approved(home, "chat.send", "synthetic message 1");
      armPost(CHAT_PATH, () => chatSend200(7));
      const before = calls().length;
      const outcome = await call(home, CHAT, { thing_id: 42, message: "synthetic message 1" });
      expect(outcome.isError, outcome.text).toBe(false);
      expect(summary(before)).toEqual([`POST ${CHAT_PATH}`]);
      expect(bodyText(calls().slice(before)[0] as CallLog)).toBe('{"message":"synthetic message 1","container_id":1}');
      expect(outcome.result).toMatchObject({ outcome: "sent", message_id: 7, go_ahead_id: id });
      expect("connection" in outcome.result).toBe(false);
      expect(outcome.text).toContain("sent: message 7");
      expect(outcome.sleeps).toEqual([]);
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        kind: "chat.send",
        source: "mcp",
        status_before: null,
        message_id: 7,
        http_status: 200,
        go_ahead: id,
      });
    });
  });
});
