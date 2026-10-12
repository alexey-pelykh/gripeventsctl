// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-GATE (S7 to S41) and CAP-GOAHEAD (S9 to S16), surface level: every
 * write precondition on the CLI path and on the MCP path, the dry run and its plan, the refusal
 * vocabulary, and the `writes go-ahead` and `writes pending` commands. It drives the real program
 * through `runCli` and the real server through `linkMcp`, over a mocked platform, in a temporary
 * home per test. The two-process case (P42) is in `write-paths-process.oracle.test.ts`.
 *
 * The write gate item (#16) ships no write operation. The three writes (`interest show`,
 * `interest skip`, `chat send`) come from the gated writes item (#17). Until `OPERATIONS` carries
 * one of them, this file registers a stand-in built here from #17's specification: the same
 * group and verb, input, request path and body, status read, message policy and exit code, calling
 * only `ctx.gate.refuse()` and `ctx.gate.execute()`. Once the real operation is registered, the same
 * assertions run against it. The implementing change leaves this file byte-identical.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The seams this oracle drives, as the related items fix them.
interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}
interface Terminal {
  isStdinTTY(): boolean;
  isStdoutTTY(): boolean;
  prompt(label: string): Promise<string>;
  promptHidden(label: string): Promise<string>;
  write(stream: unknown, text: string): void;
}
/** #7's `runCli` io; `operations` is forwarded to `buildProgram(deps)` as #16's acceptance criteria use it. */
interface RunCliIo {
  terminal: Terminal;
  dispatcher: unknown;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  operations: readonly OperationLike[];
}
interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface McpLink {
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}
interface CallLog {
  method: string;
  path: string;
  body: unknown;
}
interface MockAgentLike {
  getCallHistory(): { calls(): CallLog[] } | undefined;
  get(origin: string): {
    intercept(options: { path: string | ((path: string) => boolean); method: string }): {
      reply(status: number, body: string, options?: { headers?: Record<string, string> }): unknown;
    };
  };
}
interface TestingModule {
  runCli(argv: string[], io: RunCliIo): Promise<RunCliResult>;
  linkMcp(server: unknown): Promise<McpLink>;
  mockGrip(): MockAgentLike | { agent: MockAgentLike };
  fixtureSecrets(): { sessionToken: string; chatToken: string };
}
interface McpModule {
  buildServer(
    version: string,
    deps: {
      operations: readonly OperationLike[];
      env: NodeJS.ProcessEnv;
      clock: Clock;
      dispatcher: unknown;
      stderr: Writable;
    },
  ): unknown;
}
interface ZodSchema {
  optional(): ZodSchema;
  nullable(): ZodSchema;
  default(value: unknown): ZodSchema;
  int(): ZodSchema;
  positive(): ZodSchema;
  min(n: number): ZodSchema;
  extend(shape: Record<string, ZodSchema>): ZodSchema;
}
interface ZodApi {
  object(shape: Record<string, ZodSchema>): ZodSchema;
  number(): ZodSchema;
  string(): ZodSchema;
  boolean(): ZodSchema;
}
interface WriteGateLike {
  execute(spec: Record<string, unknown>): Promise<unknown>;
  refuse(spec: Record<string, unknown>, refusal: string, hint: string): Promise<unknown>;
}
interface ContextLike {
  client: {
    get<T>(path: string, opts?: { schema?: unknown }): Promise<T>;
    post<T>(path: string, body: unknown, opts?: { schema?: unknown }): Promise<T>;
  };
  config: { config: { session?: { container_id: number } } };
  gate: WriteGateLike;
}
interface OperationLike {
  group: string;
  verb: string;
  kind: "read" | "write";
  [key: string]: unknown;
}
interface CoreModule {
  createWriteGate: unknown;
  writeResultSchema: ZodSchema;
  OPERATIONS: readonly OperationLike[];
}

// Oracle subjects: packages/core/src/gate/gate.ts (reached through the built core, as the CLI and the
// MCP server reach it) and the shared test package (not built yet when this file was written).
const core = (await import(new URL("../../../core/dist/index.js", import.meta.url).href).catch(() => undefined)) as
  Partial<CoreModule> | undefined;
const mcpEntry = (await import("@gripeventsctl/mcp").catch(() => undefined)) as McpModule | undefined;
const testing = (await import("@gripeventsctl/testing").catch(() => undefined)) as TestingModule | undefined;
// zod, resolved where the core package resolves it, so the stand-ins share the builders' zod.
const requireFromCore = createRequire(new URL("../../../core/package.json", import.meta.url));
const zod = (await (async () => {
  const entry = join(dirname(requireFromCore.resolve("zod/package.json")), "index.js");
  return (await import(pathToFileURL(entry).href)) as { z: ZodApi };
})().catch(() => undefined)) as { z: ZodApi } | undefined;
const missing = [
  ...(typeof core?.createWriteGate !== "function" ? ["packages/core/src/gate/gate.ts"] : []),
  ...(testing === undefined ? ["packages/testing/src/index.ts"] : []),
  ...(mcpEntry === undefined || zod === undefined ? ["@gripeventsctl/mcp and zod"] : []),
];
if (missing.length > 0 && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}
const subject =
  missing.length === 0 && core !== undefined && mcpEntry !== undefined && testing !== undefined && zod !== undefined
    ? { core: core as CoreModule, mcp: mcpEntry, testing, z: zod.z }
    : undefined;

const API_ORIGIN = "https://api-prod.grip.events";
const JSON_HEADERS = { "content-type": "application/json" };
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MESSAGE = "synthetic message 1";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();
const missingHint = (id: string): string =>
  `No recorded go-ahead for this text. Ask the user to run gripeventsctl writes go-ahead ${id} in a terminal of their own (not through the host's shell, which has no TTY), then call again with the same thing id and the same text.`;

