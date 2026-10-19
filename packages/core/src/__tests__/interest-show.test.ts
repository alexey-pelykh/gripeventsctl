// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-WRITES: `interest show` at the operation level (issue #17 § `interest show`): `run` through a real
 * `GripClient` over `mockGrip()` and the real write gate in a temporary home, with the answers built from
 * `docs/api/interest.md` § Check the state first and § Response. The status read precedes the POST and is the
 * `user_id/match/<thing id>/status` form; the POST is `match_manual/yes/to_thing/<thing id>` with the body exactly
 * `{"message":"<text>"}`, `{"message":""}` without a text, as `application/json` and with no query; `connection` is
 * reported; a non-none status refuses before the POST, the `statusHint` sentence appended only where a text was
 * given; the message policy refuses before any request, on a dry run too; the `requests` field names headings that
 * exist on the page; the answer is a constant `yes` and the module never names `superyes` or the plain `match`
 * segment; the human form is the plan then the outcome line; and `exitCode` maps a refusal to 4.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type MatchStatus,
  type TempHome,
  gripPool,
  matchAnswer201,
  matchStatus200,
  mockGrip,
  readSendLog,
  repositoryRoot,
  sha256Of,
  success200,
  swipeCapAnswer,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { OPERATIONS, SwipeCapError, type WriteResult } from "../index.js";
import {
  ALLOWED_STATUS,
  MATCH_MANUAL_SEGMENT,
  matchAnswerPath,
  matchAnswerSchema,
} from "../operations/interest/answer.js";
import { MESSAGE_MAX_CODE_POINTS } from "../operations/interest/message-policy.js";
import {
  DRY_RUN_HELP,
  MESSAGE_HELP,
  SHOW_ANSWER,
  SHOW_STATUS_HINT,
  interestSentLine,
  interestShow,
  interestShowInput,
  interestShowOutput,
  writeExitCode,
} from "../operations/interest/show.js";
import { THING_ID_HELP, unknownStatusWarning } from "../operations/match/status.js";
import { DRY_RUN_LINE, renderWriteResult, writePlanLines } from "../operations/write-result.js";
import {
  bodyText,
  confirming,
  lastLine,
  lowerHeaders,
  seedWriteConfig,
  writeContextIn,
} from "./fixtures/write-context.js";

const agent = mockGrip();

const STATUS_PATH = "/1/container/1/thing/user_id/match/42/status";
const YES_PATH = "/1/container/1/thing/user_id/match_manual/yes/to_thing/42";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function summary(since: number): string[] {
  return calls()
    .slice(since)
    .map((call) => `${call.method} ${call.path}`);
}

function armStatus(status: MatchStatus): void {
  gripPool(agent)
    .intercept({ path: STATUS_PATH, method: "GET" })
    .reply(() => matchStatus200(status));
}

function armAnswer(connection: 0 | 1 = 0): void {
  gripPool(agent)
    .intercept({ path: YES_PATH, method: "POST" })
    .reply(() => matchAnswer201(connection));
}

async function withWrites<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await seedWriteConfig(home, true);
    return fn(home);
  });
}

const human = (result: WriteResult): string =>
  renderWriteResult(interestShowOutput.parse(result), (output) => interestSentLine(output.connection));

