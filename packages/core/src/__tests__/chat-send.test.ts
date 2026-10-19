// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-WRITES: `chat send` at the operation level (issue #17 § `chat send`): `run` through a real `GripClient` over
 * `mockGrip()` and the real write gate in a temporary home, with the answer built from `docs/api/chat-and-meetings.md`
 * § Send a chat message. One POST `chat/thing/<thing id>` with the body exactly
 * `{"message":"<text>","container_id":<id>}` and no status read; `message_id` is reported and the result carries no
 * `connection` key; an empty text fails the schema; the message policy refuses before any request; a failed POST
 * (a synthetic 404) is logged as `failed` with the reason and the transport's error propagates; a second send to the
 * same person is the repeat guard; a dry run with a recorded go-ahead sends nothing; the `requests` field names a
 * heading that exists on the page; the human form ends `sent: message <id>`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type TempHome,
  apiFailure,
  appendJsonLine,
  chatSend200,
  eventFields,
  gripPool,
  journalEvent,
  mockGrip,
  readJournal,
  readSendLog,
  repositoryRoot,
  sha256Of,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { ApiError, OPERATIONS, type WriteResult } from "../index.js";
import {
  CHAT_MESSAGE_HELP,
  chatSend,
  chatSendAnswerSchema,
  chatSendInput,
  chatSendOutput,
  chatSentLine,
} from "../operations/chat/send.js";
import { THREAD_THING_ID_HELP } from "../operations/chat/thread.js";
import { DRY_RUN_HELP, writeExitCode } from "../operations/interest/show.js";
import { DRY_RUN_LINE, renderWriteResult } from "../operations/write-result.js";
import {
  T0,
  bodyText,
  confirming,
  lastLine,
  lowerHeaders,
  seedWriteConfig,
  writeContextIn,
} from "./fixtures/write-context.js";

const agent = mockGrip();

const CHAT_PATH = "/1/chat/thing/42";
const TEXT = "See you at the booth";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function summary(since: number): string[] {
  return calls()
    .slice(since)
    .map((call) => `${call.method} ${call.path}`);
}

async function withWrites<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await seedWriteConfig(home, true);
    return fn(home);
  });
}

const human = (result: WriteResult): string =>
  renderWriteResult(chatSendOutput.parse(result), (output) => chatSentLine(output.message_id));