type ToolKey = "show" | "skip" | "chat";
interface WriteTool {
  group: string;
  verb: string;
  kind: string;
  tool: string;
  message: "optional" | "none" | "required";
  statusRead: boolean;
  postPath(containerId: number, thingId: number): string;
  body(containerId: number, message: string | null): unknown;
}
// #17 § interest show, § interest skip, § chat send; the paths and bodies from docs/api/interest.md
// § Send an answer and docs/api/chat-and-meetings.md § Send a chat message.
const TOOLS: Record<ToolKey, WriteTool> = {
  show: {
    group: "interest",
    verb: "show",
    kind: "interest.show",
    tool: "gripeventsctl_interest_show",
    message: "optional",
    statusRead: true,
    postPath: (c, t) => `container/${String(c)}/thing/user_id/match_manual/yes/to_thing/${String(t)}`,
    body: (_c, m) => ({ message: m ?? "" }),
  },
  skip: {
    group: "interest",
    verb: "skip",
    kind: "interest.skip",
    tool: "gripeventsctl_interest_skip",
    message: "none",
    statusRead: true,
    postPath: (c, t) => `container/${String(c)}/thing/user_id/match_manual/no/to_thing/${String(t)}`,
    body: () => ({}),
  },
  chat: {
    group: "chat",
    verb: "send",
    kind: "chat.send",
    tool: "gripeventsctl_chat_send",
    message: "required",
    statusRead: false,
    postPath: (_c, t) => `chat/thing/${String(t)}`,
    body: (c, m) => ({ message: m, container_id: c }),
  },
};

