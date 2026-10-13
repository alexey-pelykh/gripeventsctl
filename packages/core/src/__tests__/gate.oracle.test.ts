// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-GATE, unit and component levels: the repeat guard's key (U1 to U5)
 * and a write lock held past the retry bound (C6). The surface cases (S7 to S41) live in
 * `packages/gripeventsctl/src/__tests__/write-paths.oracle.test.ts`, the two-process case (P42) in
 * `write-paths-process.oracle.test.ts` beside it. The guard-removal drill (M43) is manual.
 *
 * Written before the write gate exists, from the write gate item (#16) § Specification. The
 * implementing change leaves this file byte-identical. Every helper the file needs lives inside it.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The contract this oracle grades, as the write gate item fixes it.
interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

/** One send log line (#16 § The send log). */
interface SendLogEntry {
  time: string;
  kind: string;
  source: "cli" | "mcp";
  container_id: number;
  target_thing_id: number;
  status_before: string | null;
  message: string | null;
  message_sha256: string | null;
  go_ahead: string | null;
  dry_run: boolean;
  outcome: "sent" | "refused" | "failed" | "dry-run";
  refusal: string | null;
  http_status: number | null;
  response: string | null;
  connection: number | null;
  message_id: number | null;
}

interface RepeatGuardKey {
  container_id: number;
  target_thing_id: number;
  kind: string;
}

interface SendLogModule {
  repeatGuard(entries: readonly SendLogEntry[], key: RepeatGuardKey): SendLogEntry | null;
}

interface WriteSpec<R> {
  kind: string;
  targetThingId: number;
  message: string | null;
  dryRun: boolean;
  readStatus?: () => Promise<string>;
  allowedStatus?: string;
  request: { method: "POST"; path: string; body: unknown };
  send: () => Promise<R>;
  resultFields: (result: R) => { connection?: number | null; message_id?: number | null };
}

interface WriteResult {
  outcome: "sent" | "refused" | "failed" | "dry-run";
  refusal?: string;
  hint?: string;
  log_entry: SendLogEntry;
}

/**
 * Name chosen by this oracle: `config` is the `loadConfig()` result `{ config, path, exists }`, the
 * same value `OperationContext.config` holds, so the gate can name the config path in its hint.
 */
interface WriteGateOptions {
  config: { config: Record<string, unknown>; path: string; exists: boolean };
  paths: { sendLog: string; goAheads: string; writeLock: string };
  clock: Clock;
  source: "cli" | "mcp";
  stderr: NodeJS.WritableStream;
}

interface GateModule {
  createWriteGate(options: WriteGateOptions): {
    writesEnabled(): boolean;
    execute<R>(spec: WriteSpec<R>): Promise<WriteResult>;
  };
}

/**
 * Imports a probed subject. Resolves to `undefined` only when the module runner reports the probed
 * specifier itself as not found. Any other failure (the subject throws at import, a syntax error, a
 * dependency of the subject is missing) is rethrown, so the file fails instead of skipping.
 */
async function importSubject(specifier: string): Promise<unknown> {
  try {
    return await import(specifier);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const found = /^Cannot find (?:module|package) '([^']*)' imported from /.exec(message)?.[1];
    const tail = specifier.replace(/^(?:\.\.?\/)+/, "");
    const subjectNotFound =
      code === "ERR_MODULE_NOT_FOUND" && found !== undefined && (found === tail || found.endsWith(`/${tail}`));
    const entryNotFound = message.startsWith(`Failed to resolve entry for package "${specifier}"`);
    if (subjectNotFound || entryNotFound) return undefined;
    throw error;
  }
}

// Oracle subjects: packages/core/src/gate/send-log.ts and gate/gate.ts (not built yet when this file was written).
const sendLog = (await importSubject("../gate/send-log.js")) as SendLogModule | undefined;
const gate = (await importSubject("../gate/gate.js")) as GateModule | undefined;
const missing = [
  ...(sendLog === undefined ? ["packages/core/src/gate/send-log.ts"] : []),
  ...(gate === undefined ? ["packages/core/src/gate/gate.ts"] : []),
];
if (missing.length > 0 && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}
const subject = sendLog !== undefined && gate !== undefined ? { sendLog, gate } : undefined;

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const KEY: RepeatGuardKey = { container_id: 1, target_thing_id: 42, kind: "interest.show" };

/** A sent, non-dry-run `interest show` line to thing 42 in container 1: the line the guard blocks on. */
function sentLine(overrides: Partial<SendLogEntry> = {}): SendLogEntry {
  return {
    time: "2026-10-12T09:00:00Z",
    kind: "interest.show",
    source: "cli",
    container_id: 1,
    target_thing_id: 42,
    status_before: "has_match_none",
    message: null,
    message_sha256: null,
    go_ahead: null,
    dry_run: false,
    outcome: "sent",
    refusal: null,
    http_status: 201,
    response: null,
    connection: 0,
    message_id: null,
    ...overrides,
  };
}

