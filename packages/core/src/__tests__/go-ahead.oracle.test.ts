// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-GOAHEAD, unit, component and process levels: ids (U1), the fold
 * (U2), the life cycle and the four-field match (C3 to C6), the 24-hour expiry (C7, C8) and the
 * consume before the POST across a SIGKILL (P17). The surface cases (S9 to S16) live in
 * `packages/gripeventsctl/src/__tests__/write-paths.oracle.test.ts`.
 *
 * Written before the write gate exists, from the write gate item (#16) § Specification. The
 * implementing change leaves this file byte-identical. Every helper the file needs lives inside it.
 * The journal and send log fixtures are written in the line formats #16 fixes, never by the subject.
 */

import { fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { MockAgent, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The contract this oracle grades, as the write gate item fixes it.
interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

/** One journal line (#16 § The go-ahead journal). */
interface GoAheadEvent {
  time: string;
  event: "proposed" | "approved" | "consumed";
  id: string;
  kind: string;
  container_id: number;
  target_thing_id: number;
  message?: string;
  message_sha256: string;
  source: "cli" | "mcp";
}

/** Name chosen by this oracle: the folded record carries `id` and `state`, the latest event by file order. */
interface GoAheadRecord {
  id: string;
  state: GoAheadEvent["event"];
}

/** Names chosen by this oracle: #16 exports these functions and leaves their parameters open. */
interface GoAheadModule {
  GO_AHEAD_TTL_MS: number;
  readJournal(path: string): Promise<GoAheadEvent[]>;
  foldJournal(events: readonly GoAheadEvent[]): Map<string, GoAheadRecord>;
  goAheadExpiresAt(record: GoAheadRecord): Date | string;
  proposeGoAhead(
    path: string,
    write: { kind: string; container_id: number; target_thing_id: number; message: string; source: "cli" | "mcp" },
    clock: Clock,
  ): Promise<GoAheadRecord>;
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
  go_ahead_id?: string;
  go_ahead_expires_at?: string;
  message_id?: number | null;
}

/** Name chosen by this oracle: `config` is the `loadConfig()` result, as `OperationContext.config` holds it. */
interface GateModule {
  createWriteGate(options: {
    config: { config: Record<string, unknown>; path: string; exists: boolean };
    paths: { sendLog: string; goAheads: string; writeLock: string };
    clock: Clock;
    source: "cli" | "mcp";
    stderr: NodeJS.WritableStream;
  }): { execute<R>(spec: WriteSpec<R>): Promise<WriteResult> };
}

interface ClientModule {
  GripClient: new (opts: { dispatcher: Dispatcher; clock: Clock; env: NodeJS.ProcessEnv; stderr: Writable }) => {
    post<T>(path: string, body: unknown): Promise<T>;
  };
}

// Oracle subjects: packages/core/src/gate/go-ahead.ts and gate/gate.ts (not built yet when this file
// was written), plus the transport client of #5 that one component case sends through.
const goAhead = (await import("../gate/go-ahead.js").catch(() => undefined)) as GoAheadModule | undefined;
const gate = (await import("../gate/gate.js").catch(() => undefined)) as GateModule | undefined;
const client = (await import("../transport/client.js").catch(() => undefined)) as ClientModule | undefined;
const missing = [
  ...(goAhead === undefined ? ["packages/core/src/gate/go-ahead.ts"] : []),
  ...(gate === undefined ? ["packages/core/src/gate/gate.ts"] : []),
  ...(client === undefined ? ["packages/core/src/transport/client.ts"] : []),
];
if (missing.length > 0 && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}
const subject =
  goAhead !== undefined && gate !== undefined && client !== undefined ? { goAhead, gate, client } : undefined;

const API_ORIGIN = "https://api-prod.grip.events";
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CORE_DIST = new URL("../../dist/index.js", import.meta.url).href;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();
const newId = (): string => randomBytes(8).toString("base64url");

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

async function appendLine(path: string, value: object): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** The write a go-ahead is for: the four matching fields plus the text. */
interface Write {
  kind: string;
  container_id: number;
  target_thing_id: number;
  message: string;
}

/** Appends a `proposed` event and, when `approvedAt` is given, an `approved` event, as #16's table fixes them. */
async function recordGoAhead(journal: string, write: Write, proposedAt: number, approvedAt?: number): Promise<string> {
  const id = newId();
  const fields = {
    kind: write.kind,
    container_id: write.container_id,
    target_thing_id: write.target_thing_id,
    message_sha256: sha256(write.message),
  };
  await appendLine(journal, {
    time: iso(proposedAt),
    event: "proposed",
    id,
    ...fields,
    message: write.message,
    source: "mcp",
  });
  if (approvedAt !== undefined) {
    await appendLine(journal, { time: iso(approvedAt), event: "approved", id, ...fields, source: "cli" });
  }
  return id;
}

interface Home {
  dir: string;
  configFile: string;
  token: string;
  paths: { sendLog: string; goAheads: string; writeLock: string };
  env: NodeJS.ProcessEnv;
}

async function makeHome(): Promise<Home> {
  const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-go-ahead-"));
  const configFile = join(dir, ".gripeventsctl.yaml");
  const token = randomUUID();
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
  const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, GRIPEVENTSCTL_CONFIG_FILE: configFile };
  for (const name of ["PATH", "SYSTEMROOT", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // #4 § Path resolution and derived paths: the three files sit beside the config.
  const paths = {
    sendLog: join(dir, ".gripeventsctl.send-log.jsonl"),
    goAheads: join(dir, ".gripeventsctl.go-aheads.jsonl"),
    writeLock: join(dir, ".gripeventsctl.write.lock"),
  };
  return { dir, configFile, token, paths, env };
}

function configOf(home: Home): { config: Record<string, unknown>; path: string; exists: boolean } {
  const session = {
    slug: "test-event-1",
    container_id: 1,
    token: home.token,
    signed_in_at: "2026-10-12T10:00:00.000Z",
  };
  return { config: { version: 1, session, writes: { enabled: true } }, path: home.configFile, exists: true };
}

/** A clock the test sets; waits end at once. */
function manualClock(start: number): Clock & { set(ms: number): void } {
  let current = start;
  return {
    now: () => new Date(current),
    sleep: (ms) => {
      current += ms;
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    set: (ms) => {
      current = ms;
    },
  };
}

/** A chat-shaped write spec whose `send` is counted and answers the documented chat answer. */
function chatSpec(
  write: Write,
  onSend: () => Promise<void> | void,
  send?: () => Promise<{ message_id: number }>,
): WriteSpec<{ message_id: number }> {
  return {
    kind: write.kind,
    targetThingId: write.target_thing_id,
    message: write.message,
    dryRun: false,
    request: {
      method: "POST",
      path: `chat/thing/${String(write.target_thing_id)}`,
      body: { message: write.message, container_id: 1 },
    },
    send: async () => {
      await onSend();
      // docs/api/chat-and-meetings.md § Send a chat message: `{ success: true, data: { message_id } }`.
      return send === undefined ? { message_id: 7 } : send();
    },
    resultFields: (result) => ({ message_id: result.message_id }),
  };
}

function eventsFor(lines: Record<string, unknown>[], id: string): Record<string, unknown>[] {
  return lines.filter((line) => line["id"] === id);
}

describe.skipIf(subject === undefined)(
  "[CAP-GOAHEAD] a go-ahead is an act only a terminal user performs, matches one exact write, expires, and is consumed before the POST",
  () => {
    const live = (): NonNullable<typeof subject> => {
      if (subject === undefined) throw new Error("unreachable: the suite is skipped without its subject");
      return subject;
    };
    let home: Home;

    beforeEach(async () => {
      home = await makeHome();
    });

    afterEach(async () => {
      await rm(home.dir, { recursive: true, force: true });
    });

    // The gate as the MCP path builds it: no terminal confirmation, so a missing go-ahead is proposed.
    const gateFor = (clock: Clock) =>
      live().gate.createWriteGate({
        config: configOf(home),
        paths: home.paths,
        clock,
        source: "mcp",
        stderr: new Sink(),
      });

    describe("unit", () => {
      it("U1: 10,000 proposed ids never collide and each is 11 base64url characters carrying 64 bits", async () => {
        const { proposeGoAhead } = live().goAhead;
        const clock = manualClock(T0);
        const ids = new Set<string>();
        for (let n = 0; n < 10_000; n += 1) {
          // One journal per proposal keeps the run linear: the case is about the ids, not the scan.
          const record = await proposeGoAhead(
            join(home.dir, `journal-${String(n)}.jsonl`),
            { kind: "chat.send", container_id: 1, target_thing_id: 2, message: "synthetic message 1", source: "mcp" },
            clock,
          );
          expect(record.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
          expect(Buffer.from(record.id, "base64url")).toHaveLength(8);
          ids.add(record.id);
        }
        expect(ids.size).toBe(10_000);
      }, 120_000);

      it("U2: the fold gives each id the state of its latest event in file order, and the expiry follows it", async () => {
        const { readJournal, foldJournal, goAheadExpiresAt, GO_AHEAD_TTL_MS } = live().goAhead;
        expect(GO_AHEAD_TTL_MS).toBe(DAY);
        const base = { kind: "chat.send", container_id: 1, message_sha256: sha256("synthetic message 1") };
        const [a, b, c, d] = [newId(), newId(), newId(), newId()];
        const events: GoAheadEvent[] = [
          {
            time: iso(T0),
            event: "proposed",
            id: a,
            ...base,
            target_thing_id: 2,
            message: "synthetic message 1",
            source: "mcp",
          },
          {
            time: iso(T0 + HOUR),
            event: "proposed",
            id: b,
            ...base,
            target_thing_id: 3,
            message: "synthetic message 1",
            source: "cli",
          },
          { time: iso(T0 + 2 * HOUR), event: "approved", id: a, ...base, target_thing_id: 2, source: "cli" },
          {
            time: iso(T0 + 3 * HOUR),
            event: "proposed",
            id: c,
            ...base,
            target_thing_id: 4,
            message: "synthetic message 1",
            source: "mcp",
          },
          { time: iso(T0 + 4 * HOUR), event: "approved", id: c, ...base, target_thing_id: 4, source: "cli" },
          { time: iso(T0 + 5 * HOUR), event: "consumed", id: c, ...base, target_thing_id: 4, source: "mcp" },
          {
            time: iso(T0 + 6 * HOUR),
            event: "proposed",
            id: d,
            ...base,
            target_thing_id: 5,
            message: "synthetic message 1",
            source: "mcp",
          },
          // File order decides, not the time field: this later line carries an earlier time.
          { time: iso(T0 + 7 * HOUR), event: "consumed", id: d, ...base, target_thing_id: 5, source: "mcp" },
          { time: iso(T0 + 6 * HOUR + 1000), event: "approved", id: d, ...base, target_thing_id: 5, source: "cli" },
        ];
        await writeFile(home.paths.goAheads, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

        const read = await readJournal(home.paths.goAheads);
        expect(read).toEqual(events);
        const folded = foldJournal(read);
        expect(folded.size).toBe(4);
        expect(folded.get(a)?.state).toBe("approved");
        expect(folded.get(b)?.state).toBe("proposed");
        expect(folded.get(c)?.state).toBe("consumed");
        expect(folded.get(d)?.state).toBe("approved");

        // The expiry: the latest `approved` time plus 24 hours, or the `proposed` time plus 24 hours.
        const expiry = (id: string): number => {
          const record = folded.get(id);
          if (record === undefined) throw new Error(`no folded record for ${id}`);
          return new Date(goAheadExpiresAt(record)).getTime();
        };
        expect(expiry(a)).toBe(T0 + 2 * HOUR + DAY);
        expect(expiry(b)).toBe(T0 + HOUR + DAY);
      });
    });

    describe("component", () => {
      it("C3: proposed, then approved, then consumed before the POST; a second use and a different text are refused", async () => {
        const clock = manualClock(T0);
        const write: Write = { kind: "chat.send", container_id: 1, target_thing_id: 2, message: "synthetic message 1" };
        let sends = 0;
        let latestAtSend: Record<string, unknown> | undefined;

        // Proposed: the first call is refused and mints one id; a retry returns the same id.
        const first = await gateFor(clock).execute(chatSpec(write, () => void (sends += 1)));
        expect(first.outcome).toBe("refused");
        expect(first.refusal).toBe("go-ahead-missing");
        const id = first.go_ahead_id ?? "";
        expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
        expect(Date.parse(first.go_ahead_expires_at ?? "")).toBe(T0 + DAY);
        const again = await gateFor(clock).execute(chatSpec(write, () => void (sends += 1)));
        expect(again.go_ahead_id).toBe(id);
        const proposed = await readLines(home.paths.goAheads);
        expect(proposed).toHaveLength(1);
        expect(proposed[0]).toMatchObject({
          event: "proposed",
          id,
          kind: "chat.send",
          container_id: 1,
          target_thing_id: 2,
          message: write.message,
          message_sha256: sha256(write.message),
          source: "mcp",
        });
        expect(sends).toBe(0);

        // Approved at a terminal, then used: the consume is on disk when the POST leaves.
        await appendLine(home.paths.goAheads, {
          time: iso(T0 + 60_000),
          event: "approved",
          id,
          kind: "chat.send",
          container_id: 1,
          target_thing_id: 2,
          message_sha256: sha256(write.message),
          source: "cli",
        });
        clock.set(T0 + 120_000);
        const used = await gateFor(clock).execute(
          chatSpec(write, async () => {
            sends += 1;
            latestAtSend = eventsFor(await readLines(home.paths.goAheads), id).at(-1);
          }),
        );
        expect(used.outcome).toBe("sent");
        expect(sends).toBe(1);
        expect(latestAtSend).toMatchObject({ event: "consumed", id, source: "mcp" });
        expect(eventsFor(await readLines(home.paths.goAheads), id).map((line) => line["event"])).toEqual([
          "proposed",
          "approved",
          "consumed",
        ]);
        const sentLine = (await readLines(home.paths.sendLog)).at(-1);
        expect(sentLine).toMatchObject({
          outcome: "sent",
          go_ahead: id,
          message: write.message,
          message_sha256: sha256(write.message),
          dry_run: false,
          source: "mcp",
        });

        // A second use of the same write is refused and sends nothing.
        const second = await gateFor(clock).execute(chatSpec(write, () => void (sends += 1)));
        expect(second.outcome).toBe("refused");
        expect(sends).toBe(1);

        // A different text never matches the go-ahead approved for the first text.
        const other: Write = { ...write, target_thing_id: 3 };
        await recordGoAhead(home.paths.goAheads, other, T0, T0 + 60_000);
        const changed = await gateFor(clock).execute(
          chatSpec({ ...other, message: "synthetic message 2" }, () => void (sends += 1)),
        );
        expect(changed.outcome).toBe("refused");
        expect(changed.refusal).toBe("go-ahead-missing");
        expect(sends).toBe(1);

        // A go-ahead consumed by a POST that then failed is used up: the retry needs a new one.
        const agent = new MockAgent();
        agent.disableNetConnect();
        // docs/api/interest.md § Errors the app matches on: the mode-phase answer, a `success: false` envelope.
        agent
          .get(API_ORIGIN)
          .intercept({ path: "/1/chat/thing/4", method: "POST" })
          .reply(200, JSON.stringify({ success: false, data: "action not allowed under current mode phase" }), {
            headers: { "content-type": "application/json" },
          });
        const { GripClient } = live().client;
        const grip = new GripClient({ dispatcher: agent, clock, env: home.env, stderr: new Sink() });
        const failing: Write = { ...write, target_thing_id: 4 };
        const failingId = await recordGoAhead(home.paths.goAheads, failing, T0, T0 + 60_000);
        await expect(
          gateFor(clock).execute(
            chatSpec(
              failing,
              () => undefined,
              () => grip.post("chat/thing/4", { message: failing.message, container_id: 1 }),
            ),
          ),
        ).rejects.toThrow("the go-ahead was used; a new one is needed to try again");
        expect(eventsFor(await readLines(home.paths.goAheads), failingId).at(-1)).toMatchObject({ event: "consumed" });
        expect((await readLines(home.paths.sendLog)).at(-1)).toMatchObject({ outcome: "failed", target_thing_id: 4 });
        const retry = await gateFor(clock).execute(chatSpec(failing, () => void (sends += 1)));
        expect(retry.refusal).toBe("go-ahead-missing");
        expect(retry.go_ahead_id).not.toBe(failingId);
        expect(sends).toBe(1);
        await agent.close();
      });

      const mismatches: { id: string; title: string; recorded: Partial<Write> }[] = [
        { id: "C4", title: "a different target", recorded: { target_thing_id: 43 } },
        { id: "C5", title: "a different container", recorded: { container_id: 2 } },
        { id: "C6", title: "a different kind", recorded: { kind: "interest.show" } },
      ];
      for (const row of mismatches) {
        it(`${row.id}: an approved go-ahead for ${row.title} with the same text gives go-ahead-missing and sends nothing`, async () => {
          const clock = manualClock(T0);
          const write: Write = {
            kind: "chat.send",
            container_id: 1,
            target_thing_id: 42,
            message: "synthetic message 1",
          };
          const recordedId = await recordGoAhead(
            home.paths.goAheads,
            { ...write, ...row.recorded },
            T0 - HOUR,
            T0 - 30 * 60_000,
          );
          let sends = 0;
          const result = await gateFor(clock).execute(chatSpec(write, () => void (sends += 1)));
          expect(result.outcome).toBe("refused");
          expect(result.refusal).toBe("go-ahead-missing");
          expect(result.go_ahead_id).not.toBe(recordedId);
          expect(sends).toBe(0);
          // The recorded go-ahead is untouched and a proposal for the write's own four fields is added.
          const lines = await readLines(home.paths.goAheads);
          expect(eventsFor(lines, recordedId).map((line) => line["event"])).toEqual(["proposed", "approved"]);
          expect(eventsFor(lines, result.go_ahead_id ?? "")).toEqual([
            expect.objectContaining({ event: "proposed", kind: "chat.send", container_id: 1, target_thing_id: 42 }),
          ]);
        });
      }

      it("C7: an approval older than 24 hours gives go-ahead-expired, sends nothing and proposes anew", async () => {
        const clock = manualClock(T0);
        const write: Write = { kind: "chat.send", container_id: 1, target_thing_id: 2, message: "synthetic message 1" };
        const approvedAt = T0 - DAY - 1000;
        const id = await recordGoAhead(home.paths.goAheads, write, approvedAt - 60_000, approvedAt);
        let sends = 0;
        const result = await gateFor(clock).execute(chatSpec(write, () => void (sends += 1)));
        expect(result.outcome).toBe("refused");
        expect(result.refusal).toBe("go-ahead-expired");
        expect(result.hint).toContain(`the go-ahead ${id} expired at `);
        expect(result.hint).toContain("; ask the user to run gripeventsctl writes go-ahead on a new proposal");
        expect(sends).toBe(0);
        const lines = await readLines(home.paths.goAheads);
        expect(eventsFor(lines, id).map((line) => line["event"])).toEqual(["proposed", "approved"]);
        expect(lines.filter((line) => line["event"] === "proposed" && line["id"] !== id)).toHaveLength(1);
      });

      it("C8: an approval 23 hours 59 minutes old is usable and the write is sent", async () => {
        const clock = manualClock(T0);
        const write: Write = { kind: "chat.send", container_id: 1, target_thing_id: 2, message: "synthetic message 1" };
        const id = await recordGoAhead(home.paths.goAheads, write, T0 - DAY, T0 - DAY + 60_000);
        let sends = 0;
        const result = await gateFor(clock).execute(chatSpec(write, () => void (sends += 1)));
        expect(result.outcome).toBe("sent");
        expect(sends).toBe(1);
        expect(eventsFor(await readLines(home.paths.goAheads), id).at(-1)).toMatchObject({ event: "consumed" });
      });
    });

    describe("process", () => {
      it.skipIf(process.platform === "win32")(
        "P17: a SIGKILL between the consume and the POST leaves the go-ahead consumed and a second attempt is refused (POSIX only: SIGKILL semantics)",
        async () => {
          const write: Write = {
            kind: "chat.send",
            container_id: 1,
            target_thing_id: 2,
            message: "synthetic message 1",
          };
          const id = await recordGoAhead(home.paths.goAheads, write, T0 - HOUR, T0 - 30 * 60_000);
          const script = join(home.dir, "gate-worker.mjs");
          await writeFile(script, WORKER_SOURCE);
          const options = {
            coreUrl: CORE_DIST,
            configFile: home.configFile,
            token: home.token,
            paths: home.paths,
            now: T0,
            write,
            hang: true,
          };
          const child = fork(script, [JSON.stringify(options)], {
            env: home.env,
            execArgv: [],
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          const exited = new Promise<NodeJS.Signals | null>((resolve) =>
            child.on("exit", (_code, signal) => resolve(signal)),
          );
          const message = (type: string) =>
            new Promise<void>((resolve, reject) => {
              child.on("message", (value: { type?: string }) => {
                if (value.type === type) resolve();
                else if (value.type === "result" || value.type === "error")
                  reject(new Error(`worker: ${JSON.stringify(value)}`));
              });
              void exited.then(() => reject(new Error(`worker exited before "${type}": ${stderr}`)));
            });

          await message("ready");
          const posting = message("posting");
          child.send({ type: "go" });
          await posting;
          const latestAtPost = eventsFor(await readLines(home.paths.goAheads), id).at(-1);
          child.kill("SIGKILL");
          expect(await exited).toBe("SIGKILL");

          expect(latestAtPost).toMatchObject({ event: "consumed", id });
          expect(eventsFor(await readLines(home.paths.goAheads), id).at(-1)).toMatchObject({ event: "consumed" });
          expect(await readLines(home.paths.sendLog)).toEqual([]);

          // The dead writer's lock is left behind; age it past the 10-second staleness window.
          const past = new Date(Date.now() - 60_000);
          for (const entry of await readdir(home.dir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.endsWith(".lock"))
              await utimes(join(home.dir, entry.name), past, past);
          }
          let sends = 0;
          const second = await gateFor(manualClock(T0 + 60_000)).execute(chatSpec(write, () => void (sends += 1)));
          expect(second.outcome).toBe("refused");
          expect(second.refusal).toBe("go-ahead-missing");
          expect(second.go_ahead_id).not.toBe(id);
          expect(sends).toBe(0);
        },
        60_000,
      );
    });
  },
);

/**
 * The worker the process case forks. It imports the built core (`packages/core/dist`), runs one
 * chat-shaped write through the gate with source `mcp`, reports `posting` from inside `send`, and
 * then hangs there, so the parent can kill it while its POST is in flight.
 */
const WORKER_SOURCE = `
import { Writable } from "node:stream";
const options = JSON.parse(process.argv[2]);
const { createWriteGate } = await import(options.coreUrl);
const session = { slug: "test-event-1", container_id: 1, token: options.token, signed_in_at: "2026-10-12T10:00:00.000Z" };
const config = { config: { version: 1, session, writes: { enabled: true } }, path: options.configFile, exists: true };
const clock = { now: () => new Date(options.now), sleep: () => Promise.resolve(), timeoutSignal: (ms) => AbortSignal.timeout(ms) };
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
process.on("message", (message) => {
  if (message?.type !== "go") return;
  const gate = createWriteGate({ config, paths: options.paths, clock, source: "mcp", stderr });
  const write = options.write;
  gate.execute({
    kind: write.kind,
    targetThingId: write.target_thing_id,
    message: write.message,
    dryRun: false,
    request: { method: "POST", path: "chat/thing/" + write.target_thing_id, body: { message: write.message, container_id: 1 } },
    send: async () => {
      process.send({ type: "posting" });
      if (options.hang) await new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, options.holdMs ?? 0));
      return { message_id: 7 };
    },
    resultFields: (result) => ({ message_id: result.message_id }),
  }).then(
    (result) => process.send({ type: "result", outcome: result.outcome, refusal: result.refusal ?? null }, () => process.exit(0)),
    (error) => process.send({ type: "error", message: String(error && error.message) }, () => process.exit(1)),
  );
});
process.send({ type: "ready" });
`;
