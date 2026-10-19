// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-GATE and CAP-GOAHEAD, surface, the MCP path: the real server over the synthetic write operation (issue #16
 * § Acceptance Criteria) in a temporary home. A refused write is a normal result, never `isError`, with the outcome,
 * the refusal and the hint in `structuredContent`; no tool argument enables writes; the repeat guard refuses; a
 * missing go-ahead proposes one and the hint is the fixed sentence word for word; an approved record is consumed
 * before the POST (the journal's line count is read inside the mock's reply handler); the expired, the mismatched
 * and the used records never match; a failed POST is an error result naming the used go-ahead; and the two `writes`
 * reads list with the local-state posture while no `gripeventsctl_writes_go*` tool exists.
 */

import { readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";

import { writeResultSchema } from "@gripeventsctl/core";
import {
  type Clock,
  type McpLink,
  type TempHome,
  appendJsonLine,
  eventFields,
  fixtureSecrets,
  gripPool,
  journalEvent,
  linkMcp,
  mockGrip,
  readJournal,
  readSendLog,
  sha256Of,
  withTempHome,
} from "@gripeventsctl/testing";
import { beforeEach, describe, expect, it } from "vitest";

import {
  SYNTHETIC_WRITE_KIND,
  type SyntheticWriteOptions,
  syntheticWrite,
} from "../../../core/src/__tests__/fixtures/synthetic-write.js";
import { buildServer } from "../index.js";

const agent = mockGrip();
const JSON_HEADERS = { "content-type": "application/json" };
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MESSAGE = "synthetic message 1";
const TOOL = "gripeventsctl_synthetic_write";
const LOCAL_STATE_POSTURE = "It reads the tool's own local state and makes no platform call.";

class Sink extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function advancingClock(start = T0): Clock {
  let current = start;
  return {
    now: () => new Date(current),
    sleep: (ms) => {
      current += ms;
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

let mark = 0;

/** The POSTs recorded since the test began: the agent's history spans the file. */
function posts(): { method: string; path: string }[] {
  return (agent.getCallHistory()?.calls() ?? []).slice(mark).filter((call) => call.method === "POST");
}

beforeEach(() => {
  mark = agent.getCallHistory()?.calls().length ?? 0;
});

async function seed(home: TempHome, writesEnabled: boolean): Promise<void> {
  await writeFile(
    home.configFile,
    `version: 1\nsession:\n  slug: test-event-1\n  container_id: 1\n  token: ${fixtureSecrets().sessionToken}\n  signed_in_at: "2026-10-12T10:00:00.000Z"\nwrites:\n  enabled: ${String(writesEnabled)}\n`,
    { mode: 0o600 },
  );
}

const paths = (home: TempHome) => ({
  sendLog: join(home.dir, ".gripeventsctl.send-log.jsonl"),
  journal: join(home.dir, ".gripeventsctl.go-aheads.jsonl"),
});

async function withLink<T>(
  home: TempHome,
  options: SyntheticWriteOptions,
  fn: (link: McpLink) => Promise<T>,
): Promise<T> {
  const server = buildServer("0.0.0", {
    operations: [syntheticWrite(writeResultSchema, options)],
    env: home.env,
    clock: advancingClock(),
    dispatcher: agent,
    stderr: new Sink(),
  });
  const link = await linkMcp(server);
  try {
    return await fn(link);
  } finally {
    await link.close();
  }
}

interface Outcome {
  isError: boolean;
  result: Record<string, unknown>;
  text: string;
}

async function call(
  home: TempHome,
  args: Record<string, unknown>,
  options: SyntheticWriteOptions = {},
): Promise<Outcome> {
  return withLink(home, options, async (link) => {
    const outcome = await link.callTool(TOOL, args);
    return {
      isError: outcome.isError === true,
      result: (outcome.structuredContent as Record<string, unknown> | undefined) ?? {},
      text: outcome.content.map((block) => ("text" in block ? String(block.text) : "")).join("\n"),
    };
  });
}

const missingHint = (id: string): string =>
  `No recorded go-ahead for this text. Ask the user to run gripeventsctl writes go-ahead ${id} in a terminal of their own (not through the host's shell, which has no TTY), then call again with the same thing id and the same text.`;

/** A proposed and approved record for `message` to `thingId`, approved `ageMs` before T0; returns its id. */
async function approved(
  home: TempHome,
  thingId: number,
  message: string,
  ageMs = HOUR,
  overrides: Partial<{ kind: string; container_id: number }> = {},
): Promise<string> {
  const proposed = journalEvent({
    kind: SYNTHETIC_WRITE_KIND,
    target_thing_id: thingId,
    message,
    time: new Date(T0 - ageMs - 60_000).toISOString(),
    ...overrides,
  });
  await appendJsonLine(paths(home).journal, proposed);
  const fields = eventFields(proposed);
  await appendJsonLine(paths(home).journal, {
    ...fields,
    event: "approved",
    time: new Date(T0 - ageMs).toISOString(),
    source: "cli",
  });
  return proposed.id;
}

function armPost(thingId: number): void {
  gripPool(agent)
    .intercept({ path: `/1/synthetic/${String(thingId)}`, method: "POST" })
    .reply(201, JSON.stringify({ success: true, data: { message_id: 7 } }), { headers: JSON_HEADERS });
}

describe("[CAP-GATE] [CAP-GOAHEAD] the MCP path: a refused write is a normal result, a missing go-ahead is proposed, and the POST never leaves without the three preconditions", () => {
  it("S1: safe mode is a normal result with the outcome, the refusal and the hint, and no tool argument enables writes", async () => {
    await withTempHome(async (home) => {
      await seed(home, false);
      const statusReads = { count: 0 };
      const before = posts().length;
      const out = await call(home, { thing_id: 2, message: MESSAGE }, { statusReads });
      expect(out.isError).toBe(false);
      expect(out.result).toMatchObject({
        outcome: "refused",
        refusal: "safe-mode",
        hint: `set writes.enabled: true in ${home.configFile} to leave safe mode`,
      });
      expect(out.text).toContain("safe mode");
      expect(statusReads.count).toBe(0);
      const stripped = await call(
        home,
        { thing_id: 2, writes_enabled: true, safe_mode: false, dry_run: false },
        { statusReads },
      );
      expect(stripped.result).toMatchObject({ outcome: "refused", refusal: "safe-mode" });
      expect(posts().length - before).toBe(0);
      expect(await readSendLog(paths(home).sendLog)).toHaveLength(2);
      await expect(stat(paths(home).journal)).rejects.toThrow();
    });
  });

  it("S2: a missing go-ahead proposes one from mcp with the fixed hint; the same call keeps the id; another person or text gets another", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const statusReads = { count: 0 };
      const first = await call(home, { thing_id: 2, message: MESSAGE }, { statusReads });
      expect(first.isError).toBe(false);
      expect(first.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      const id = String(first.result["go_ahead_id"]);
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(first.result["hint"]).toBe(missingHint(id));
      expect(Date.parse(String(first.result["go_ahead_expires_at"]))).toBe(T0 + DAY);
      expect(statusReads.count).toBe(1);
      expect(await readJournal(paths(home).journal)).toEqual([
        expect.objectContaining({
          event: "proposed",
          id,
          kind: "synthetic.write",
          container_id: 1,
          target_thing_id: 2,
          message: MESSAGE,
          message_sha256: sha256Of(MESSAGE),
          source: "mcp",
        }),
      ]);
      const again = await call(home, { thing_id: 2, message: MESSAGE });
      expect(again.result["go_ahead_id"]).toBe(id);
      expect(await readJournal(paths(home).journal)).toHaveLength(1);
      const otherPerson = await call(home, { thing_id: 3, message: MESSAGE });
      const otherText = await call(home, { thing_id: 2, message: "synthetic message 2" });
      expect(new Set([id, otherPerson.result["go_ahead_id"], otherText.result["go_ahead_id"]]).size).toBe(3);
      expect(posts()).toEqual([]);
    });
  });

  it("S3: an approved record is consumed before the POST, the line records the send, a third call meets the repeat guard, and a changed text to another person proposes anew", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const id = await approved(home, 2, MESSAGE);
      let journalLinesAtPost = -1;
      gripPool(agent)
        .intercept({ path: "/1/synthetic/2", method: "POST" })
        .reply(
          201,
          () => {
            // The consume is on disk when the POST arrives: the proposed, the approved and the consumed line.
            journalLinesAtPost = readFileSync(paths(home).journal, "utf8").trim().split("\n").length;
            return JSON.stringify({ success: true, data: { message_id: 7 } });
          },
          { headers: JSON_HEADERS },
        );
      const sent = await call(home, { thing_id: 2, message: MESSAGE });
      expect(sent.isError).toBe(false);
      expect(sent.result).toMatchObject({ outcome: "sent", go_ahead_id: id, message_id: 7 });
      expect(posts()).toHaveLength(1);
      expect(journalLinesAtPost).toBe(3);
      expect(
        (await readJournal(paths(home).journal)).filter((line) => line.id === id).map((line) => line.event),
      ).toEqual(["proposed", "approved", "consumed"]);
      expect((await readJournal(paths(home).journal)).at(-1)).toMatchObject({ event: "consumed", source: "mcp" });
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        outcome: "sent",
        go_ahead: id,
        message_sha256: sha256Of(MESSAGE),
        http_status: 201,
        response: null,
        message_id: 7,
        source: "mcp",
      });
      const third = await call(home, { thing_id: 2, message: MESSAGE });
      expect(third.result).toMatchObject({ outcome: "refused", refusal: "repeat-guard" });
      const samePerson = await call(home, { thing_id: 2, message: "synthetic message 2" });
      expect(samePerson.result).toMatchObject({ outcome: "refused", refusal: "repeat-guard" });
      const changed = await call(home, { thing_id: 3, message: "synthetic message 2" });
      expect(changed.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      expect(changed.result["go_ahead_id"]).not.toBe(id);
      expect(posts()).toHaveLength(1);
    });
  });

  it("S4: an approval 24 hours and a second old is expired and proposes anew; 23 hours 59 minutes old is sent; another kind, container or person never matches", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const expiredId = await approved(home, 2, MESSAGE, DAY + 1000);
      const expired = await call(home, { thing_id: 2, message: MESSAGE });
      expect(expired.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-expired" });
      expect(String(expired.result["hint"])).toContain(
        `the go-ahead ${expiredId} expired at ${new Date(T0 - 1000).toISOString()}`,
      );
      expect(expired.result["go_ahead_id"]).not.toBe(expiredId);
      expect(
        (await readJournal(paths(home).journal)).filter((line) => line.event === "proposed" && line.id !== expiredId),
      ).toHaveLength(1);
      expect(posts()).toEqual([]);

      await approved(home, 3, MESSAGE, DAY - 60_000);
      armPost(3);
      expect((await call(home, { thing_id: 3, message: MESSAGE })).result["outcome"]).toBe("sent");
      expect(posts()).toHaveLength(1);

      await approved(home, 4, MESSAGE, HOUR, { kind: "other.kind" });
      await approved(home, 5, MESSAGE, HOUR, { container_id: 2 });
      await approved(home, 7, MESSAGE, HOUR);
      for (const thingId of [4, 5, 6]) {
        const out = await call(home, { thing_id: thingId, message: MESSAGE });
        expect(out.result, String(thingId)).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      }
      expect(posts()).toHaveLength(1);
    });
  });

  it("S5: a POST the platform refuses is an error result of the transport's kind naming the used go-ahead, with one failed line", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const id = await approved(home, 2, MESSAGE);
      gripPool(agent)
        .intercept({ path: "/1/synthetic/2", method: "POST" })
        .reply(200, JSON.stringify({ success: false, data: "limit of swipes reached for action" }), {
          headers: JSON_HEADERS,
        });
      const out = await call(home, { thing_id: 2, message: MESSAGE });
      expect(out.isError).toBe(true);
      const error = (out.result as { error: { kind: string; message: string } }).error;
      expect(error.kind).toBe("swipe-cap");
      expect(error.message).toContain("the go-ahead was used; a new one is needed to try again");
      expect(posts()).toHaveLength(1);
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        outcome: "failed",
        response: "limit of swipes reached for action",
        go_ahead: id,
      });
      const retry = await call(home, { thing_id: 2, message: MESSAGE });
      expect(retry.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      expect(retry.result["go_ahead_id"]).not.toBe(id);
    });
  });

  it("S6: the two writes reads list with the local-state posture and readOnlyHint, answer without a session or a call, and no writes_go tool exists", async () => {
    await withTempHome(async (home) => {
      const server = buildServer("0.0.0", {
        env: home.env,
        clock: advancingClock(),
        dispatcher: agent,
        stderr: new Sink(),
      });
      const link = await linkMcp(server);
      try {
        const tools = await link.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toContain("gripeventsctl_writes_status");
        expect(names).toContain("gripeventsctl_writes_pending");
        expect(names.filter((name) => name.startsWith("gripeventsctl_writes_go"))).toEqual([]);
        for (const name of ["gripeventsctl_writes_status", "gripeventsctl_writes_pending"]) {
          const tool = tools.find((entry) => entry.name === name);
          expect(tool?.description, name).toContain(LOCAL_STATE_POSTURE);
          expect(tool?.description, name).not.toContain(
            "It reads what the signed-in attendee's own session already sees.",
          );
          expect(tool?.annotations, name).toEqual({ readOnlyHint: true });
        }
        const before = agent.getCallHistory()?.calls().length ?? 0;
        const status = await link.callTool("gripeventsctl_writes_status", {});
        expect(status.isError).toBeFalsy();
        expect(status.structuredContent).toEqual({
          writes_enabled: false,
          send_log: join(home.dir, ".gripeventsctl.send-log.jsonl"),
          go_aheads_pending: 0,
          config_path: home.configFile,
        });
        expect(status.content.map((block) => ("text" in block ? String(block.text) : "")).join("\n")).toContain(
          "writes: safe mode",
        );
        const pending = await link.callTool("gripeventsctl_writes_pending", {});
        expect(pending.structuredContent).toEqual({ items: [] });
        expect(pending.content.map((block) => ("text" in block ? String(block.text) : "")).join("\n")).toContain(
          "no go-aheads pending",
        );
        expect((agent.getCallHistory()?.calls().length ?? 0) - before).toBe(0);
        await expect(stat(paths(home).sendLog)).rejects.toThrow();
        await expect(stat(paths(home).journal)).rejects.toThrow();
      } finally {
        await link.close();
      }
    });
  });
});
