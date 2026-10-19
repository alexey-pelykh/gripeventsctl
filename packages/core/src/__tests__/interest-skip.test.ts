// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-WRITES: `interest skip` at the operation level (issue #17 § `interest skip`): `run` through a real
 * `GripClient` over `mockGrip()` and the real write gate in a temporary home. The status read precedes the POST;
 * the POST is `match_manual/no/to_thing/<thing id>` with the body exactly `{}`, never a text; no message input
 * exists and an unknown `message` key is dropped by the schema; the result carries no `connection` key; the line
 * has `kind: interest.skip` and `message: null`; a non-none status refuses before the POST; a dry run reads the
 * status and sends nothing; the `requests` field names headings that exist on the page; the human form ends
 * `sent: person skipped`. The `no` POST is from the app code and not verified live (`docs/api/interest.md` § Send an
 * answer); the shape here is the page's.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type MatchStatus,
  type TempHome,
  gripPool,
  matchAnswer201,
  matchStatus200,
  mockGrip,
  readSendLog,
  repositoryRoot,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { OPERATIONS, type WriteResult, writeResultSchema } from "../index.js";
import { DRY_RUN_HELP, writeExitCode } from "../operations/interest/show.js";
import {
  SKIP_ANSWER,
  SKIP_SENT_LINE,
  interestSkip,
  interestSkipInput,
  interestSkipOutput,
} from "../operations/interest/skip.js";
import { THING_ID_HELP } from "../operations/match/status.js";
import { DRY_RUN_LINE, renderWriteResult } from "../operations/write-result.js";
import { bodyText, confirming, lastLine, seedWriteConfig, writeContextIn } from "./fixtures/write-context.js";

const agent = mockGrip();

const STATUS_PATH = "/1/container/1/thing/user_id/match/42/status";
const NO_PATH = "/1/container/1/thing/user_id/match_manual/no/to_thing/42";

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

async function withWrites<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await seedWriteConfig(home, true);
    return fn(home);
  });
}

const human = (result: WriteResult): string =>
  renderWriteResult(interestSkipOutput.parse(result), () => SKIP_SENT_LINE);

