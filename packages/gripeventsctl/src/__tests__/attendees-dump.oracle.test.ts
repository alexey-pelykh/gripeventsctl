// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for `attendees dump` at the surface level: the export-file rules reached
 * through the real CLI program and the real MCP server (CAP-EXPORT-FILE S12 to S14), and the page
 * pause (CAP-PACING S4).
 *
 * Written before the subject existed, by a different context from the one that implements it. The
 * implementing pull request leaves this file byte-identical and makes it pass. `pnpm test` skips the
 * file while the subject is missing; `pnpm test:oracles` fails instead.
 *
 * The surface is driven the way a user and a host reach it: the CLI through the shared `runCli()`
 * harness over the real program builder, MCP through `linkMcp()` over the real server builder and the
 * SDK's in-memory transport pair. The only HTTP double is the shared `mockGrip()` agent injected as
 * the dispatcher; all time goes through an injected clock; every file lands under a temporary home.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

// ---------------------------------------------------------------------------------------------
// The contract this oracle grades: the seams the registry, config and shared-test items fix, and
// the helper shapes this oracle chooses where no item fixes them (see the comments).
// ---------------------------------------------------------------------------------------------

interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

/** The undici `MockAgent` surface the cases use, declared structurally: the umbrella has no undici dependency. */
interface MockAgentLike {
  get(origin: string): {
    intercept(opts: { path: (requestPath: string) => boolean; method: string }): {
      reply(status: number, body: string, opts: { headers: Record<string, string> }): unknown;
    };
  };
  getCallHistory(): { calls(): { fullUrl: string; method: string }[] } | undefined;
  clearCallHistory(): void;
}

/** `runCli(argv, io)`: argv holds the user arguments only; the result carries the captured streams and the exit code. */
interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface CliIo {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  dispatcher: MockAgentLike;
}

interface CallToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** `linkMcp(server)`, as the shared test helpers item fixes it. */
interface McpLink {
  client: unknown;
  listTools(): Promise<{ name: string }[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface TestingModule {
  runCli(argv: readonly string[], io: CliIo): Promise<CliRun>;
  linkMcp(server: unknown): Promise<McpLink>;
  /** Either the `MockAgent` itself or an object carrying it as `agent`; no item fixes which. */
  mockGrip(): MockAgentLike | { agent: MockAgentLike };
}

interface CommandLike {
  name(): string;
  commands: CommandLike[];
}

interface UmbrellaModule {
  buildProgram(deps?: unknown): CommandLike;
  buildServer(
    version?: string,
    deps?: { env?: NodeJS.ProcessEnv; clock?: Clock; dispatcher?: MockAgentLike; stderr?: unknown },
  ): unknown;
}

interface DumpSurface {
  umbrella: UmbrellaModule;
  testing: TestingModule;
}

type Probe = { ok: true; surface: DumpSurface } | { ok: false; missing: string };

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

async function probeSubject(): Promise<Probe> {
  const umbrella = (await import("../index.js")) as Partial<UmbrellaModule>;
  if (typeof umbrella.buildProgram !== "function" || typeof umbrella.buildServer !== "function") {
    return { ok: false, missing: "buildProgram or buildServer" };
  }
  const attendees = umbrella.buildProgram().commands.find((command) => command.name() === "attendees");
  if (attendees?.commands.find((command) => command.name() === "dump") === undefined) {
    return { ok: false, missing: "the attendees dump command" };
  }
  const testing = (await importSubject("@gripeventsctl/testing")) as Partial<TestingModule> | undefined;
  if (testing === undefined) return { ok: false, missing: "@gripeventsctl/testing" };
  for (const helper of ["runCli", "linkMcp", "mockGrip"] as const) {
    if (typeof testing[helper] !== "function") return { ok: false, missing: `${helper}() in @gripeventsctl/testing` };
  }
  return { ok: true, surface: { umbrella: umbrella as UmbrellaModule, testing: testing as TestingModule } };
}

// Oracle subject: packages/core/src/operations/attendees/dump.ts, reached through the real CLI program and the real
// MCP server (not built yet when this file was written).
const probe = await probeSubject().catch((error: unknown) => ({ ok: false as const, missing: String(error) }));
const subject = probe.ok ? probe.surface : undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  const missing = probe.ok ? "" : ` (${probe.missing})`;
  throw new Error(`oracle subject missing: packages/core/src/operations/attendees/dump.ts${missing}`);
}

// ---------------------------------------------------------------------------------------------
// Fixtures. Every envelope is built from a `docs/api/` section; every secret is generated per run.
// ---------------------------------------------------------------------------------------------

const POSIX = process.platform !== "win32";
// docs/api/README.md § Base URL: the fixed origin; the client prefixes every path with `/1/`.
const API_ORIGIN = "https://api-prod.grip.events";
const CONTAINER_ID = 1;
const SEARCH_PATH = `/1/container/${String(CONTAINER_ID)}/search/`;
const DUMP_TOOL = "gripeventsctl_attendees_dump";

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

/** Advance the clock through every page pause until the run settles. */
async function drivePauses(
  clock: ReturnType<typeof manualClock>,
  run: Promise<unknown>,
  expectedPauses: number,
): Promise<void> {
  for (let pause = 1; pause <= expectedPauses; pause += 1) {
    await waitFor(() => clock.sleeps().length === pause, `page pause ${String(pause)}`, run);
    await clock.advance(1_500);
  }
}

interface Home {
  dir: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
}

/** A temporary home holding a synthetic session, in the config shape the config item fixes. */
async function makeHome(): Promise<Home> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gripeventsctl-oracle-"));
  const configPath = path.join(dir, ".gripeventsctl.yaml");
  // The session token is generated per run (the same generator `fixtureSecrets()` uses), never a literal.
  const config = {
    version: 1,
    session: {
      slug: "testevent1",
      container_id: CONTAINER_ID,
      token: randomUUID(),
      signed_in_at: "2026-01-01T00:00:00Z",
    },
    writes: { enabled: false },
  };
  await fs.writeFile(configPath, stringify(config), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    GRIPEVENTSCTL_CONFIG_FILE: configPath,
    NO_COLOR: "1",
  };
  return { dir, env, configPath };
}

