// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-GOAHEAD, unit and component: the go-ahead journal of issue #16 § The go-ahead journal. The id shape and the
 * exact hash, the fold by file order, the expiry and the pending list, the proposal that never mints a second id
 * for the same four fields and does for a different text or person, the approval and its four refusals (unknown,
 * already approved, consumed, expired) as the `usage` kind, the consume event, and the file created with mode 0600.
 * The pre-authored oracle `go-ahead.oracle.test.ts` grades the life cycle through the gate; this file grades the
 * module's own functions.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  appendJsonLine,
  fakeClock,
  journalEvent,
  readJournal as readLines,
  sha256Of,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { UsageError } from "../index.js";
import {
  GO_AHEAD_TTL_MS,
  type GoAheadEvent,
  approveGoAhead,
  consumeGoAhead,
  findOpenProposal,
  foldJournal,
  goAheadExpiresAt,
  isUsable,
  messageSha256,
  newGoAheadId,
  pendingProposals,
  proposeGoAhead,
  readJournal,
} from "../gate/go-ahead.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const WRITE = { kind: "synthetic.write", container_id: 1, target_thing_id: 42, message: "synthetic message 1" };

const event = (overrides: Partial<GoAheadEvent> = {}): GoAheadEvent => journalEvent(overrides) as GoAheadEvent;