describe("[CAP-WRITES] interest skip: the status read first, then POST match_manual/no with the body {}, never a text", () => {
  it("is the twelfth registry entry, after interest show and before writes status: a write with a session, thing_id positional, dry_run only, no message input, two documented requests whose headings exist on the page", async () => {
    expect(OPERATIONS[11]).toBe(interestSkip);
    expect(OPERATIONS[10]?.verb).toBe("show");
    expect(OPERATIONS[12]?.group).toBe("writes");
    expect(interestSkip.group).toBe("interest");
    expect(interestSkip.verb).toBe("skip");
    expect(interestSkip.kind).toBe("write");
    expect(interestSkip.needsSession).toBe(true);
    expect(interestSkip.description).toBe("Skip a person: record a no answer about them");
    expect(Object.keys(interestSkip.input.shape)).toEqual(["thing_id", "dry_run"]);
    expect(interestSkip.input.shape.thing_id.description).toBe(THING_ID_HELP);
    expect(interestSkip.input.shape.dry_run.description).toBe(DRY_RUN_HELP);
    expect(interestSkip.cli).toEqual({ positional: ["thing_id"] });
    expect(interestSkip.mcp).toBeUndefined();
    expect(interestSkip.exitCode).toBe(writeExitCode);
    expect(interestSkip.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "container/<id>/thing/user_id/match/<thing id>/status",
        page: "interest.md",
        section: "Check the state first",
      },
      {
        method: "POST",
        pathTemplate: "container/<id>/thing/user_id/match_manual/no/to_thing/<thing id>",
        page: "interest.md",
        section: "Send an answer",
      },
    ]);
    for (const request of interestSkip.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    expect(SKIP_ANSWER).toBe("no");
    // The output is the gate's result as it is: no `connection` field is added.
    expect(interestSkipOutput).toBe(writeResultSchema);
    // An unknown `message` key is dropped by zod's default object mode: no text can reach the body.
    expect(interestSkipInput.parse({ thing_id: 42, message: "x" })).toStrictEqual({ thing_id: 42, dry_run: false });
    for (const value of [0, -1, 1.5, "42", undefined]) {
      expect(interestSkipInput.safeParse({ thing_id: value }).success, String(value)).toBe(false);
    }
  });

  it("with has_match_none: the status GET then POST match_manual/no with exactly {}, the result without a connection key, the line with kind interest.skip and message null, the human form ending sent: person skipped", async () => {
    await withWrites(async (home) => {
      const confirm = confirming();
      const built = await writeContextIn(home, agent, { confirm });
      armStatus("has_match_none");
      gripPool(agent)
        .intercept({ path: NO_PATH, method: "POST" })
        .reply(() => matchAnswer201(0));
      const before = calls().length;
      const result = await interestSkip.run(built.ctx, { thing_id: 42, dry_run: false });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`, `POST ${NO_PATH}`]);
      expect(confirm.prompts.count).toBe(0);
      expect(bodyText(calls().slice(before)[1] as CallLog)).toBe("{}");
      expect(result.outcome).toBe("sent");
      expect("connection" in result).toBe(false);
      expect("message_id" in result).toBe(false);
      expect(result.plan).toMatchObject({
        kind: "interest.skip",
        container_id: 1,
        target_thing_id: 42,
        status_before: "has_match_none",
        request: { method: "POST", path: "container/1/thing/user_id/match_manual/no/to_thing/42", body: {} },
        verdicts: { writes_enabled: true, repeat_guard: "clear", status: "allowed", go_ahead: "not-needed" },
      });
      expect(interestSkipOutput.safeParse(result).success).toBe(true);
      expect(writeExitCode(result)).toBe(0);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({
          kind: "interest.skip",
          source: "cli",
          target_thing_id: 42,
          status_before: "has_match_none",
          message: null,
          message_sha256: null,
          go_ahead: null,
          dry_run: false,
          outcome: "sent",
          http_status: 201,
          response: null,
          connection: null,
          message_id: null,
        }),
      ]);
      expect(lastLine(human(result))).toBe("sent: person skipped");
      expect(human(result)).toContain("body: {}");
    });
  });

  it("refuses has_match_yes, has_match_no and has_connection as status-not-none after the status GET only, with the hint naming the value and no statusHint sentence; exit 4", async () => {
    await withWrites(async (home) => {
      const start = calls().length;
      const statuses: MatchStatus[] = ["has_match_yes", "has_match_no", "has_connection"];
      for (const status of statuses) {
        const built = await writeContextIn(home, agent);
        armStatus(status);
        const before = calls().length;
        const result = await interestSkip.run(built.ctx, { thing_id: 42, dry_run: false });
        expect(summary(before), status).toEqual([`GET ${STATUS_PATH}`]);
        expect(result).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
        expect(result.plan.status_before).toBe(status);
        expect(result.hint).toBe(
          `the status is ${status}; this tool posts only to has_match_none, so an answer you set in the app stays as you set it`,
        );
        expect(writeExitCode(result)).toBe(4);
        expect(human(result)).toContain("refused: status-not-none");
      }
      expect(
        calls()
          .slice(start)
          .filter((call) => call.method === "POST"),
      ).toEqual([]);
    });
  });

  it("a dry run reads the status, sends nothing, reports the plan with the request the real run sends, and leaves a flagged line", async () => {
    await withWrites(async (home) => {
      const built = await writeContextIn(home, agent);
      armStatus("has_match_none");
      const before = calls().length;
      const dry = await interestSkip.run(built.ctx, { thing_id: 42, dry_run: true });
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(dry).toMatchObject({
        outcome: "dry-run",
        plan: {
          request: { method: "POST", path: "container/1/thing/user_id/match_manual/no/to_thing/42", body: {} },
          status_before: "has_match_none",
        },
      });
      expect(writeExitCode(dry)).toBe(0);
      expect(lastLine(human(dry))).toBe(DRY_RUN_LINE);
      expect(await readSendLog(built.paths.sendLog)).toEqual([
        expect.objectContaining({ kind: "interest.skip", dry_run: true, outcome: "dry-run", message: null }),
      ]);
    });
  });
});
