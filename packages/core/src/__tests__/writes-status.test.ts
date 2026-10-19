// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-PARITY and CAP-GATE: the two `writes` reads of issue #16 § `writes status` and § `writes pending` at the
 * operation level, and their registration. `writes status` over no config file, safe mode and writes enabled, with
 * the pending count following a proposal, its approval and its expiry, no session needed and no platform call;
 * `writes pending` listing the unexpired proposals oldest first with the five fields; the human first line word for
 * word; the posture override and the empty request list; and the registry ending with the two entries. The surface
 * forms run in `write-paths.oracle.test.ts` (S16) and `gate-mcp-path.test.ts`.
 */

import { writeFile } from "node:fs/promises";
import { Writable } from "node:stream";

import {
  type TempHome,
  appendJsonLine,
  eventFields,
  fakeClock,
  fixtureSecrets,
  journalEvent,
  mockGrip,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { GripClient, OPERATIONS, type OperationContext, createWriteGate, derivedPaths, loadConfig } from "../index.js";
import { PENDING_EMPTY_TEXT, PENDING_NOTE, writesPending } from "../operations/writes/pending.js";
import { LOCAL_STATE_POSTURE, writesLine, writesStatus } from "../operations/writes/status.js";

const agent = mockGrip();
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

class Sink extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function requests(): number {
  return agent.getCallHistory()?.calls().length ?? 0;
}

async function contextIn(home: TempHome, at = T0): Promise<OperationContext> {
  const loaded = await loadConfig({ env: home.env });
  const clock = fakeClock(at);
  const stderr = new Sink();
  return {
    client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr }),
    config: loaded,
    clock,
    stderr,
    source: "cli",
    gate: createWriteGate({
      config: loaded,
      paths: derivedPaths(loaded.path, loaded.config),
      clock,
      source: "cli",
      stderr,
    }),
  };
}

async function seed(home: TempHome, writesEnabled: boolean): Promise<void> {
  await writeFile(
    home.configFile,
    `version: 1\nsession:\n  slug: test-event-1\n  container_id: 1\n  token: ${fixtureSecrets().sessionToken}\n  signed_in_at: "2026-10-12T10:00:00.000Z"\nwrites:\n  enabled: ${String(writesEnabled)}\n`,
    { mode: 0o600 },
  );
}

describe("[CAP-PARITY] [CAP-GATE] writes status and writes pending read the gate's local state and make no platform call", () => {
  it("registers the two writes reads as the last entries, with no request shape, no session, and the local-state posture", () => {
    expect(OPERATIONS.slice(-2)).toEqual([writesStatus, writesPending]);
    for (const op of [writesStatus, writesPending]) {
      expect(op.kind).toBe("read");
      expect(op.needsSession).toBe(false);
      expect(op.requests).toEqual([]);
      expect(op.mcp?.descriptionPosture).toBe(LOCAL_STATE_POSTURE);
    }
    expect(writesPending.render?.emptyText).toBe(PENDING_EMPTY_TEXT);
    expect(writesPending.render?.note).toBe(PENDING_NOTE);
    expect(writesLine(false)).toBe("writes: safe mode");
    expect(writesLine(true)).toBe("writes: writes enabled");
  });

  it("writes status reports the switch, the send log, the config path and the pending count: no config, safe mode, writes enabled; 0, 1, 0, 0", async () => {
    await withTempHome(async (home) => {
      const before = requests();
      const none = await writesStatus.run(await contextIn(home), {});
      expect(none).toEqual({
        writes_enabled: false,
        send_log: derivedPaths(home.configFile, { version: 1, writes: { enabled: false } }).sendLog,
        go_aheads_pending: 0,
        config_path: home.configFile,
      });
      expect(writesStatus.render?.human?.(none).split("\n")[0]).toBe("writes: safe mode");

      await seed(home, false);
      expect((await writesStatus.run(await contextIn(home), {})).writes_enabled).toBe(false);
      await seed(home, true);
      const enabled = await writesStatus.run(await contextIn(home), {});
      expect(enabled.writes_enabled).toBe(true);
      expect(writesStatus.render?.human?.(enabled).split("\n")[0]).toBe("writes: writes enabled");

      const journal = derivedPaths(home.configFile, { version: 1, writes: { enabled: true } }).goAheads;
      const proposal = journalEvent({ time: new Date(T0 - HOUR).toISOString() });
      await appendJsonLine(journal, proposal);
      expect((await writesStatus.run(await contextIn(home), {})).go_aheads_pending).toBe(1);
      const fields = eventFields(proposal);
      await appendJsonLine(journal, { ...fields, event: "approved", time: new Date(T0).toISOString(), source: "cli" });
      expect((await writesStatus.run(await contextIn(home), {})).go_aheads_pending).toBe(0);
      const second = journalEvent({ time: new Date(T0 - HOUR).toISOString(), target_thing_id: 43 });
      await appendJsonLine(journal, second);
      expect((await writesStatus.run(await contextIn(home), {})).go_aheads_pending).toBe(1);
      expect((await writesStatus.run(await contextIn(home, T0 + 23 * HOUR + 1000), {})).go_aheads_pending).toBe(0);
      expect(requests() - before).toBe(0);
    });
  });

  it("writes pending lists the unexpired proposals oldest first with the five fields, and nothing when there are none", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const before = requests();
      expect(await writesPending.run(await contextIn(home), {})).toEqual([]);
      const journal = derivedPaths(home.configFile, { version: 1, writes: { enabled: true } }).goAheads;
      const newer = journalEvent({
        time: new Date(T0 - HOUR).toISOString(),
        target_thing_id: 43,
        message: "synthetic message 2",
      });
      const older = journalEvent({ time: new Date(T0 - 2 * HOUR).toISOString() });
      const expired = journalEvent({ time: new Date(T0 - 25 * HOUR).toISOString(), target_thing_id: 44 });
      const approved = journalEvent({ time: new Date(T0 - 3 * HOUR).toISOString(), target_thing_id: 45 });
      for (const line of [newer, older, expired, approved]) await appendJsonLine(journal, line);
      const fields = eventFields(approved);
      await appendJsonLine(journal, {
        ...fields,
        event: "approved",
        time: new Date(T0 - 2 * HOUR).toISOString(),
        source: "cli",
      });
      expect(await writesPending.run(await contextIn(home), {})).toEqual([
        {
          id: older.id,
          kind: "synthetic.write",
          target_thing_id: 42,
          message: "synthetic message 1",
          proposed_at: older.time,
        },
        {
          id: newer.id,
          kind: "synthetic.write",
          target_thing_id: 43,
          message: "synthetic message 2",
          proposed_at: newer.time,
        },
      ]);
      expect(requests() - before).toBe(0);
    });
  });
});