class Sink extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(subject === undefined)(
  "[CAP-GATE] no write request leaves the process unless writes are enabled, the repeat guard is clear and a needed go-ahead is recorded",
  () => {
    // A skipped `describe` still runs this callback to collect its tests, so nothing here may
    // dereference a missing subject; the tests themselves run only when it exists.
    const live = (): NonNullable<typeof subject> => {
      if (subject === undefined) throw new Error("unreachable: the suite is skipped without its subject");
      return subject;
    };

    describe("unit", () => {
      const rows: { id: string; title: string; variant: SendLogEntry }[] = [
        { id: "U1", title: "a dry-run entry", variant: sentLine({ dry_run: true }) },
        {
          id: "U2",
          title: "a failed entry",
          variant: sentLine({ outcome: "failed", http_status: 409, response: "conflict", connection: null }),
        },
        {
          id: "U3",
          title: "a refused entry",
          variant: sentLine({ outcome: "refused", refusal: "status-not-none", http_status: null, connection: null }),
        },
        { id: "U4", title: "an entry of another kind", variant: sentLine({ kind: "chat.send", connection: null }) },
        { id: "U5", title: "an entry in another container", variant: sentLine({ container_id: 2 }) },
      ];

      for (const row of rows) {
        it(`${row.id}: ${row.title} to the same person never blocks; a sent entry of the same key does`, () => {
          const { repeatGuard } = live().sendLog;
          const blocking = sentLine();
          const newer = sentLine({ time: "2026-10-12T10:00:00Z" });

          // The control: a sent, non-dry-run entry with the same three fields blocks, newest first.
          expect(repeatGuard([blocking], KEY)).toEqual(blocking);
          expect(repeatGuard([blocking, newer], KEY)).toEqual(newer);

          // The case: the variant alone never blocks, and never hides a blocking entry beside it.
          expect(repeatGuard([row.variant], KEY)).toBeNull();
          expect(repeatGuard([row.variant, row.variant], KEY)).toBeNull();
          expect(repeatGuard([blocking, row.variant], KEY)).toEqual(blocking);
          expect(repeatGuard([], KEY)).toBeNull();
        });
      }
    });

    describe("component", () => {
      let home = "";
      let configFile = "";
      let paths = { sendLog: "", goAheads: "", writeLock: "" };

      beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-gate-"));
        configFile = join(home, ".gripeventsctl.yaml");
        // #4 § Path resolution and derived paths: the three files sit beside the config.
        paths = {
          sendLog: join(home, ".gripeventsctl.send-log.jsonl"),
          goAheads: join(home, ".gripeventsctl.go-aheads.jsonl"),
          writeLock: join(home, ".gripeventsctl.write.lock"),
        };
      });

      afterEach(async () => {
        await rm(home, { recursive: true, force: true });
      });

      it("C6: a write lock held past the retry bound gives write-busy, sends nothing and appends no line", async () => {
        const token = randomUUID();
        const config = {
          version: 1,
          session: { slug: "test-event-1", container_id: 1, token, signed_in_at: "2026-10-12T10:00:00.000Z" },
          writes: { enabled: true },
        };
        await writeFile(
          configFile,
          [
            "version: 1",
            "session:",
            "  slug: test-event-1",
            "  container_id: 1",
            `  token: ${token}`,
            '  signed_in_at: "2026-10-12T10:00:00.000Z"',
            "writes:",
            "  enabled: true",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        const clock: Clock = {
          now: () => new Date(NOW),
          sleep: () => Promise.resolve(),
          timeoutSignal: (ms) => AbortSignal.timeout(ms),
        };
        const writeGate = live().gate.createWriteGate({
          config: { config, path: configFile, exists: true },
          paths,
          clock,
          source: "cli",
          stderr: new Sink(),
        });
        expect(writeGate.writesEnabled()).toBe(true);

        let sends = 0;
        let statusReads = 0;
        // Another writer holds the write lock for the whole attempt, past its five one-second retries.
        const release = await lockfile.lock(paths.writeLock, { realpath: false });
        let result: WriteResult;
        try {
          result = await writeGate.execute({
            kind: "interest.skip",
            targetThingId: 2,
            message: null,
            dryRun: false,
            readStatus: () => {
              statusReads += 1;
              return Promise.resolve("has_match_none");
            },
            allowedStatus: "has_match_none",
            // (value open: OQ-6 — docs/api/interest.md § Send an answer says the no answer is from the app code and not
            // verified as a POST; the gated-writes item ships interest skip only after a recorded live no; amend this
            // path or verb if the live run shows another)
            request: { method: "POST", path: "container/1/thing/user_id/match_manual/no/to_thing/2", body: {} },
            send: () => {
              sends += 1;
              return Promise.resolve({ message: "action recorded - swipe message created or updated", connection: 0 });
            },
            resultFields: () => ({}),
          });
        } finally {
          await release();
        }

        expect(result.outcome).toBe("refused");
        expect(result.refusal).toBe("write-busy");
        expect(result.hint).toContain(`another write holds ${paths.writeLock}; wait for it to finish and run again`);
        expect(sends).toBe(0);
        expect(statusReads).toBe(0);
        // The one refusal whose line is not on disk: the log cannot be appended without the lock.
        expect(await readLines(paths.sendLog)).toEqual([]);
        expect(result.log_entry.outcome).toBe("refused");
        expect(result.log_entry.refusal).toBe("write-busy");
        expect(result.log_entry.http_status).toBeNull();
        expect(result.log_entry.target_thing_id).toBe(2);
      }, 30_000);
    });
  },
);