async function missing(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function pathForPage(page: number): (requestPath: string) => boolean {
  return (requestPath) => {
    if (!requestPath.startsWith(`${SEARCH_PATH}?`)) return false;
    const query = new URLSearchParams(requestPath.slice(requestPath.indexOf("?") + 1));
    return query.get("page") === String(page);
  };
}

function agentOf(grip: MockAgentLike | { agent: MockAgentLike } | undefined): MockAgentLike {
  if (grip === undefined) throw new Error("unreachable: the suite is skipped without a subject");
  return "agent" in grip ? grip.agent : grip;
}

function servePages(agent: MockAgentLike, pages: readonly (readonly number[])[]): void {
  const pool = agent.get(API_ORIGIN);
  for (const [index, ids] of pages.entries()) {
    pool
      .intercept({ path: pathForPage(index + 1), method: "GET" })
      .reply(200, searchPageEnvelope(ids), { headers: { "content-type": "application/json" } });
  }
  pool
    .intercept({ path: pathForPage(pages.length + 1), method: "GET" })
    .reply(200, searchEmptyEnvelope(), { headers: { "content-type": "application/json" } });
}

function requests(agent: MockAgentLike): { page: string | null; keys: string[]; pathname: string }[] {
  return (agent.getCallHistory()?.calls() ?? []).map((call) => {
    const url = new URL(call.fullUrl);
    return { page: url.searchParams.get("page"), keys: [...url.searchParams.keys()].sort(), pathname: url.pathname };
  });
}

function errorOf(result: CallToolResult): { kind: string; message: string; hint: string | null } {
  expect(result.isError, "the tool result must be isError").toBe(true);
  const error = (result.structuredContent as { error?: { kind: string; message: string; hint: string | null } }).error;
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("unreachable");
  return error;
}

// ---------------------------------------------------------------------------------------------
// CAP-EXPORT-FILE at the surface.
// ---------------------------------------------------------------------------------------------

describe.skipIf(subject === undefined)("[CAP-EXPORT-FILE] the export rules hold through the real CLI and MCP", () => {
  const grip = subject?.testing.mockGrip();
  let home: Home;
  let clock: ReturnType<typeof manualClock>;
  let link: McpLink | undefined;

  function agent(): MockAgentLike {
    return agentOf(grip);
  }

  async function mcp(): Promise<McpLink> {
    if (subject === undefined) throw new Error("unreachable");
    link = await subject.testing.linkMcp(
      subject.umbrella.buildServer("0.0.0", { env: home.env, clock, dispatcher: agent() }),
    );
    return link;
  }

  function cli(argv: readonly string[]): Promise<CliRun> {
    if (subject === undefined) throw new Error("unreachable");
    return subject.testing.runCli(argv, { env: home.env, clock, dispatcher: agent() });
  }

  async function workTree(marker: "directory" | "file"): Promise<string> {
    const repo = path.join(home.dir, "repo");
    await fs.mkdir(repo);
    if (marker === "directory") await fs.mkdir(path.join(repo, ".git"));
    else await fs.writeFile(path.join(repo, ".git"), "gitdir: ../elsewhere/.git\n");
    return repo;
  }

  beforeEach(async () => {
    home = await makeHome();
    clock = manualClock();
    agent().clearCallHistory();
  });

  afterEach(async () => {
    await link?.close();
    link = undefined;
    await fs.rm(home.dir, { recursive: true, force: true });
  });

  describe("surface", () => {
    it.each([["directory"], ["file"]] as const)(
      "S12: an MCP out inside a git work tree (.git %s) is refused with the usage kind, no request, no file",
      async (marker) => {
        const out = path.join(await workTree(marker), "export.jsonl");

        const result = await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out });

        const error = errorOf(result);
        expect(error.kind).toBe("usage");
        expect(error.message).toContain("inside a git work tree; choose a path outside any repository");
        expect(requests(agent())).toEqual([]);
        expect(await missing(out)).toBe(true);
      },
    );

    it("S13: a CLI --out inside a git work tree warns once on stderr and the dump proceeds", async () => {
      const out = path.join(await workTree("directory"), "export.jsonl");
      servePages(agent(), [range(1, 20)]);

      const run = cli(["attendees", "dump", "--type", "1", "--out", out]);
      await drivePauses(clock, run, 1);
      const result = await run;

      expect(result.exitCode).toBe(0);
      const warnings = lines(result.stderr).filter((line) => line.includes("work tree"));
      expect(warnings).toEqual([`${out} is inside a git work tree; do not commit it`]);
      expect(lines(await fs.readFile(out, "utf8"))).toHaveLength(20);
      expect(requests(agent()).map((request) => request.page)).toEqual(["1", "2"]);
    });

    it("S14: an MCP out at an existing file is refused with the usage kind and the file keeps its bytes", async () => {
      const out = path.join(home.dir, "export.jsonl");
      await fs.writeFile(out, "keep me\n");

      const error = errorOf(await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out }));

      expect(error.kind).toBe("usage");
      expect(error.message).toContain("already exists");
      expect(await fs.readFile(out, "utf8")).toBe("keep me\n");
      expect(requests(agent())).toEqual([]);
    });

    it.skipIf(!POSIX)(
      "S14: an MCP out at a symbolic link is refused and nothing is written through it (POSIX only: symlinks)",
      async () => {
        const target = path.join(home.dir, "target.jsonl");
        await fs.writeFile(target, "keep me\n");
        const out = path.join(home.dir, "export.jsonl");
        await fs.symlink(target, out);

        const error = errorOf(await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out }));

        expect(error.kind).toBe("usage");
        expect(await fs.readFile(target, "utf8")).toBe("keep me\n");
        expect((await fs.lstat(out)).isSymbolicLink()).toBe(true);
        expect(requests(agent())).toEqual([]);
      },
    );

    it("S14: a relative MCP out is refused with `out must be an absolute path`, no request, no file", async () => {
      const out = "relative/export.jsonl";

      const error = errorOf(await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out }));

      expect(error.kind).toBe("usage");
      expect(error.message).toContain("must be an absolute path");
      expect(requests(agent())).toEqual([]);
      expect(await missing(path.join(home.dir, "relative"))).toBe(true);
      expect(await missing(path.resolve(out))).toBe(true);
    });

    it("S14: an MCP out not ending in .jsonl is refused, naming the path, no request, no file", async () => {
      const out = path.join(home.dir, "export.json");

      const error = errorOf(await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out }));

      expect(error.kind).toBe("usage");
      expect(error.message).toContain(out);
      expect(requests(agent())).toEqual([]);
      expect(await missing(out)).toBe(true);
    });

    it("S14: an MCP out at the config path is refused, naming the path, and the config keeps its bytes", async () => {
      const before = await fs.readFile(home.configPath, "utf8");

      const error = errorOf(await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out: home.configPath }));

      expect(error.kind).toBe("usage");
      expect(error.message).toContain(home.configPath);
      expect(await fs.readFile(home.configPath, "utf8")).toBe(before);
      expect(requests(agent())).toEqual([]);
    });

    it("S14: an MCP out whose parent does not exist is refused, naming the path, no request, no directory", async () => {
      const out = path.join(home.dir, "absent", "export.jsonl");

      const error = errorOf(await (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out }));

      expect(error.kind).toBe("usage");
      expect(error.message).toContain(out);
      expect(requests(agent())).toEqual([]);
      expect(await missing(path.dirname(out))).toBe(true);
    });

    it("S14: an absolute .jsonl out outside any work tree is accepted through the MCP tool and holds the page", async () => {
      const out = path.join(home.dir, "export.jsonl");
      servePages(agent(), [range(1, 20)]);

      const call = (await mcp()).callTool(DUMP_TOOL, { type_ids: [1], out });
      await drivePauses(clock, call, 1);
      const result = await call;

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ pages: 1, entries: 20, stopped_on: "end", hint: null });
      const written = lines(await fs.readFile(out, "utf8"));
      expect(written.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual(range(1, 20));
      if (POSIX) expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
      expect((await fs.readdir(home.dir)).sort()).toEqual([".gripeventsctl.yaml", "export.jsonl"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// CAP-PACING at the surface.
// ---------------------------------------------------------------------------------------------

describe.skipIf(subject === undefined)("[CAP-PACING] dump pauses 1.5 s between pages with nothing in flight", () => {
  const grip = subject?.testing.mockGrip();
  let home: Home;
  let clock: ReturnType<typeof manualClock>;

  function agent(): MockAgentLike {
    return agentOf(grip);
  }

  beforeEach(async () => {
    home = await makeHome();
    clock = manualClock();
    agent().clearCallHistory();
  });

  afterEach(async () => {
    await fs.rm(home.dir, { recursive: true, force: true });
  });

  describe("surface", () => {
    it("S4: the CLI dump requests pages 1 to 4 in order, sleeping 1,500 ms on the clock between pages, with no request issued during a pause", async () => {
      if (subject === undefined) throw new Error("unreachable");
      const out = path.join(home.dir, "export.jsonl");
      servePages(agent(), [range(1, 20), range(21, 20), range(41, 5)]);

      const run = subject.testing.runCli(["attendees", "dump", "--type", "1", "--out", out], {
        env: home.env,
        clock,
        dispatcher: agent(),
      });

      for (const page of [1, 2, 3]) {
        await waitFor(() => clock.sleeps().length === page, `the pause after page ${String(page)}`, run);
        // The pause is pending: the page's request has been answered and the next one is not sent.
        expect(requests(agent()).map((request) => request.page)).toEqual(range(1, page).map(String));
        expect(lines(await fs.readFile(out, "utf8"))).toHaveLength(Math.min(page * 20, 45));
        expect(clock.sleeps().at(-1)).toBe(1_500);
        await clock.advance(1_499);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(requests(agent()), "no request before the full pause elapsed").toHaveLength(page);
        await clock.advance(1);
      }
      const result = await run;

      expect(result.exitCode).toBe(0);
      expect(clock.sleeps()).toEqual([1_500, 1_500, 1_500]);
      const sent = requests(agent());
      expect(sent.map((request) => request.page)).toEqual(["1", "2", "3", "4"]);
      for (const request of sent) {
        expect(request.pathname).toBe(SEARCH_PATH);
        expect(request.keys).toEqual(["page", "sort", "type_id"]);
      }
      expect(lines(result.stdout)).toEqual([`wrote 45 entries from 3 pages to ${out}`, "stopped: end"]);
      expect(lines(await fs.readFile(out, "utf8"))).toHaveLength(45);
    });
  });
});