describe("[CAP-WRITES] chat send: one POST of chat/thing/<thing id> with the message and the container id, no status read, the message id reported", () => {
  it("is the ninth registry entry, after chat thread and before schedule info: a write with a session, thing_id and message positional, an empty message refused by the schema, one documented request whose heading exists on the page", async () => {
    expect(OPERATIONS[8]).toBe(chatSend);
    expect(OPERATIONS[7]?.verb).toBe("thread");
    expect(OPERATIONS[9]?.group).toBe("schedule");
    expect(chatSend.group).toBe("chat");
    expect(chatSend.verb).toBe("send");
    expect(chatSend.kind).toBe("write");
    expect(chatSend.needsSession).toBe(true);
    expect(chatSend.description).toBe("Send a chat message to a person you are connected with; this reaches them");
    expect(Object.keys(chatSend.input.shape)).toEqual(["thing_id", "message", "dry_run"]);
    expect(chatSend.input.shape.thing_id.description).toBe(THREAD_THING_ID_HELP);
    expect(chatSend.input.shape.message.description).toBe(CHAT_MESSAGE_HELP);
    expect(chatSend.input.shape.dry_run.description).toBe(DRY_RUN_HELP);
    expect(chatSend.cli).toEqual({ positional: ["thing_id", "message"] });
    expect(chatSend.mcp).toBeUndefined();
    expect(chatSend.exitCode).toBe(writeExitCode);
    expect(chatSend.requests).toEqual([
      {
        method: "POST",
        pathTemplate: "chat/thing/<thing id>",
        page: "chat-and-meetings.md",
        section: "Send a chat message",
      },
    ]);
    for (const request of chatSend.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    expect(Object.keys(chatSendOutput.shape)).toContain("message_id");
    expect(chatSendInput.parse({ thing_id: 42, message: "Hi" })).toEqual({
      thing_id: 42,
      message: "Hi",
      dry_run: false,
    });
    expect(chatSendInput.safeParse({ thing_id: 42, message: "" }).success).toBe(false);
    expect(chatSendInput.safeParse({ thing_id: 42 }).success).toBe(false);
    expect(chatSendInput.safeParse({ thing_id: "42", message: "Hi" }).success).toBe(false);
    expect(chatSendAnswerSchema.parse({ message_id: 7, extra: 1 })).toStrictEqual({ message_id: 7 });
    expect(chatSendAnswerSchema.safeParse({}).success).toBe(false);
    expect(chatSentLine(7)).toBe("message 7");
  });

  it('sends exactly one POST with {"message":"<text>","container_id":1} as application/json, no status GET; message_id 7 is in the result, the line and the human form; no connection key', async () => {
    await withWrites(async (home) => {
      const confirm = confirming();
      const built = await writeContextIn(home, agent, { confirm });
      gripPool(agent)
        .intercept({ path: CHAT_PATH, method: "POST" })
        .reply(() => chatSend200(7));
      const before = calls().length;
      const result = await chatSend.run(built.ctx, { thing_id: 42, message: TEXT, dry_run: false });
      expect(summary(before)).toEqual([`POST ${CHAT_PATH}`]);
      expect(confirm.prompts.count).toBe(1);
      const post = calls().slice(before)[0] as CallLog;
      expect(bodyText(post)).toBe(`{"message":"${TEXT}","container_id":1}`);
      expect(lowerHeaders(post.headers)["content-type"]).toBe("application/json");
      expect(String(post.fullUrl)).not.toContain("?");
      expect(result).toMatchObject({
        outcome: "sent",
        message_id: 7,
        go_ahead_id: "terminal-confirmation",
        plan: {
          kind: "chat.send",
          container_id: 1,
          target_thing_id: 42,
          status_before: null,
          request: { method: "POST", path: "chat/thing/42", body: { message: TEXT, container_id: 1 } },
          verdicts: { writes_enabled: true, repeat_guard: "clear", status: "not-read", go_ahead: "recorded" },
        },
      });
      expect("connection" in result).toBe(false);
      expect(chatSendOutput.safeParse(result).success).toBe(true);
      expect(writeExitCode(result)).toBe(0);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({
          kind: "chat.send",
          source: "cli",
          container_id: 1,
          target_thing_id: 42,
          status_before: null,
          message: TEXT,
          message_sha256: sha256Of(TEXT),
          go_ahead: "terminal-confirmation",
          dry_run: false,
          outcome: "sent",
          refusal: null,
          http_status: 200,
          response: null,
          connection: null,
          message_id: 7,
        }),
      ]);
      expect(human(result).split("\n")).toEqual([
        "kind: chat.send",
        "target thing id: 42",
        "status before: null",
        "request: POST chat/thing/42",
        `body: {"message":"${TEXT}","container_id":1}`,
        "writes enabled: true",
        "repeat guard: clear",
        "status: not-read",
        "go-ahead: recorded",
        "sent: message 7",
      ]);

      // A second send of the same kind to the same person: the repeat guard, before any request.
      const again = await chatSend.run(built.ctx, { thing_id: 42, message: "Another", dry_run: false });
      expect(again).toMatchObject({ outcome: "refused", refusal: "repeat-guard" });
      expect(again.hint).toContain("chat.send to thing 42 was sent on ");
      expect(again.hint).toContain("a conversation continues in the app");
      expect(again.hint).not.toContain("intro message");
      expect(summary(before)).toEqual([`POST ${CHAT_PATH}`]);
      expect(writeExitCode(again)).toBe(4);
    });
  });

  it("the message policy refuses before any request: 251 code points, a control character, an override; the plan still shows the request", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent, { confirm: confirming() });
      const before = calls().length;
      const long = await chatSend.run(built.ctx, { thing_id: 42, message: "a".repeat(251), dry_run: false });
      expect(long).toMatchObject({ outcome: "refused", refusal: "message-too-long" });
      const control = await chatSend.run(built.ctx, { thing_id: 42, message: "\x1b[2Jhi", dry_run: false });
      expect(control).toMatchObject({
        outcome: "refused",
        refusal: "message-characters",
        hint: "the message holds a control or direction-override character at position 0 (U+001B); remove it and run again",
      });
      const override = await chatSend.run(built.ctx, { thing_id: 42, message: "Hello‮world", dry_run: true });
      expect(override).toMatchObject({ outcome: "refused", refusal: "message-characters" });
      expect(override.plan.request).toEqual({
        method: "POST",
        path: "chat/thing/42",
        body: { message: "Hello‮world", container_id: 1 },
      });
      expect(calls().slice(before)).toEqual([]);
      expect(
        (await readSendLog(built.paths.sendLog)).map((line) => [
          line.kind,
          line.refusal,
          line.status_before,
          line.dry_run,
        ]),
      ).toEqual([
        ["chat.send", "message-too-long", null, false],
        ["chat.send", "message-characters", null, false],
        ["chat.send", "message-characters", null, true],
      ]);
    });
  });

  it("a POST the platform refuses (a synthetic 404 thread not found) creates no thread: the line is failed with the status and the reason, and the api error propagates", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent, { confirm: confirming() });
      gripPool(agent)
        .intercept({ path: CHAT_PATH, method: "POST" })
        .reply(() => apiFailure("thread not found", 404));
      const before = calls().length;
      await expect(chatSend.run(built.ctx, { thing_id: 42, message: "Hi", dry_run: false })).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(summary(before)).toEqual([`POST ${CHAT_PATH}`]);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({
          kind: "chat.send",
          outcome: "failed",
          refusal: null,
          http_status: 404,
          response: "thread not found",
          go_ahead: "terminal-confirmation",
        }),
      ]);
    });
  });

  it("a dry run with a recorded go-ahead sends nothing, reads no status, reports the plan with the request the real run sends, leaves a flagged line and keeps the go-ahead unconsumed", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent, { source: "mcp" });
      const proposed = journalEvent({
        kind: "chat.send",
        target_thing_id: 42,
        message: TEXT,
        time: new Date(T0 - 7_200_000).toISOString(),
      });
      await appendJsonLine(built.paths.goAheads, proposed);
      await appendJsonLine(built.paths.goAheads, {
        ...eventFields(proposed),
        event: "approved",
        time: new Date(T0 - 3_600_000).toISOString(),
        source: "cli",
      });
      const before = calls().length;
      const dry = await chatSend.run(built.ctx, { thing_id: 42, message: TEXT, dry_run: true });
      expect(calls().slice(before)).toEqual([]);
      expect(dry).toMatchObject({
        outcome: "dry-run",
        plan: {
          request: { method: "POST", path: "chat/thing/42", body: { message: TEXT, container_id: 1 } },
          status_before: null,
          verdicts: { status: "not-read", go_ahead: "recorded" },
        },
      });
      expect(writeExitCode(dry)).toBe(0);
      expect(lastLine(human(dry))).toBe(DRY_RUN_LINE);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({ kind: "chat.send", dry_run: true, outcome: "dry-run", go_ahead: proposed.id }),
      ]);
      expect((await readJournal(built.paths.goAheads)).map((event) => event.event)).toEqual(["proposed", "approved"]);
    });
  });
});