describe("[CAP-GOAHEAD] a go-ahead matches one exact write, expires, and is recorded only by a terminal user", () => {
  describe("unit", () => {
    it("U1: an id is 11 base64url characters carrying 8 bytes, and the hash is over the exact text", () => {
      const id = newGoAheadId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(Buffer.from(id, "base64url")).toHaveLength(8);
      expect(messageSha256("synthetic message 1")).toBe(sha256Of("synthetic message 1"));
      expect(messageSha256("synthetic message 1 ")).not.toBe(messageSha256("synthetic message 1"));
      expect(messageSha256("")).toBe(sha256Of(""));
    });

    it("U2: the fold gives each id the state of its latest event in file order, with the times of each event", () => {
      const a = newGoAheadId();
      const b = newGoAheadId();
      const events = [
        event({ id: a, time: "2026-10-12T09:00:00.000Z" }),
        event({ id: b, time: "2026-10-12T09:30:00.000Z", target_thing_id: 43 }),
        event({ id: a, event: "approved", time: "2026-10-12T10:00:00.000Z", source: "cli", message: undefined }),
        // A later line with an earlier time still wins: file order decides.
        event({ id: a, event: "consumed", time: "2026-10-12T08:00:00.000Z", message: undefined }),
      ];
      const folded = foldJournal(events);
      expect(folded.size).toBe(2);
      expect(folded.get(a)).toMatchObject({
        state: "consumed",
        proposed_at: "2026-10-12T09:00:00.000Z",
        approved_at: "2026-10-12T10:00:00.000Z",
        consumed_at: "2026-10-12T08:00:00.000Z",
        message: "synthetic message 1",
        target_thing_id: 42,
      });
      expect(folded.get(b)).toMatchObject({ state: "proposed", target_thing_id: 43 });
    });

    it("U3: the expiry is the latest approved time plus 24 hours, else the proposed time plus 24 hours", () => {
      expect(GO_AHEAD_TTL_MS).toBe(24 * HOUR);
      const proposedAt = new Date(T0).toISOString();
      const approvedAt = new Date(T0 + 2 * HOUR).toISOString();
      expect(goAheadExpiresAt({ proposed_at: proposedAt }).getTime()).toBe(T0 + 24 * HOUR);
      expect(goAheadExpiresAt({ proposed_at: proposedAt, approved_at: approvedAt }).getTime()).toBe(T0 + 26 * HOUR);
      const id = newGoAheadId();
      const folded = foldJournal([
        event({ id, time: proposedAt }),
        event({ id, event: "approved", time: approvedAt, source: "cli", message: undefined }),
      ]);
      const record = folded.get(id);
      expect(record).toBeDefined();
      if (record === undefined) return;
      expect(isUsable(record, new Date(T0 + 26 * HOUR - 1))).toBe(true);
      expect(isUsable(record, new Date(T0 + 26 * HOUR))).toBe(false);
    });

    it("U4: the pending list holds the unexpired proposals only, oldest first", () => {
      const now = new Date(T0);
      const first = event({ time: new Date(T0 - 2 * HOUR).toISOString() });
      const second = event({ time: new Date(T0 - HOUR).toISOString(), target_thing_id: 43 });
      const approved = event({ time: new Date(T0 - 3 * HOUR).toISOString(), target_thing_id: 44 });
      const expired = event({ time: new Date(T0 - 25 * HOUR).toISOString(), target_thing_id: 45 });
      const folded = foldJournal([
        second,
        approved,
        { ...approved, event: "approved", time: new Date(T0 - 2 * HOUR).toISOString(), source: "cli" },
        expired,
        first,
      ]);
      expect(pendingProposals(folded, now).map((record) => record.id)).toEqual([first.id, second.id]);
    });
  });

  describe("component", () => {
    it("C1: a proposal is appended once for the same four fields and once more for another text or person", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.go-aheads.jsonl");
        const clock = fakeClock(T0);
        const first = await proposeGoAhead(path, { ...WRITE, source: "mcp" }, clock);
        expect(first).toMatchObject({ state: "proposed", message: WRITE.message, source: "mcp" });
        const again = await proposeGoAhead(path, { ...WRITE, source: "cli" }, clock);
        expect(again.id).toBe(first.id);
        const otherText = await proposeGoAhead(
          path,
          { ...WRITE, message: "synthetic message 2", source: "mcp" },
          clock,
        );
        const otherPerson = await proposeGoAhead(path, { ...WRITE, target_thing_id: 43, source: "mcp" }, clock);
        expect(new Set([first.id, otherText.id, otherPerson.id]).size).toBe(3);
        const lines = await readLines(path);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toEqual({
          time: new Date(T0).toISOString(),
          event: "proposed",
          id: first.id,
          kind: WRITE.kind,
          container_id: 1,
          target_thing_id: 42,
          message: WRITE.message,
          message_sha256: sha256Of(WRITE.message),
          source: "mcp",
        });
        expect(await readJournal(path)).toEqual(lines);
        if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      });
    });

    it("C2: the approval appends one approved event from the cli with the hash only, dated to the ask", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.go-aheads.jsonl");
        const clock = fakeClock(T0);
        const proposal = await proposeGoAhead(path, { ...WRITE, source: "mcp" }, clock);
        expect((await findOpenProposal(path, proposal.id, clock)).id).toBe(proposal.id);
        const askedAt = new Date(T0 + 1000);
        const approved = await approveGoAhead(path, proposal.id, clock, { at: askedAt });
        expect(approved).toMatchObject({ state: "approved", approved_at: askedAt.toISOString(), source: "cli" });
        const lines = await readLines(path);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toEqual({
          time: askedAt.toISOString(),
          event: "approved",
          id: proposal.id,
          kind: WRITE.kind,
          container_id: 1,
          target_thing_id: 42,
          message_sha256: sha256Of(WRITE.message),
          source: "cli",
        });
        expect(goAheadExpiresAt(approved).getTime()).toBe(T0 + 1000 + 24 * HOUR);
      });
    });

    it("C3: an unknown, approved, consumed or expired id cannot be approved: the usage kind names the state", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.go-aheads.jsonl");
        const clock = fakeClock(T0);
        const refusal = async (id: string): Promise<UsageError> => {
          const error = await approveGoAhead(path, id, clock).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(UsageError);
          await expect(findOpenProposal(path, id, clock)).rejects.toThrow((error as Error).message);
          return error as UsageError;
        };
        expect((await refusal("unknownid01")).message).toContain("unknown");

        const approved = await proposeGoAhead(path, { ...WRITE, source: "mcp" }, clock);
        await approveGoAhead(path, approved.id, clock);
        expect((await refusal(approved.id)).message).toContain("already approved");

        const consumed = await proposeGoAhead(path, { ...WRITE, target_thing_id: 43, source: "mcp" }, clock);
        await approveGoAhead(path, consumed.id, clock);
        await consumeGoAhead(path, consumed, "mcp", clock);
        expect((await refusal(consumed.id)).message).toContain("consumed");
        const lastLine = (await readLines(path)).at(-1);
        expect(lastLine).toMatchObject({ event: "consumed", id: consumed.id, source: "mcp" });
        expect(lastLine).not.toHaveProperty("message");

        const expiring = event({ time: new Date(T0 - 25 * HOUR).toISOString(), target_thing_id: 44 });
        await appendJsonLine(path, expiring);
        expect((await refusal(expiring.id)).message).toContain("expired");
        expect((await readLines(path)).filter((line) => line.event === "approved")).toHaveLength(2);
      });
    });
  });
});