describe("[CAP-WRITES] interest show: the status read first, then POST match_manual/yes with the one documented body, the answer reported", () => {
  it("is the eleventh registry entry, after schedule info and before interest skip: a write with a session, thing_id positional, message and dry_run as flags, two documented requests whose headings exist on the page, and the human form of the plan", async () => {
    expect(OPERATIONS[10]).toBe(interestShow);
    expect(OPERATIONS[9]?.group).toBe("schedule");
    expect(OPERATIONS[11]?.verb).toBe("skip");
    expect(interestShow.group).toBe("interest");
    expect(interestShow.verb).toBe("show");
    expect(interestShow.kind).toBe("write");
    expect(interestShow.needsSession).toBe(true);
    expect(interestShow.description).toBe(
      "Show interest in a person, with an optional intro message of at most 250 characters; this notifies them",
    );
    expect(Object.keys(interestShow.input.shape)).toEqual(["thing_id", "message", "dry_run"]);
    expect(interestShow.input.shape.thing_id.description).toBe(THING_ID_HELP);
    expect(interestShow.input.shape.message.description).toBe(MESSAGE_HELP);
    expect(interestShow.input.shape.dry_run.description).toBe(DRY_RUN_HELP);
    expect(interestShow.cli).toEqual({ positional: ["thing_id"] });
    expect(interestShow.mcp).toBeUndefined();
    expect(interestShow.render?.human).toBeTypeOf("function");
    expect(interestShow.exitCode).toBe(writeExitCode);
    expect(interestShow.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "container/<id>/thing/user_id/match/<thing id>/status",
        page: "interest.md",
        section: "Check the state first",
      },
      {
        method: "POST",
        pathTemplate: "container/<id>/thing/user_id/match_manual/yes/to_thing/<thing id>",
        page: "interest.md",
        section: "Send an answer",
      },
    ]);
    for (const request of interestShow.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    // The output schema is the gate's result with `connection`; the input accepts the documented shapes only.
    expect(Object.keys(interestShowOutput.shape)).toContain("connection");
    expect(interestShowInput.parse({ thing_id: 42 })).toEqual({ thing_id: 42, dry_run: false });
    expect(interestShowInput.parse({ thing_id: 42, message: "a".repeat(300), dry_run: true })).toEqual({
      thing_id: 42,
      message: "a".repeat(300),
      dry_run: true,
    });
    for (const value of [0, -1, 1.5, "42", undefined]) {
      expect(interestShowInput.safeParse({ thing_id: value }).success, String(value)).toBe(false);
    }
  });

  it("builds the answer path from the container id, the user_id literal, match_manual/yes and the thing id, and never names superyes or the plain match segment", async () => {
    expect(SHOW_ANSWER).toBe("yes");
    expect(MATCH_MANUAL_SEGMENT).toBe("match_manual");
    expect(ALLOWED_STATUS).toBe("has_match_none");
    expect(matchAnswerPath(1, "yes", 42)).toBe("container/1/thing/user_id/match_manual/yes/to_thing/42");
    expect(matchAnswerPath(7, "no", 3)).toBe("container/7/thing/user_id/match_manual/no/to_thing/3");
    expect(matchAnswerPath(1, "yes", 42)).not.toContain("?");
    expect(matchAnswerSchema.parse({ message: "action recorded", connection: 1, extra: true })).toStrictEqual({
      message: "action recorded",
      connection: 1,
    });
    expect(matchAnswerSchema.safeParse({ message: "action recorded" }).success).toBe(false);
    const root = join(repositoryRoot(), "packages", "core", "src", "operations");
    for (const file of ["interest/show.ts", "interest/skip.ts", "interest/answer.ts"]) {
      const source = await readFile(join(root, file), "utf8");
      expect(source, file).not.toMatch(/["'/]superyes["'/]/);
      expect(source, file).not.toMatch(/\/match\/(?:yes|no)\b/);
    }
  });

  it('with has_match_none and a text: the status GET then the POST with exactly {"message":"<text>"} as application/json and no query; connection 0 is interest shown; one sent line with terminal-confirmation', async () => {
    await withWrites(async (home) => {
      const confirm = confirming();
      const built = await writeContextIn(home, agent, { confirm });
      armStatus("has_match_none");
      armAnswer(0);
      const before = calls().length;
      const result = await interestShow.run(built.ctx, { thing_id: 42, message: "Hello", dry_run: false });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(confirm.prompts.count, "one confirmation, after the status read").toBe(1);
      const post = calls().slice(before)[1];
      expect(post).toBeDefined();
      expect(bodyText(post as CallLog)).toBe('{"message":"Hello"}');
      expect(lowerHeaders((post as CallLog).headers)["content-type"]).toBe("application/json");
      expect(String((post as CallLog).fullUrl)).toBe(`${MOCK_API_ORIGIN}${YES_PATH}`);
      expect(result).toMatchObject({
        outcome: "sent",
        connection: 0,
        go_ahead_id: "terminal-confirmation",
        plan: {
          kind: "interest.show",
          container_id: 1,
          target_thing_id: 42,
          status_before: "has_match_none",
          request: {
            method: "POST",
            path: "container/1/thing/user_id/match_manual/yes/to_thing/42",
            body: { message: "Hello" },
          },
          verdicts: { writes_enabled: true, repeat_guard: "clear", status: "allowed", go_ahead: "recorded" },
        },
      });
      expect(interestShowOutput.safeParse(result).success).toBe(true);
      expect(writeExitCode(result)).toBe(0);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({
          kind: "interest.show",
          source: "cli",
          container_id: 1,
          target_thing_id: 42,
          status_before: "has_match_none",
          message: "Hello",
          message_sha256: sha256Of("Hello"),
          go_ahead: "terminal-confirmation",
          dry_run: false,
          outcome: "sent",
          refusal: null,
          http_status: 201,
          response: null,
          connection: 0,
          message_id: null,
        }),
      ]);
      expect(lastLine(human(result))).toBe("sent: interest shown");
    });
  });

  it('without a text: no confirmation, the body is exactly {"message":""} and never {}, the line has message, message_sha256 and go_ahead null; connection 1 is a mutual connection in the result, the line and the human form', async () => {
    await withWrites(async (home) => {
      const confirm = confirming();
      const built = await writeContextIn(home, agent, { confirm });
      armStatus("has_match_none");
      armAnswer(1);
      const before = calls().length;
      const result = await interestShow.run(built.ctx, { thing_id: 42, dry_run: false });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(confirm.prompts.count).toBe(0);
      expect(bodyText(calls().slice(before)[1] as CallLog)).toBe('{"message":""}');
      expect(result).toMatchObject({ outcome: "sent", connection: 1 });
      expect(result.go_ahead_id).toBeUndefined();
      expect(result.plan.verdicts.go_ahead).toBe("not-needed");
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({
          message: null,
          message_sha256: null,
          go_ahead: null,
          outcome: "sent",
          connection: 1,
        }),
      ]);
      const text = human(result);
      expect(text.split("\n")).toEqual([
        "kind: interest.show",
        "target thing id: 42",
        "status before: has_match_none",
        "request: POST container/1/thing/user_id/match_manual/yes/to_thing/42",
        'body: {"message":""}',
        "writes enabled: true",
        "repeat guard: clear",
        "status: allowed",
        "go-ahead: not-needed",
        "sent: interest shown; mutual connection",
      ]);
      expect(interestSentLine(0)).toBe("interest shown");
      expect(interestSentLine(null)).toBe("interest shown");
      expect(interestSentLine(undefined)).toBe("interest shown");
    });
  });

  it("refuses has_match_yes, has_match_no, has_connection and an unlisted value as status-not-none after the status GET only; the statusHint sentence is appended only where a text was given; exit 4", async () => {
    await withWrites(async (home) => {
      const start = calls().length;
      const statuses: MatchStatus[] = ["has_match_yes", "has_match_no", "has_connection"];
      for (const status of statuses) {
        const confirm = confirming();
        const built = await writeContextIn(home, agent, { confirm });
        armStatus(status);
        const before = calls().length;
        const withText = await interestShow.run(built.ctx, { thing_id: 42, message: "Hello", dry_run: false });
        expect(summary(before), status).toEqual([`GET ${STATUS_PATH}`]);
        expect(confirm.prompts.count).toBe(0);
        expect(withText).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
        expect(withText.plan.status_before).toBe(status);
        expect(withText.hint).toBe(
          `the status is ${status}; this tool posts only to has_match_none, so an answer you set in the app stays as you set it; ${SHOW_STATUS_HINT}`,
        );
        expect(writeExitCode(withText)).toBe(4);
        expect(lastLine(human(withText))).toBe(`hint: ${withText.hint ?? ""}`);
        expect(human(withText)).toContain("refused: status-not-none");

        armStatus(status);
        const noText = await interestShow.run(built.ctx, { thing_id: 42, dry_run: false });
        expect(noText).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
        expect(noText.hint).toBe(
          `the status is ${status}; this tool posts only to has_match_none, so an answer you set in the app stays as you set it`,
        );
        expect(noText.hint).not.toContain(SHOW_STATUS_HINT);
      }
      expect(SHOW_STATUS_HINT).toBe(
        "the app edits an intro message by sending yes again with the new text; this tool does not",
      );
      // A fifth value is not an enum error: #12's schema passes it, the gate refuses it, and the warning is written.
      const built = await writeContextIn(home, agent);
      gripPool(agent)
        .intercept({ path: STATUS_PATH, method: "GET" })
        .reply(() => success200({ status: "has_match_maybe" }));
      const unlisted = await interestShow.run(built.ctx, { thing_id: 42, dry_run: false });
      expect(unlisted).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
      expect(unlisted.plan.status_before).toBe("has_match_maybe");
      expect(built.stderr()).toContain(unknownStatusWarning("has_match_maybe"));
      const log = await readSendLog(built.paths.sendLog);
      expect(log).toHaveLength(7);
      for (const line of log) expect(line).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
      expect(
        calls()
          .slice(start)
          .filter((call) => call.method === "POST"),
      ).toEqual([]);
    });
  });

  it("the message policy refuses before any request, on a dry run too: 251 code points is message-too-long naming 251, a control character is message-characters, 250 and 125 two-unit emoji are accepted", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent, { confirm: confirming() });
      const before = calls().length;
      const long = await interestShow.run(built.ctx, { thing_id: 42, message: "a".repeat(251), dry_run: false });
      expect(long).toMatchObject({
        outcome: "refused",
        refusal: "message-too-long",
        hint: "the message is 251 characters; the app allows at most 250, and what the server does with more is not verified",
      });
      expect(long.plan.status_before).toBeNull();
      expect(long.plan.verdicts.status).toBe("not-read");
      expect(writeExitCode(long)).toBe(4);
      const dry = await interestShow.run(built.ctx, { thing_id: 42, message: "a".repeat(251), dry_run: true });
      expect(dry).toMatchObject({ outcome: "refused", refusal: "message-too-long" });
      const hostile = await interestShow.run(built.ctx, { thing_id: 42, message: "Hello‮world", dry_run: false });
      expect(hostile).toMatchObject({
        outcome: "refused",
        refusal: "message-characters",
        hint: "the message holds a control or direction-override character at position 5 (U+202E); remove it and run again",
      });
      expect(hostile.plan.request.body).toEqual({ message: "Hello‮world" });
      expect(calls().slice(before), "no status read and no POST").toEqual([]);
      const log = await readSendLog(built.paths.sendLog);
      expect(
        log.map((line) => [line.refusal, line.status_before, line.go_ahead, line.dry_run, line.http_status]),
      ).toEqual([
        ["message-too-long", null, null, false, null],
        ["message-too-long", null, null, true, null],
        ["message-characters", null, null, false, null],
      ]);
      expect(log[2]?.message_sha256).toBe(sha256Of("Hello‮world"));

      const emoji = "😀".repeat(125);
      expect(emoji.length).toBe(250);
      for (const text of ["b".repeat(MESSAGE_MAX_CODE_POINTS), `${emoji}${"c".repeat(125)}`, "שלום 😀\nمرحبا"]) {
        armStatus("has_match_none");
        armAnswer(0);
        const start = calls().length;
        const sent = await interestShow.run(built.ctx, { thing_id: 42, message: text, dry_run: false });
        expect(sent.outcome, text.slice(0, 8)).toBe("sent");
        expect(JSON.parse(bodyText(calls().slice(start)[1] as CallLog))).toEqual({ message: text });
        // The gate reads the send log as it stands: emptied, the repeat guard lets the next send to 42 through.
        await writeFile(built.paths.sendLog, "", { mode: 0o600 });
      }
    });
  });

  it("a dry run with writes enabled reads the status, sends nothing, reports the plan with the request the real run sends, and leaves a flagged line", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent, { confirm: confirming() });
      armStatus("has_match_none");
      const before = calls().length;
      const dry = await interestShow.run(built.ctx, { thing_id: 42, dry_run: true });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(dry).toMatchObject({
        outcome: "dry-run",
        plan: {
          request: {
            method: "POST",
            path: "container/1/thing/user_id/match_manual/yes/to_thing/42",
            body: { message: "" },
          },
          status_before: "has_match_none",
        },
      });
      expect(writeExitCode(dry)).toBe(0);
      expect(lastLine(human(dry))).toBe(DRY_RUN_LINE);
      expect(writePlanLines(dry.plan)[3]).toBe("request: POST container/1/thing/user_id/match_manual/yes/to_thing/42");
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({ dry_run: true, outcome: "dry-run", refusal: null }),
      ]);
    });
  });

  it("the swipe-cap body stops the write after exactly one POST: the line is failed with the reason, the swipe-cap error propagates with its hint, and nothing waits", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent);
      armStatus("has_match_none");
      gripPool(agent)
        .intercept({ path: YES_PATH, method: "POST" })
        .reply(() => swipeCapAnswer());
      const before = calls().length;
      await expect(interestShow.run(built.ctx, { thing_id: 42, dry_run: false })).rejects.toBeInstanceOf(SwipeCapError);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(built.clock.sleeps).toEqual([]);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({
          outcome: "failed",
          refusal: null,
          response: "limit of swipes reached for action",
          status_before: "has_match_none",
        }),
      ]);
    });
  });
});
