// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for the attendees export file (capability CAP-EXPORT-FILE, component level).
 *
 * Written before the subject existed, by a different context from the one that implements it. The
 * implementing pull request leaves this file byte-identical and makes it pass. `pnpm test` skips the
 * file while the subject module is missing; `pnpm test:oracles` fails instead.
 *
 * The rules under test: the dump file is created only where asked, exclusively, at 0600, never over
 * or through another file. The cases are numbered after the capability catalog (C1 to C11).
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------------------------
// The contract this oracle grades, as the attendees item fixes it.
// ---------------------------------------------------------------------------------------------

interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

interface Session {
  slug: string;
  container_id: number;
  token: string;
  signed_in_at: string;
  auth_failed_at?: string;
}

interface Config {
  version: 1;
  auth?: { credentials?: string };
  session?: Session;
  writes: { enabled: boolean; send_log?: string };
}

interface OperationContext {
  client: unknown;
  config: { config: Config; path: string; exists: boolean };
  clock: Clock;
  stderr: NodeJS.WritableStream;
  source: "cli" | "mcp";
  signal?: AbortSignal;
}

interface Operation {
  group: string;
  verb: string;
  run(ctx: OperationContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The exclusive create of the export file: the path checks, then `fs.open(out, "wx", 0o600)`. */
interface ExportFileModule {
  openExportFile(out: string, ctx: OperationContext): Promise<FileHandle>;
}

/** The parts of `@gripeventsctl/core`'s public interface the cases below need. */
interface CoreModule {
  API_ORIGIN: string;
  GripClient: new (opts: { dispatcher: MockAgent; clock: Clock; env: NodeJS.ProcessEnv }) => unknown;
  OPERATIONS: readonly Operation[];
  saveConfig(config: Config, opts: { env: NodeJS.ProcessEnv }): Promise<void>;
  derivedPaths(configPath: string, config: Config): { sendLog: string; goAheads: string; writeLock: string };
}

// Oracle subject: packages/core/src/operations/attendees/export-file.ts (not built yet when this file was written).
const subject = (await import("../operations/attendees/export-file.js").catch(() => undefined)) as
  ExportFileModule | undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error("oracle subject missing: packages/core/src/operations/attendees/export-file.ts");
}

const core = (await import("../index.js")) as Partial<CoreModule>;
const coreReady =
  typeof core.API_ORIGIN === "string" &&
  typeof core.GripClient === "function" &&
  Array.isArray(core.OPERATIONS) &&
  typeof core.saveConfig === "function" &&
  typeof core.derivedPaths === "function";
const ready = subject !== undefined && coreReady;

// ---------------------------------------------------------------------------------------------
// Fixtures. Every envelope is built from a `docs/api/` section; every secret is generated per run.
// ---------------------------------------------------------------------------------------------

const POSIX = process.platform !== "win32";
const CONTAINER_ID = 1;
const SEARCH_PATH = `/1/container/${String(CONTAINER_ID)}/search/`;

// docs/api/attendees.md § Directory search: `{ success: true, data: [ { id, ... } ] }`, one page of
// up to 20 entries, each carrying the thing id in `id`. The page records no other field of an entry;
// `name` stands in for one of the unrecorded fields, so the oracle sees unknown keys kept.
function searchPageEnvelope(ids: readonly number[]): string {
  return JSON.stringify({
    success: true,
    data: ids.map((id) => ({ id, name: `Test Person ${String(id)}` })),
  });
}

// docs/api/attendees.md § Directory search: "Page until `data` is an empty array."
function searchEmptyEnvelope(): string {
  return JSON.stringify({ success: true, data: [] });
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

/** A manual clock: `sleep()` resolves only when the test advances it; timeouts never fire. */
function manualClock(): Clock & { sleeps(): readonly number[]; advance(ms: number): Promise<void> } {
  let nowMs = Date.UTC(2026, 0, 1);
  const sleeps: number[] = [];
  const pending: { due: number; resolve: () => void }[] = [];
  return {
    now: () => new Date(nowMs),
    sleep(ms) {
      sleeps.push(ms);
      return new Promise<void>((resolve) => {
        pending.push({ due: nowMs + ms, resolve });
      });
    },
    timeoutSignal: () => new AbortController().signal,
    sleeps: () => sleeps,
    async advance(ms) {
      nowMs += ms;
      const due = pending.filter((entry) => entry.due <= nowMs);
      for (const entry of due) pending.splice(pending.indexOf(entry), 1);
      for (const entry of due) entry.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

function collectingStderr(): { stream: Writable; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** Poll a condition on real time; fail fast when the run under test ends before it holds. */
async function waitFor(check: () => boolean, what: string, run: Promise<unknown>): Promise<void> {
  let settled = false;
  run.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (settled) throw new Error(`the run ended before ${what}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

interface Home {
  dir: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  config: Config;
}

async function makeHome(): Promise<Home> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gripeventsctl-oracle-"));
  const configPath = path.join(dir, ".gripeventsctl.yaml");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    GRIPEVENTSCTL_CONFIG_FILE: configPath,
  };
  // The session token is generated per run (the same generator `fixtureSecrets()` uses), never a literal.
  const config: Config = {
    version: 1,
    session: {
      slug: "testevent1",
      container_id: CONTAINER_ID,
      token: randomUUID(),
      signed_in_at: "2026-01-01T00:00:00Z",
    },
    // A send log path that passes the other rules, so the tool-file rule is the one that refuses it.
    writes: { enabled: false, send_log: path.join(dir, "custom-send-log.jsonl") },
  };
  return { dir, env, configPath, config };
}

// ---------------------------------------------------------------------------------------------
// The oracle.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!ready)("[CAP-EXPORT-FILE] only where asked, exclusively, at 0600, never through another file", () => {
  let home: Home;
  let agent: MockAgent;
  let clock: ReturnType<typeof manualClock>;
  let stderr: ReturnType<typeof collectingStderr>;

  function ctx(source: "cli" | "mcp" = "cli"): OperationContext {
    if (core.GripClient === undefined) throw new Error("unreachable");
    return {
      client: new core.GripClient({ dispatcher: agent, clock, env: home.env }),
      config: { config: home.config, path: home.configPath, exists: true },
      clock,
      stderr: stderr.stream,
      source,
    };
  }

  function openExportFile(out: string, source: "cli" | "mcp" = "cli"): Promise<FileHandle> {
    if (subject === undefined) throw new Error("unreachable");
    return subject.openExportFile(out, ctx(source));
  }

  async function expectUsageRefusal(out: string, source: "cli" | "mcp" = "cli"): Promise<{ message: string }> {
    let caught: unknown;
    try {
      const handle = await openExportFile(out, source);
      await handle.close();
    } catch (error) {
      caught = error;
    }
    expect(caught, `openExportFile(${out}) must refuse`).toBeInstanceOf(Error);
    const error = caught as Error & { kind?: string };
    expect(error.kind).toBe("usage");
    return { message: error.message };
  }

  async function missing(target: string): Promise<boolean> {
    try {
      await fs.lstat(target);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  beforeEach(async () => {
    home = await makeHome();
    if (core.saveConfig === undefined) throw new Error("unreachable");
    await core.saveConfig(home.config, { env: home.env });
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableCallHistory();
    clock = manualClock();
    stderr = collectingStderr();
  });

  afterEach(async () => {
    await agent.close();
    await fs.rm(home.dir, { recursive: true, force: true });
  });

  describe("component", () => {
    it("C1: an existing file is refused with the usage kind and keeps its bytes", async () => {
      const out = path.join(home.dir, "export.jsonl");
      await fs.writeFile(out, "keep me\n");
      const before = await fs.stat(out);

      const { message } = await expectUsageRefusal(out);

      expect(message).toContain("already exists");
      const after = await fs.stat(out);
      expect(after.size).toBe(before.size);
      expect(await fs.readFile(out, "utf8")).toBe("keep me\n");
      if (POSIX) expect(after.ino).toBe(before.ino);
    });

    it.skipIf(!POSIX)(
      "C2: a symbolic link at the path is refused and its target keeps its bytes (POSIX only: symlinks)",
      async () => {
        const target = path.join(home.dir, "target.jsonl");
        await fs.writeFile(target, "keep me\n");
        const out = path.join(home.dir, "export.jsonl");
        await fs.symlink(target, out);

        const { message } = await expectUsageRefusal(out);

        expect(message).toContain("already exists");
        expect((await fs.lstat(out)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(target, "utf8")).toBe("keep me\n");
      },
    );

    it.skipIf(!POSIX)(
      "C2: a dangling symbolic link at the path is refused and nothing is created through it (POSIX only: symlinks)",
      async () => {
        const target = path.join(home.dir, "absent.jsonl");
        const out = path.join(home.dir, "export.jsonl");
        await fs.symlink(target, out);

        const { message } = await expectUsageRefusal(out);

        expect(message).toContain("already exists");
        expect((await fs.lstat(out)).isSymbolicLink()).toBe(true);
        expect(await missing(target)).toBe(true);
      },
    );

    it("C3: a relative path is refused on the MCP side with `out must be an absolute path`", async () => {
      const { message } = await expectUsageRefusal("relative/export.jsonl", "mcp");

      expect(message).toContain("must be an absolute path");
      expect(await missing(path.join(home.dir, "relative"))).toBe(true);
      expect(await missing(path.resolve("relative/export.jsonl"))).toBe(true);
    });

    it.each([["export.json"], ["export.txt"], ["export"], ["export.jsonl.bak"]])(
      "C4: a path not ending in .jsonl is refused, naming the path: %s",
      async (name) => {
        const out = path.join(home.dir, name);

        const { message } = await expectUsageRefusal(out);

        expect(message).toContain(out);
        expect(await missing(out)).toBe(true);
      },
    );

    it("C5: the config path is refused, naming the path, and the config keeps its bytes", async () => {
      const before = await fs.stat(home.configPath);

      const { message } = await expectUsageRefusal(home.configPath);

      expect(message).toContain(home.configPath);
      const after = await fs.stat(home.configPath);
      expect(after.size).toBe(before.size);
      if (POSIX) expect(after.ino).toBe(before.ino);
    });

    it.each([
      ["C6", "sendLog"],
      ["C7", "goAheads"],
      ["C8", "writeLock"],
    ] as const)("%s: the tool's own %s path is refused, naming the path, and is never created", async (_id, key) => {
      if (core.derivedPaths === undefined) throw new Error("unreachable");
      const target = core.derivedPaths(home.configPath, home.config)[key];
      expect(path.isAbsolute(target)).toBe(true);
      expect(await missing(target)).toBe(true);

      const { message } = await expectUsageRefusal(target);

      expect(message).toContain(target);
      expect(await missing(target)).toBe(true);
    });

    it.skipIf(!POSIX)(
      "C9: a new file is created at mode 0600 and is writable through the handle (POSIX only: file modes)",
      async () => {
        const out = path.join(home.dir, "export.jsonl");

        const handle = await openExportFile(out);
        try {
          const created = await fs.stat(out);
          expect(created.isFile()).toBe(true);
          expect(created.size).toBe(0);
          expect(created.mode & 0o777).toBe(0o600);
          await handle.write('{"id":1}\n');
        } finally {
          await handle.close();
        }

        expect(await fs.readFile(out, "utf8")).toBe('{"id":1}\n');
        expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
      },
    );

    it.skipIf(!POSIX)(
      "C10: a path whose parent is a symbolic link is refused and nothing lands in the link's target (POSIX only: symlinks)",
      async () => {
        const realDir = path.join(home.dir, "real");
        await fs.mkdir(realDir);
        const linkDir = path.join(home.dir, "linked");
        await fs.symlink(realDir, linkDir);
        const out = path.join(linkDir, "export.jsonl");

        const { message } = await expectUsageRefusal(out);

        expect(message).toContain(out);
        expect(await fs.readdir(realDir)).toEqual([]);
        expect(await missing(out)).toBe(true);
      },
    );

    it("C10: a path whose parent does not exist is refused, naming the path, and no directory is created", async () => {
      const out = path.join(home.dir, "absent", "export.jsonl");

      const { message } = await expectUsageRefusal(out);

      expect(message).toContain(out);
      expect(await missing(path.dirname(out))).toBe(true);
    });

    it.skipIf(!POSIX)(
      "C11: every page is appended through the one handle opened at the start, never by reopening the path (POSIX only: rename of an open file)",
      async () => {
        if (core.OPERATIONS === undefined || core.API_ORIGIN === undefined) throw new Error("unreachable");
        const dump = core.OPERATIONS.find((op) => op.group === "attendees" && op.verb === "dump");
        expect(dump, "the attendees dump operation is registered in OPERATIONS").toBeDefined();
        if (dump === undefined) throw new Error("unreachable");

        // Three pages (20, 20, 5 entries), then the empty page that ends the run:
        // docs/api/attendees.md § Directory search.
        const pages = [range(1, 20), range(21, 20), range(41, 5)];
        const pool = agent.get(core.API_ORIGIN);
        for (const [index, ids] of pages.entries()) {
          pool
            .intercept({ path: pathForPage(index + 1), method: "GET" })
            .reply(200, searchPageEnvelope(ids), { headers: { "content-type": "application/json" } });
        }
        pool
          .intercept({ path: pathForPage(4), method: "GET" })
          .reply(200, searchEmptyEnvelope(), { headers: { "content-type": "application/json" } });

        const out = path.join(home.dir, "export.jsonl");
        const moved = path.join(home.dir, "moved-away.jsonl");
        const run = dump.run(ctx("cli"), { type_ids: [1], out });

        // Page 1 is written and the first pause is pending: the file is 20 lines long.
        await waitFor(() => clock.sleeps().length === 1, "the first page pause", run);
        const afterPageOne = await fs.stat(out);
        expect(lines(await fs.readFile(out, "utf8"))).toHaveLength(20);

        // Move the file away and put a decoy at the path. A dump that reopens the path writes
        // into the decoy; a dump that keeps its handle writes into the moved file.
        await fs.rename(out, moved);
        await fs.writeFile(out, "", { mode: 0o600 });

        await clock.advance(1_500);
        await waitFor(() => clock.sleeps().length === 2, "the second page pause", run);
        await clock.advance(1_500);
        await waitFor(() => clock.sleeps().length === 3, "the third page pause", run);
        await clock.advance(1_500);
        const result = await run;

        expect(result).toMatchObject({ pages: 3, entries: 45, stopped_on: "end" });
        expect(path.isAbsolute(String(result.out))).toBe(true);
        expect(await fs.readFile(out, "utf8")).toBe("");
        const written = lines(await fs.readFile(moved, "utf8"));
        expect(written).toHaveLength(45);
        expect(written.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual(range(1, 45));
        expect((await fs.stat(moved)).ino).toBe(afterPageOne.ino);
        expect(clock.sleeps()).toEqual([1_500, 1_500, 1_500]);
      },
    );
  });
});

function pathForPage(page: number): (requestPath: string) => boolean {
  return (requestPath) => {
    if (!requestPath.startsWith(`${SEARCH_PATH}?`)) return false;
    const query = new URLSearchParams(requestPath.slice(requestPath.indexOf("?") + 1));
    return query.get("page") === String(page);
  };
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}