/** #17 § The message policy: a control, DEL, C1, or a direction override or isolate. */
function forbidden(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return (
    (cp <= 0x1f && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** A stand-in for one of #17's write operations; it reaches the platform only through `ctx.gate`. */
function standIn(t: WriteTool, z: ZodApi, writeResultSchema: ZodSchema): OperationLike {
  const thingId = z.number().int().positive();
  const dryRun = z.boolean().default(false);
  const message = t.message === "required" ? z.string().min(1) : z.string().optional();
  const extra: Record<string, ZodSchema> =
    t.kind === "interest.show"
      ? { connection: z.number().int().nullable().optional() }
      : t.kind === "chat.send"
        ? { message_id: z.number().int().nullable().optional() }
        : {};
  return {
    group: t.group,
    verb: t.verb,
    kind: "write",
    description: `Oracle stand-in for ${t.group} ${t.verb}, built from the gated writes item`,
    needsSession: true,
    input:
      t.message === "none"
        ? z.object({ thing_id: thingId, dry_run: dryRun })
        : z.object({ thing_id: thingId, message, dry_run: dryRun }),
    output: writeResultSchema.extend(extra),
    requests: [],
    cli: { positional: t.message === "required" ? ["thing_id", "message"] : ["thing_id"] },
    exitCode: (output: { outcome?: string }) => (output.outcome === "refused" ? 4 : 0),
    run: async (ctx: ContextLike, input: { thing_id: number; message?: string; dry_run: boolean }) => {
      const containerId = ctx.config.config.session?.container_id ?? 0;
      const text = t.message === "none" ? null : (input.message ?? null);
      const path = t.postPath(containerId, input.thing_id);
      const body = t.body(containerId, text);
      const base = {
        kind: t.kind,
        targetThingId: input.thing_id,
        message: text,
        dryRun: input.dry_run,
        request: { method: "POST", path, body },
      };
      if (text !== null) {
        const chars = [...text];
        if (chars.length > 250) {
          const hint = `the message is ${String(chars.length)} characters; the app allows at most 250, and what the server does with more is not verified`;
          return ctx.gate.refuse(base, "message-too-long", hint);
        }
        const index = chars.findIndex(forbidden);
        if (index >= 0) {
          const code = (chars[index]?.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
          const hint = `the message holds a control or direction-override character at position ${String(index)} (U+${code}); remove it and run again`;
          return ctx.gate.refuse(base, "message-characters", hint);
        }
      }
      const statusPath = `container/${String(containerId)}/thing/user_id/match/${String(input.thing_id)}/status`;
      const statusSchema = z.object({ status: z.string().min(1) });
      return ctx.gate.execute({
        ...base,
        ...(t.statusRead
          ? {
              readStatus: async () =>
                (await ctx.client.get<{ status: string }>(statusPath, { schema: statusSchema })).status,
              allowedStatus: "has_match_none",
            }
          : {}),
        send: () => ctx.client.post(path, body),
        resultFields: (r: { connection?: number; message_id?: number }) =>
          t.kind === "interest.show"
            ? { connection: r.connection ?? null }
            : t.kind === "chat.send"
              ? { message_id: r.message_id ?? null }
              : {},
      });
    },
  };
}

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

interface Home {
  dir: string;
  configFile: string;
  sendLog: string;
  journal: string;
  writeLock: string;
  env: NodeJS.ProcessEnv;
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

/** A `sent` send log line (#16 § The send log) for one write, at the time the repeat guard must name. */
function sentLine(kind: string, thingId: number): Record<string, unknown> {
  return {
    time: "2026-10-12T09:00:00Z",
    kind,
    source: "cli",
    container_id: 1,
    target_thing_id: thingId,
    status_before: kind === "chat.send" ? null : "has_match_none",
    message: null,
    message_sha256: null,
    go_ahead: null,
    dry_run: false,
    outcome: "sent",
    refusal: null,
    http_status: 201,
    response: null,
    connection: kind === "interest.show" ? 0 : null,
    message_id: null,
  };
}

/** Journal events (#16 § The go-ahead journal): a `proposed` event, plus `approved` when a time is given. */
async function recordGoAhead(
  journal: string,
  write: { kind: string; thingId: number; message: string; containerId?: number },
  proposedAt: number,
  approvedAt?: number,
): Promise<string> {
  const id = randomBytes(8).toString("base64url");
  const fields = {
    kind: write.kind,
    container_id: write.containerId ?? 1,
    target_thing_id: write.thingId,
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
  if (approvedAt !== undefined)
    await appendLine(journal, { time: iso(approvedAt), event: "approved", id, ...fields, source: "cli" });
  return id;
}

interface Scripted {
  terminal: Terminal;
  screen(): string;
  prompts: string[];
}

/** A fake terminal: settable TTY flags, a screen buffer, and answers computed from each prompt label. */
function scriptedTerminal(
  tty: { stdin: boolean; stdout: boolean },
  answer?: (label: string, attempt: number) => string | undefined,
): Scripted {
  const screen: string[] = [];
  const prompts: string[] = [];
  const ask = (label: string): Promise<string> => {
    prompts.push(label);
    screen.push(label);
    const reply = answer?.(label, prompts.length);
    return reply === undefined ? Promise.reject(new Error(`unscripted prompt: ${label}`)) : Promise.resolve(reply);
  };
  return {
    terminal: {
      isStdinTTY: () => tty.stdin,
      isStdoutTTY: () => tty.stdout,
      prompt: ask,
      promptHidden: ask,
      write: (_stream, text) => {
        screen.push(text);
      },
    },
    screen: () => screen.join("\n"),
    prompts,
  };
}

/** The four-character challenge code a prompt label carries (#16: `type <code> to send|approve, ...`). */
const codeIn = (label: string): string | undefined => /type ([a-z0-9]{4}) to /.exec(label)?.[1];

// The harness shared by the two capabilities' cases. A skipped `describe` still collects its tests,
// so nothing here dereferences a missing subject outside a test body.
const live = (): NonNullable<typeof subject> => {
  if (subject === undefined) throw new Error("unreachable: the suite is skipped without its subject");
  return subject;
};
const grip = subject?.testing.mockGrip();
const agent: MockAgentLike | undefined = grip === undefined ? undefined : "agent" in grip ? grip.agent : grip;
const secrets = subject?.testing.fixtureSecrets() ?? { sessionToken: "", chatToken: "" };
const operations: OperationLike[] = [];
if (subject !== undefined) {
  const registered = subject.core.OPERATIONS;
  operations.push(...registered);
  for (const t of Object.values(TOOLS)) {
    if (!registered.some((op) => op.group === t.group && op.verb === t.verb)) {
      operations.push(standIn(t, subject.z, subject.core.writeResultSchema));
    }
  }
}
const homes: string[] = [];
let now = T0;
let mark = 0;
const clock: Clock = {
  now: () => new Date(now),
  sleep: (ms) => {
    now += ms;
    return Promise.resolve();
  },
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};
const calls = (): CallLog[] => (agent?.getCallHistory()?.calls() ?? []).slice(mark);
const posts = (): CallLog[] => calls().filter((call) => call.method === "POST");
const pool = () => (agent as MockAgentLike).get(API_ORIGIN);

beforeEach(() => {
  now = T0;
  mark = agent?.getCallHistory()?.calls().length ?? 0;
});

afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeHome(writesEnabled: boolean, extraEnv: Record<string, string> = {}): Promise<Home> {
  const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-writes-"));
  homes.push(dir);
  const configFile = join(dir, ".gripeventsctl.yaml");
  // #4 § The config file: one session, the writes switch; the token is generated per run.
  const config = [
    "version: 1",
    "session:",
    "  slug: test-event-1",
    "  container_id: 1",
    `  token: ${secrets.sessionToken}`,
    '  signed_in_at: "2026-10-12T10:00:00.000Z"',
    "writes:",
    `  enabled: ${String(writesEnabled)}`,
    "",
  ].join("\n");
  await writeFile(configFile, config, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    USERPROFILE: dir,
    GRIPEVENTSCTL_CONFIG_FILE: configFile,
    NO_COLOR: "1",
    ...extraEnv,
  };
  for (const name of ["PATH", "SYSTEMROOT", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    dir,
    configFile,
    sendLog: join(dir, ".gripeventsctl.send-log.jsonl"),
    journal: join(dir, ".gripeventsctl.go-aheads.jsonl"),
    writeLock: join(dir, ".gripeventsctl.write.lock"),
    env,
  };
}

// docs/api/interest.md § Check the state first: `{ success: true, data: { status } }`.
function armStatus(thingId: number, status: string): void {
  pool()
    .intercept({ path: `/1/container/1/thing/user_id/match/${String(thingId)}/status`, method: "GET" })
    .reply(200, JSON.stringify({ success: true, data: { status } }), { headers: JSON_HEADERS });
}

function armPost(t: WriteTool, thingId: number): void {
  const answer =
    t.kind === "chat.send"
      ? // docs/api/chat-and-meetings.md § Send a chat message: HTTP 200 with the new message's id.
        { status: 200, data: { message_id: 7 } }
      : // docs/api/interest.md § Response: HTTP 201, `connection` 0 when no mutual connection was made.
        { status: 201, data: { message: "action recorded - swipe message created or updated", connection: 0 } };
  pool()
    .intercept({ path: `/1/${t.postPath(1, thingId)}`, method: "POST" })
    .reply(answer.status, JSON.stringify({ success: true, data: answer.data }), { headers: JSON_HEADERS });
}

// The two reads `writes go-ahead` makes: docs/api/containers.md § Config by slug and
// docs/api/attendees.md § The per-person profile. Field names from the pages; values synthetic.
function armApprovalReads(thingId: number): void {
  const lookup = {
    container: { general: { display_name: "Test Event 1", name: "test-event-1", active: 1 } },
    application: {
      general: { application_name: "Example Org 1", application_id: 1, token: randomBytes(16).toString("hex") },
      permissions: { type_permissions: {} },
    },
  };
  pool()
    .intercept({ path: (p) => p.startsWith("/1/config?") && p.includes("container_name=test-event-1"), method: "GET" })
    .reply(200, JSON.stringify({ success: true, data: lookup }), { headers: JSON_HEADERS });
  const profile = {
    id: thingId,
    name: `Test Person ${String(thingId)}`,
    rtm: {},
    rtm_raw: {},
    sessions: { speaker: [] },
    common_containers: [],
    common_connections_count: 0,
    rtm_score: 0,
  };
  pool()
    .intercept({ path: `/1/container/1/thing/${String(thingId)}`, method: "GET" })
    .reply(200, JSON.stringify({ success: true, data: profile }), { headers: JSON_HEADERS });
}

async function cli(home: Home, argv: string[], term: Scripted = scriptedTerminal({ stdin: false, stdout: false })) {
  const run = await live().testing.runCli(argv, {
    terminal: term.terminal,
    dispatcher: agent,
    clock,
    env: home.env,
    operations,
  });
  return { ...run, screen: term.screen(), prompts: term.prompts };
}

async function mcp(home: Home, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = live().mcp.buildServer("0.0.0", {
    operations,
    env: home.env,
    clock,
    dispatcher: agent,
    stderr: new Capture(),
  });
  const link = await live().testing.linkMcp(server);
  try {
    return await link.callTool(tool, args);
  } finally {
    await link.close();
  }
}

function cliArgs(t: WriteTool, thingId: number, message?: string, dryRun = false): string[] {
  const args = [t.group, t.verb, String(thingId)];
  if (t.message === "required") args.push(message ?? MESSAGE);
  else if (t.message === "optional" && message !== undefined) args.push("--message", message);
  if (dryRun) args.push("--dry-run");
  return args;
}

function toolArgs(t: WriteTool, thingId: number, message?: string, dryRun = false): Record<string, unknown> {
  return {
    thing_id: thingId,
    ...(t.message === "required" ? { message: message ?? MESSAGE } : {}),
    ...(t.message === "optional" && message !== undefined ? { message } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
}

interface Outcome {
  result: Record<string, unknown>;
  exitCode?: number;
  isError?: boolean;
  texts: string[];
}

/** One write on one path; the CLI with `--json` and a non-TTY terminal unless one is given. */
async function write(
  home: Home,
  path: "cli" | "mcp",
  t: WriteTool,
  thingId: number,
  opts: { message?: string; dryRun?: boolean; term?: Scripted } = {},
): Promise<Outcome> {
  if (path === "cli") {
    const run = await cli(home, ["--json", ...cliArgs(t, thingId, opts.message, opts.dryRun)], opts.term);
    const result = run.stdout.trim() === "" ? {} : (JSON.parse(run.stdout) as Record<string, unknown>);
    return { result, exitCode: run.exitCode, texts: [run.stdout, run.stderr, run.screen] };
  }
  const outcome = await mcp(home, t.tool, toolArgs(t, thingId, opts.message, opts.dryRun));
  const text = outcome.content.map((block) => block.text ?? "").join("\n");
  return {
    result: outcome.structuredContent ?? {},
    isError: outcome.isError === true,
    texts: [text, JSON.stringify(outcome.structuredContent)],
  };
}

function expectRefused(out: Outcome, refusal: string): void {
  expect(out.result["outcome"]).toBe("refused");
  expect(out.result["refusal"]).toBe(refusal);
  if (out.exitCode !== undefined) expect(out.exitCode).toBe(4);
  if (out.isError !== undefined) expect(out.isError).toBe(false);
}

describe.skipIf(subject === undefined)(
  "[CAP-GATE] no write request leaves the process unless writes are enabled, the repeat guard is clear and a needed go-ahead is recorded, on both paths",
  () => {
    describe("surface", () => {
      type Unmet = "writes-off" | "repeat" | "no-go-ahead";
      const rows: { id: string; tool: ToolKey; path: "cli" | "mcp"; unmet: Unmet }[] = [
        ...(["show", "skip", "chat"] as const).flatMap((tool, i) => [
          { id: `S${String(7 + 2 * i)}`, tool, path: "cli" as const, unmet: "writes-off" as const },
          { id: `S${String(8 + 2 * i)}`, tool, path: "mcp" as const, unmet: "writes-off" as const },
        ]),
        ...(["show", "skip", "chat"] as const).flatMap((tool, i) => [
          { id: `S${String(13 + 2 * i)}`, tool, path: "cli" as const, unmet: "repeat" as const },
          { id: `S${String(14 + 2 * i)}`, tool, path: "mcp" as const, unmet: "repeat" as const },
        ]),
        { id: "S19", tool: "show", path: "cli", unmet: "no-go-ahead" },
        { id: "S20", tool: "show", path: "mcp", unmet: "no-go-ahead" },
        { id: "S21", tool: "chat", path: "cli", unmet: "no-go-ahead" },
        { id: "S22", tool: "chat", path: "mcp", unmet: "no-go-ahead" },
      ];
      const refusalOf: Record<Unmet, string> = {
        "writes-off": "safe-mode",
        repeat: "repeat-guard",
        "no-go-ahead": "go-ahead-missing",
      };

      for (const row of rows) {
        const t = TOOLS[row.tool];
        it(`${row.id}: ${t.group} ${t.verb} on the ${row.path.toUpperCase()} path with the precondition "${row.unmet}" unmet is refused with no POST and names the next step`, async () => {
          const home = await makeHome(row.unmet !== "writes-off");
          const message = t.message === "none" ? undefined : MESSAGE;
          if (row.unmet === "repeat") await appendLine(home.sendLog, sentLine(t.kind, 2));
          if (row.unmet === "no-go-ahead" && t.statusRead) armStatus(2, "has_match_none");
          const before = (await readLines(home.sendLog)).length;

          const out = await write(home, row.path, t, 2, message === undefined ? {} : { message });

          expectRefused(out, refusalOf[row.unmet]);
          expect(posts()).toHaveLength(0);
          // Safe mode and the repeat guard refuse before the status read; the go-ahead check comes after it.
          expect(calls()).toHaveLength(row.unmet === "no-go-ahead" && t.statusRead ? 1 : 0);
          const hint = String(out.result["hint"]);
          const lines = await readLines(home.sendLog);
          expect(lines).toHaveLength(before + 1);
          expect(lines.at(-1)).toMatchObject({
            kind: t.kind,
            target_thing_id: 2,
            container_id: 1,
            source: row.path,
            outcome: "refused",
            refusal: refusalOf[row.unmet],
            dry_run: false,
            go_ahead: null,
            http_status: null,
          });
          const journal = await readLines(home.journal);
          if (row.unmet === "writes-off") {
            expect(hint).toBe(`set writes.enabled: true in ${home.configFile} to leave safe mode`);
            expect(journal).toEqual([]);
          } else if (row.unmet === "repeat") {
            expect(hint).toContain("repeat guard");
            expect(hint).toContain("2026-10-12T09:00:00Z");
            expect(journal).toEqual([]);
          } else {
            const id = String(out.result["go_ahead_id"]);
            expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
            expect(hint).toBe(missingHint(id));
            expect(Date.parse(String(out.result["go_ahead_expires_at"]))).toBe(T0 + DAY);
            expect(journal).toEqual([
              expect.objectContaining({
                event: "proposed",
                id,
                kind: t.kind,
                container_id: 1,
                target_thing_id: 2,
                message: MESSAGE,
                message_sha256: sha256(MESSAGE),
                source: row.path,
              }),
            ]);
          }
        });
      }

      for (const row of [
        { id: "S23", path: "cli" as const },
        { id: "S24", path: "mcp" as const },
      ]) {
        it(`${row.id}: a dry run in safe mode on the ${row.path.toUpperCase()} path reads the status, sends no POST and reports the plan and every verdict`, async () => {
          const home = await makeHome(false);
          armStatus(2, "has_match_none");
          const out = await write(home, row.path, TOOLS.show, 2, { message: MESSAGE, dryRun: true });

          // The first failing verdict is the switch, so the dry run is refused with safe-mode.
          expectRefused(out, "safe-mode");
          expect(out.result["plan"]).toMatchObject({
            kind: "interest.show",
            container_id: 1,
            target_thing_id: 2,
            request: {
              method: "POST",
              path: "container/1/thing/user_id/match_manual/yes/to_thing/2",
              body: { message: MESSAGE },
            },
            status_before: "has_match_none",
            verdicts: { writes_enabled: false, repeat_guard: "clear", status: "allowed", go_ahead: "missing" },
          });
          expect(calls().map((call) => call.method)).toEqual(["GET"]);
          expect((await readLines(home.sendLog)).at(-1)).toMatchObject({
            dry_run: true,
            outcome: "refused",
            refusal: "safe-mode",
            status_before: "has_match_none",
          });
          expect(await readLines(home.journal)).toEqual([]);
          if (row.path === "cli") {
            armStatus(2, "has_match_none");
            const human = await cli(home, cliArgs(TOOLS.show, 2, MESSAGE, true));
            expect(human.exitCode).toBe(4);
            expect(human.stdout).toContain("container/1/thing/user_id/match_manual/yes/to_thing/2");
            expect(posts()).toHaveLength(0);
          }
        });
      }

      it("S25: the plan's request equals the request the POST sends: method, path and body", async () => {
        const home = await makeHome(true);
        await recordGoAhead(
          home.journal,
          { kind: "chat.send", thingId: 2, message: MESSAGE },
          T0 - HOUR,
          T0 - 30 * 60_000,
        );
        armPost(TOOLS.chat, 2);
        const out = await write(home, "mcp", TOOLS.chat, 2, { message: MESSAGE });
        expect(out.result["outcome"]).toBe("sent");
        const plan = out.result["plan"] as { request: { method: string; path: string; body: unknown } };
        expect(plan.request).toEqual({
          method: "POST",
          path: "chat/thing/2",
          body: { message: MESSAGE, container_id: 1 },
        });
        const sent = posts();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.method).toBe(plan.request.method);
        expect(sent[0]?.path).toBe(`/1/${plan.request.path}`);
        const body = sent[0]?.body;
        expect(typeof body === "string" ? JSON.parse(body) : body).toEqual(plan.request.body);
      });

      it("S26: the plan shows no secret: a registered token in a dry-run text is redacted in every output form", async () => {
        const home = await makeHome(true);
        const message = `${MESSAGE} ${secrets.sessionToken}`;
        const forms: string[] = [];
        for (const path of ["cli", "mcp"] as const) {
          armStatus(2, "has_match_none");
          const out = await write(home, path, TOOLS.show, 2, { message, dryRun: true });
          const plan = out.result["plan"] as { request: { body: { message: string } } };
          expect(plan.request.body.message).toContain("<REDACTED>");
          forms.push(...out.texts);
        }
        armStatus(2, "has_match_none");
        const human = await cli(home, cliArgs(TOOLS.show, 2, message, true));
        forms.push(human.stdout, human.stderr);
        for (const form of forms) expect(form).not.toContain(secrets.sessionToken);
        expect(posts()).toHaveLength(0);
      });

      it("S27: no environment variable enables writes for one call", async () => {
        const home = await makeHome(false, {
          GRIPEVENTSCTL_WRITES: "1",
          GRIPEVENTSCTL_WRITES_ENABLED: "true",
          WRITES_ENABLED: "1",
        });
        expectRefused(await write(home, "cli", TOOLS.show, 2), "safe-mode");
        expectRefused(await write(home, "mcp", TOOLS.show, 2), "safe-mode");
        expect(calls()).toHaveLength(0);
      });

      it("S28: no CLI flag enables writes for one call: an unknown flag is Commander's usage error, exit 2", async () => {
        const home = await makeHome(false);
        for (const flag of ["--writes-enabled", "--enable-writes", "--yes"]) {
          const run = await cli(home, ["--json", ...cliArgs(TOOLS.skip, 2), flag]);
          // #7 § Errors and exit codes: Commander's own usage errors exit 2.
          expect(run.exitCode).toBe(2);
          expect(run.stdout).toBe("");
        }
        expect(calls()).toHaveLength(0);
        expect((await readLines(home.sendLog)).filter((line) => line["outcome"] !== "refused")).toEqual([]);
      });

      it("S29: no MCP argument enables writes for one call: an unknown key is stripped and the write is refused with safe-mode", async () => {
        const home = await makeHome(false);
        // #9 § The MCP builder: the input schema is the operation's own zod object, which drops unknown keys.
        const result = await mcp(home, TOOLS.skip.tool, { thing_id: 2, writes_enabled: true, safe_mode: false });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ outcome: "refused", refusal: "safe-mode" });
        expect(calls()).toHaveLength(0);
      });

      for (const row of [
        { id: "S30", tool: "show" as const },
        { id: "S31", tool: "skip" as const },
      ]) {
        it(`${row.id}: MCP ${TOOLS[row.tool].group} ${TOOLS[row.tool].verb} without a message passes the switch, the guard and the status only (value open: no go-ahead rule decided for a message-less write; asserts the status quo)`, async () => {
          const home = await makeHome(true);
          armStatus(2, "has_match_none");
          armPost(TOOLS[row.tool], 2);
          const out = await write(home, "mcp", TOOLS[row.tool], 2);
          expect(out.result["outcome"]).toBe("sent");
          expect(out.result["plan"]).toMatchObject({ verdicts: { go_ahead: "not-needed" } });
          expect(posts()).toHaveLength(1);
          expect((await readLines(home.sendLog)).at(-1)).toMatchObject({
            outcome: "sent",
            go_ahead: null,
            message: null,
            status_before: "has_match_none",
            source: "mcp",
          });
          expect(await readLines(home.journal)).toEqual([]);
        });
      }

      it("S32: a refused dry run exits 4 and a passing dry run exits 0", async () => {
        armStatus(2, "has_match_none");
        const refused = await cli(await makeHome(false), ["--json", ...cliArgs(TOOLS.skip, 2, undefined, true)]);
        expect(refused.exitCode).toBe(4);
        expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: "refused", refusal: "safe-mode" });
        armStatus(2, "has_match_none");
        const passing = await cli(await makeHome(true), ["--json", ...cliArgs(TOOLS.skip, 2, undefined, true)]);
        expect(passing.exitCode).toBe(0);
        expect(JSON.parse(passing.stdout)).toMatchObject({ outcome: "dry-run" });
        expect(posts()).toHaveLength(0);
      });

      const vocabulary: {
        id: string;
        refusal: string;
        term?: string;
        arrange: (home: Home) => Promise<{ message?: string; release?: () => Promise<void> }>;
        hint: (hint: string, home: Home) => void;
      }[] = [
        {
          id: "S33",
          refusal: "safe-mode",
          term: "safe mode",
          arrange: () => Promise.resolve({}),
          hint: (h, home) => expect(h).toBe(`set writes.enabled: true in ${home.configFile} to leave safe mode`),
        },
        {
          id: "S34",
          refusal: "repeat-guard",
          term: "repeat guard",
          arrange: async (home) => {
            await appendLine(home.sendLog, sentLine("interest.show", 2));
            return {};
          },
          hint: (h) => expect(h).toContain("2026-10-12T09:00:00Z"),
        },
        {
          id: "S35",
          refusal: "go-ahead-missing",
          term: "recorded go-ahead",
          arrange: () => {
            armStatus(2, "has_match_none");
            return Promise.resolve({ message: MESSAGE });
          },
          hint: (h) =>
            expect(h).toMatch(
              /^No recorded go-ahead for this text\. Ask the user to run gripeventsctl writes go-ahead [A-Za-z0-9_-]{11} in a terminal/,
            ),
        },
        {
          id: "S36",
          refusal: "go-ahead-expired",
          arrange: async (home) => {
            await recordGoAhead(
              home.journal,
              { kind: "interest.show", thingId: 2, message: MESSAGE },
              T0 - DAY - HOUR,
              T0 - DAY - 1000,
            );
            armStatus(2, "has_match_none");
            return { message: MESSAGE };
          },
          hint: (h) =>
            expect(h).toMatch(
              /^the go-ahead [A-Za-z0-9_-]{11} expired at .+; ask the user to run gripeventsctl writes go-ahead on a new proposal$/,
            ),
        },
        {
          id: "S37",
          refusal: "message-too-long",
          arrange: () => Promise.resolve({ message: "a".repeat(251) }),
          hint: (h) =>
            expect(h).toBe(
              "the message is 251 characters; the app allows at most 250, and what the server does with more is not verified",
            ),
        },
        {
          id: "S38",
          refusal: "message-characters",
          arrange: () => Promise.resolve({ message: "synthetic\u202emessage" }),
          hint: (h) =>
            expect(h).toMatch(
              /^the message holds a control or direction-override character at position (9|10) \(U\+202E\); remove it and run again$/,
            ),
        },
        {
          id: "S39",
          refusal: "status-not-none",
          arrange: () => {
            armStatus(2, "has_match_yes");
            return Promise.resolve({});
          },
          hint: (h) =>
            expect(h).toBe(
              "the status is has_match_yes; this tool posts only to has_match_none, so an answer you set in the app stays as you set it",
            ),
        },
        {
          id: "S40",
          refusal: "write-busy",
          arrange: async (home) => {
            const lockfile = requireFromCore("proper-lockfile") as {
              lock(file: string, options: { realpath: boolean }): Promise<() => Promise<void>>;
            };
            return { release: await lockfile.lock(home.writeLock, { realpath: false }) };
          },
          hint: (h, home) =>
            expect(h).toContain(`another write holds ${home.writeLock}; wait for it to finish and run again`),
        },
      ];

      for (const row of vocabulary) {
        it(`${row.id}: the ${row.refusal} refusal uses the fixed vocabulary and shows no secret`, async () => {
          const home = await makeHome(row.refusal !== "safe-mode");
          const arranged = await row.arrange(home);
          let out: Outcome;
          try {
            out = await write(
              home,
              "mcp",
              TOOLS.show,
              2,
              arranged.message === undefined ? {} : { message: arranged.message },
            );
          } finally {
            await arranged.release?.();
          }
          expectRefused(out, row.refusal);
          expect(posts()).toHaveLength(0);
          const hint = String(out.result["hint"]);
          row.hint(hint, home);
          if (row.term !== undefined) expect(hint).toContain(row.term);
          // The fixed terms are written as words; their hyphenated or run-together forms never appear in prose.
          const prose = hint.split(home.dir).join("<home>");
          for (const variant of [
            "safe-mode",
            "safemode",
            "repeat-guard",
            "send-log",
            "sendlog",
            "writes-enabled",
            "read-only mode",
          ]) {
            expect(prose).not.toContain(variant);
          }
          for (const text of out.texts) {
            expect(text).not.toContain(secrets.sessionToken);
            expect(text).not.toContain(secrets.chatToken);
          }
        }, 30_000);
      }

      it("S41: after the user deletes a sent line, interest show is still refused by the status read with status-not-none", async () => {
        const home = await makeHome(true);
        armStatus(2, "has_match_none");
        armPost(TOOLS.show, 2);
        expect((await write(home, "mcp", TOOLS.show, 2)).result["outcome"]).toBe("sent");
        const kept = (await readLines(home.sendLog)).filter((line) => line["outcome"] !== "sent");
        await writeFile(home.sendLog, kept.map((line) => JSON.stringify(line) + "\n").join(""));
        armStatus(2, "has_match_yes");
        const out = await write(home, "mcp", TOOLS.show, 2);
        expectRefused(out, "status-not-none");
        expect(posts()).toHaveLength(1);
        expect((await readLines(home.sendLog)).at(-1)).toMatchObject({
          outcome: "refused",
          refusal: "status-not-none",
          status_before: "has_match_yes",
        });
      });
    });
  },
);

describe.skipIf(subject === undefined)(
  "[CAP-GOAHEAD] a go-ahead is an act only a terminal user performs, matches one exact write, expires, and is consumed before the POST",
  () => {
    describe("surface", () => {
      const tty = { stdin: true, stdout: true };
      const approve = (label: string): string | undefined => codeIn(label);

      for (const row of [
        { id: "S9", flags: { stdin: false, stdout: true }, what: "stdin" },
        { id: "S10", flags: { stdin: true, stdout: false }, what: "stdout" },
      ]) {
        it(`${row.id}: writes go-ahead with a non-TTY ${row.what} appends nothing, makes no platform call and exits 2`, async () => {
          const home = await makeHome(true);
          const id = await recordGoAhead(home.journal, { kind: "chat.send", thingId: 2, message: MESSAGE }, T0 - HOUR);
          const before = await readFile(home.journal, "utf8");
          const run = await cli(home, ["writes", "go-ahead", id], scriptedTerminal(row.flags, approve));
          expect(run.exitCode).toBe(2);
          expect(run.stderr).toContain(
            "writes go-ahead needs a terminal on stdin and stdout; run it in a terminal of your own, not through an assistant's shell",
          );
          expect(run.prompts).toEqual([]);
          expect(await readFile(home.journal, "utf8")).toBe(before);
          expect(calls()).toHaveLength(0);
        });
      }

      it("S11: a wrong challenge code appends nothing and the command exits 2 after its attempts (value open: three attempts in all, or one and three retries)", async () => {
        const home = await makeHome(true);
        const id = await recordGoAhead(home.journal, { kind: "chat.send", thingId: 2, message: MESSAGE }, T0 - HOUR);
        const before = await readFile(home.journal, "utf8");
        armApprovalReads(2);
        const wrong = (label: string, attempt: number): string | undefined => {
          const code = codeIn(label) ?? "";
          return ["y", "yes", /[a-z]/.test(code) ? code.toUpperCase() : "0000", ""][attempt - 1];
        };
        const run = await cli(home, ["writes", "go-ahead", id], scriptedTerminal(tty, wrong));
        expect(run.exitCode).toBe(2);
        expect([3, 4]).toContain(run.prompts.length);
        expect(await readFile(home.journal, "utf8")).toBe(before);
      });

      it("S12: the right code appends one approved event from the cli and prints recorded with the next step", async () => {
        const home = await makeHome(true);
        const id = await recordGoAhead(home.journal, { kind: "chat.send", thingId: 2, message: MESSAGE }, T0 - HOUR);
        armApprovalReads(2);
        const run = await cli(home, ["writes", "go-ahead", id], scriptedTerminal(tty, approve));
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("recorded");
        expect(
          ["call the tool again with the same thing id and the same text", "run the write again"].some((step) =>
            run.stdout.includes(step),
          ),
        ).toBe(true);
        const events = (await readLines(home.journal)).filter((line) => line["id"] === id);
        expect(events.map((line) => line["event"])).toEqual(["proposed", "approved"]);
        expect(events[1]).toMatchObject({
          source: "cli",
          kind: "chat.send",
          container_id: 1,
          target_thing_id: 2,
          message_sha256: sha256(MESSAGE),
        });
        expect(Date.parse(String(events[1]?.["time"]))).toBe(T0);

        const second = await recordGoAhead(
          home.journal,
          { kind: "chat.send", thingId: 3, message: MESSAGE },
          T0 - HOUR,
        );
        armApprovalReads(3);
        const json = await cli(home, ["--json", "writes", "go-ahead", second], scriptedTerminal(tty, approve));
        const printed = JSON.parse(json.stdout) as { id: string; approved_at: string };
        expect(printed.id).toBe(second);
        expect(Date.parse(printed.approved_at)).toBe(T0);
      });

      it("S13: the approval prompt shows the kind in words, the event, the target, the escaped text, its length and the hash prefix", async () => {
        const home = await makeHome(true);
        const text = "synthetic message 1 \u001b[2J\u202e\u200b";
        const id = await recordGoAhead(home.journal, { kind: "interest.show", thingId: 2, message: text }, T0 - HOUR);
        armApprovalReads(2);
        const run = await cli(home, ["writes", "go-ahead", id], scriptedTerminal(tty, approve));
        expect(run.exitCode).toBe(0);
        const seen = [run.screen, run.stdout, run.stderr].join("\n");
        expect(seen).toContain("show interest in");
        expect(seen.includes("Test Event 1") || seen.includes("test-event-1")).toBe(true);
        expect(seen).toContain("Test Person 2");
        expect(seen).toContain("synthetic message 1 \\x1b[2J\\u{202e}\\u{200b}");
        for (const raw of ["\u001b", "\u202e", "\u200b"]) expect(seen).not.toContain(raw);
        expect(seen).toContain(String([...text].length));
        expect(seen).toContain(sha256(text).slice(0, 8));
        expect(run.prompts.some((label) => /type [a-z2-9]{4} to approve, or anything else to cancel/.test(label))).toBe(
          true,
        );
      });

      it("S14: the CLI confirmation at a terminal is logged as terminal-confirmation and never touches the journal", async () => {
        const home = await makeHome(true);
        const text = `${MESSAGE}\u200b`;
        armPost(TOOLS.chat, 2);
        const confirmed = await write(home, "cli", TOOLS.chat, 2, {
          message: text,
          term: scriptedTerminal(tty, approve),
        });
        expect(confirmed.exitCode).toBe(0);
        expect(confirmed.result["outcome"]).toBe("sent");
        expect(posts()).toHaveLength(1);
        expect((await readLines(home.sendLog)).at(-1)).toMatchObject({
          outcome: "sent",
          go_ahead: "terminal-confirmation",
          message_sha256: sha256(text),
        });
        const screen = `${String(confirmed.texts[1])}\n${String(confirmed.texts[2])}`;
        expect(screen).toContain("send a chat message to");
        expect(screen).toContain("\\u{200b}");
        expect(screen).not.toContain("\u200b");
        expect(screen).toMatch(/type [a-z2-9]{4} to send, or anything else to cancel/);
        await expect(stat(home.journal)).rejects.toThrow();

        const declined = await write(home, "cli", TOOLS.chat, 3, {
          message: text,
          term: scriptedTerminal(tty, () => "y"),
        });
        expectRefused(declined, "go-ahead-missing");
        expect(String(declined.result["hint"])).toContain("not confirmed; nothing was sent");
        expect(posts()).toHaveLength(1);
        await expect(stat(home.journal)).rejects.toThrow();
      });

      it("S15: the proposal flow end to end on MCP: dry run, refusal with an id, approval at a terminal, the same text sent, a changed text refused", async () => {
        const home = await makeHome(true);
        // 1. The dry run sends nothing and proposes nothing. #16 § execute() step 7: its go-ahead verdict is
        // missing, so it is refused with go-ahead-missing (the Specification binds over the flow criterion).
        const dry = await write(home, "mcp", TOOLS.chat, 2, { message: MESSAGE, dryRun: true });
        expectRefused(dry, "go-ahead-missing");
        expect(dry.result["plan"]).toMatchObject({ verdicts: { go_ahead: "missing" } });
        expect(await readLines(home.journal)).toEqual([]);
        // 2. The real call is refused with an id.
        const refused = await write(home, "mcp", TOOLS.chat, 2, { message: MESSAGE });
        expectRefused(refused, "go-ahead-missing");
        const id = String(refused.result["go_ahead_id"]);
        // 3. The user approves at a terminal of their own.
        armApprovalReads(2);
        const approval = await cli(home, ["writes", "go-ahead", id], scriptedTerminal(tty, approve));
        expect(approval.exitCode).toBe(0);
        expect(approval.stdout).toContain("recorded");
        // 4. The same call is sent, and the go-ahead is consumed.
        armPost(TOOLS.chat, 2);
        const sent = await write(home, "mcp", TOOLS.chat, 2, { message: MESSAGE });
        expect(sent.result["outcome"]).toBe("sent");
        expect(posts()).toHaveLength(1);
        expect(
          (await readLines(home.journal)).filter((line) => line["id"] === id).map((line) => line["event"]),
        ).toEqual(["proposed", "approved", "consumed"]);
        expect((await readLines(home.sendLog)).at(-1)).toMatchObject({
          outcome: "sent",
          go_ahead: id,
          http_status: 200,
          response: null,
        });
        // 5. A changed text to the same person is refused; the repeat guard comes before the go-ahead check.
        const changed = await write(home, "mcp", TOOLS.chat, 2, { message: "synthetic message 2" });
        expectRefused(changed, "repeat-guard");
        expect(posts()).toHaveLength(1);
      });

      it("S16: writes pending lists the unexpired proposed records oldest first on both paths", async () => {
        const home = await makeHome(true);
        const first = await recordGoAhead(
          home.journal,
          { kind: "chat.send", thingId: 2, message: MESSAGE },
          T0 - 2 * HOUR,
        );
        const second = await recordGoAhead(
          home.journal,
          { kind: "interest.show", thingId: 3, message: "synthetic message 2" },
          T0 - HOUR,
        );
        await recordGoAhead(
          home.journal,
          { kind: "chat.send", thingId: 4, message: MESSAGE },
          T0 - 3 * HOUR,
          T0 - 2 * HOUR,
        );
        await recordGoAhead(home.journal, { kind: "chat.send", thingId: 5, message: MESSAGE }, T0 - DAY - HOUR);
        const expected = [
          { id: first, kind: "chat.send", target_thing_id: 2, message: MESSAGE, proposed_at: iso(T0 - 2 * HOUR) },
          {
            id: second,
            kind: "interest.show",
            target_thing_id: 3,
            message: "synthetic message 2",
            proposed_at: iso(T0 - HOUR),
          },
        ];
        const json = await cli(home, ["--json", "writes", "pending"]);
        expect(json.exitCode).toBe(0);
        expect(JSON.parse(json.stdout)).toEqual(expected);
        expect((await mcp(home, "gripeventsctl_writes_pending", {})).structuredContent).toEqual({ items: expected });
        const human = await cli(home, ["writes", "pending"]);
        expect(
          human.stdout.trimEnd().endsWith("Approve one with gripeventsctl writes go-ahead <id> in a terminal."),
        ).toBe(true);
        const empty = await cli(await makeHome(true), ["writes", "pending"]);
        expect(empty.exitCode).toBe(0);
        expect(empty.stdout).toContain("no go-aheads pending");
        expect(calls()).toHaveLength(0);
      });
    });
  },
);
