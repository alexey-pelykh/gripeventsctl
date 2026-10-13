// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-WRITES, surface level, cases S13 to S21: the three gated writes send
 * the documented bodies, report the platform's answer, stop at the swipe cap, log a failed POST
 * with its reason, and refuse a second send with a new text. The sibling file
 * `writes.oracle.test.ts` carries S1 to S12 (the status read first, no POST past a non-none
 * status, the message policy) at the same surface level; the capability's 21 cases are split in
 * two files only to keep each file readable, and both files carry the same harness. It drives the
 * real CLI program (`runCli`) and the real MCP
 * server (`linkMcp`) with writes enabled, over a mocked platform, in a temporary home created per
 * test, on a fixed clock, with a fake terminal that types back the challenge code the screen shows.
 * The gate's own preconditions (safe mode, the repeat guard, the go-ahead flow) are the write gate
 * item's oracle, not this one; this file reaches them only as seams. The implementing pull request
 * leaves this file byte-identical.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The contract this oracle grades, as the related items fix it in their Specifications.
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
interface RunCliIo {
  terminal: Terminal;
  dispatcher: unknown;
  clock: Clock;
  env: NodeJS.ProcessEnv;
}
interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: unknown;
}
interface McpModule {
  buildServer(
    version?: string,
    deps?: { env?: NodeJS.ProcessEnv; clock?: Clock; dispatcher?: unknown; stderr?: Writable },
  ): unknown;
}
interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface McpLink {
  listTools(): Promise<{ name: string }[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}
// One entry of undici's `MockCallHistory.calls()` (undici 8.11.2, `lib/mock/mock-call-history.js`).
interface CallLog {
  method: string;
  path: string;
  fullUrl?: string;
  searchParams: Record<string, string>;
  headers: Record<string, string | string[]> | undefined;
  body: unknown;
}
interface MockAgentLike {
  disableNetConnect(): void;
  enableCallHistory(): unknown;
  getCallHistory(): { calls(): CallLog[] } | undefined;
  get(origin: string): {
    intercept(options: { path: string; method: string }): {
      reply(status: number, body: string, options?: { headers?: Record<string, string> }): unknown;
    };
  };
}
interface TestingModule {
  runCli(argv: string[], io: RunCliIo): Promise<RunCliResult>;
  linkMcp(server: unknown): Promise<McpLink>;
  mockGrip(): MockAgentLike | { agent: MockAgentLike };
  fixtureSecrets(): { sessionToken: string };
}
// The write result and the send log line, as the write gate item fixes them.
interface WritePlan {
  kind: string;
  container_id: number;
  target_thing_id: number;
  request: { method: string; path: string; body: unknown };
  status_before: string | null;
  verdicts: Record<string, unknown>;
}
interface WriteResult {
  plan: WritePlan;
  outcome: "sent" | "refused" | "failed" | "dry-run";
  refusal?: string;
  hint?: string;
  go_ahead_id?: string;
  connection?: number | null;
  message_id?: number | null;
}
interface SendLogLine {
  time: string;
  kind: string;
  source: string;
  container_id: number;
  target_thing_id: number;
  status_before: string | null;
  message: string | null;
  message_sha256: string | null;
  go_ahead: string | null;
  dry_run: boolean;
  outcome: string;
  refusal: string | null;
  http_status: number | null;
  response: string | null;
  connection: number | null;
  message_id: number | null;
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

// Oracle subjects: packages/core/src/operations/interest/show.ts, interest/skip.ts and chat/send.ts
// (not built yet when this file was written), reached through the real server's tool list, plus the
// shared test package of the test helpers item. `interest skip` may be held out of the registry
// until its `no` POST is verified live (#17 § interest skip); its cases skip, with the reason in
// their titles, while its tool is absent.
const mcpEntry = (await importSubject("@gripeventsctl/mcp")) as Partial<McpModule> | undefined;
const testing = (await importSubject("@gripeventsctl/testing")) as Partial<TestingModule> | undefined;
const SHOW_TOOL = "gripeventsctl_interest_show";
const SKIP_TOOL = "gripeventsctl_interest_skip";
const CHAT_TOOL = "gripeventsctl_chat_send";
const WRITE_SUBJECTS: Record<string, string> = {
  [SHOW_TOOL]: "packages/core/src/operations/interest/show.ts",
  [CHAT_TOOL]: "packages/core/src/operations/chat/send.ts",
};
const harnessReady =
  mcpEntry !== undefined &&
  typeof mcpEntry.buildServer === "function" &&
  testing !== undefined &&
  typeof testing.runCli === "function" &&
  typeof testing.linkMcp === "function" &&
  typeof testing.mockGrip === "function" &&
  typeof testing.fixtureSecrets === "function";
// Which operations the registry carries is read from the real server, never from a hand-made list.
const registeredTools: string[] = await (async () => {
  if (!harnessReady || mcpEntry === undefined || testing === undefined) return [];
  const probeHome = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-writes-probe-"));
  const link = await (testing as TestingModule).linkMcp(
    (mcpEntry as McpModule).buildServer("0.0.0", { env: { HOME: probeHome, USERPROFILE: probeHome } }),
  );
  try {
    return (await link.listTools()).map((tool) => tool.name);
  } finally {
    await link.close();
    await rm(probeHome, { recursive: true, force: true });
  }
})();
const missing: string[] = Object.entries(WRITE_SUBJECTS)
  .filter(([tool]) => !registeredTools.includes(tool))
  .map(([, file]) => file);
if (!harnessReady) missing.push("packages/testing/src/index.ts");
const subject = missing.length === 0 ? { mcp: mcpEntry as McpModule, testing: testing as TestingModule } : undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}
const skipRegistered = registeredTools.includes(SKIP_TOOL);

const API_ORIGIN = "https://api-prod.grip.events";
const JSON_HEADERS = { "content-type": "application/json" };
const CONTAINER_ID = 1;
const THING_ID = 42;
const NOW = "2026-10-12T12:00:00.000Z";
const STATUS_PATH = `/1/container/${String(CONTAINER_ID)}/thing/user_id/match/${String(THING_ID)}/status`;
const YES_PATH = `/1/container/${String(CONTAINER_ID)}/thing/user_id/match_manual/yes/to_thing/${String(THING_ID)}`;
const CHAT_PATH = `/1/chat/thing/${String(THING_ID)}`;
// The challenge code the CLI confirmation shows (#16 § The terminal confirmation): four characters
// over `abcdefghjkmnpqrstuvwxyz23456789`, in the prompt `type <code> to send, or anything else to cancel`.
const CHALLENGE = /type ([abcdefghjkmnpqrstuvwxyz23456789]{4}) to send/;

// Fixtures, each built from the docs/api/ section it cites, never from code.
// docs/api/interest.md § Check the state first: `{ success: true, data: { status } }`.
const matchStatus = (status: string): string => JSON.stringify({ success: true, data: { status } });
// docs/api/interest.md § Response: HTTP 201; `connection` is 1 when the answer made a mutual connection.
const matchAnswer201 = (connection: 0 | 1): string =>
  JSON.stringify({
    success: true,
    data: { message: "action recorded - swipe message created or updated", connection },
  });
// docs/api/interest.md § Errors the app matches on: the three bodies the app matches, none seen live.
const SWIPE_CAP_BODY = "limit of swipes reached for action";
const MODE_PHASE_BODY = "action not allowed under current mode phase";
const swipeCap = (): string => JSON.stringify({ success: false, data: SWIPE_CAP_BODY });
const modePhase = (): string => JSON.stringify({ success: false, data: MODE_PHASE_BODY });
const conflict409 = (errors: string[]): string => JSON.stringify({ error: { data: errors } });
// docs/api/chat-and-meetings.md § Send a chat message: HTTP 200 `{ success: true, data: { message_id } }`.
const chatSend200 = (messageId: number): string => JSON.stringify({ success: true, data: { message_id: messageId } });

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    callback();
  }
}

/** A fixed clock whose waits end at once and are recorded: this file asserts that nothing waits. */
function fixedClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(NOW),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

interface FakeTerminal {
  terminal: Terminal;
  prompts: string[];
  screen(): string;
}

/** The user at a terminal: reads the challenge code off the screen and types it back; or no TTY at all. */
function fakeTerminal(tty: boolean): FakeTerminal {
  const screen: string[] = [];
  const prompts: string[] = [];
  const answer = (label: string): Promise<string> => {
    prompts.push(label);
    const code = CHALLENGE.exec(`${label}\n${screen.join("")}`)?.[1];
    if (code === undefined)
      return Promise.reject(new Error(`no challenge code on the screen for the prompt: ${label}`));
    return Promise.resolve(code);
  };
  return {
    terminal: {
      isStdinTTY: () => tty,
      isStdoutTTY: () => tty,
      prompt: answer,
      promptHidden: answer,
      write: (_stream, text) => {
        screen.push(text);
      },
    },
    prompts,
    screen: () => screen.join(""),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function bodyText(call: CallLog): string {
  const body: unknown = call.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body);
}

function header(call: CallLog, name: string): string | undefined {
  for (const [key, value] of Object.entries(call.headers ?? {})) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(", ") : value;
  }
  return undefined;
}

function summary(calls: CallLog[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}

function writeResult(value: unknown): WriteResult {
  expect(value, "a write result object").toBeTypeOf("object");
  return value as WriteResult;
}

function errorOf(value: unknown): { kind: string; message: string; hint: string } {
  const error = (value as { error?: { kind: string; message: string; hint: string } } | undefined)?.error;
  expect(error, "an { error: { kind, message, hint } } object").toBeDefined();
  return error as { kind: string; message: string; hint: string };
}

/**
 * The one JSON object a captured stream carries: the `--json` result on stdout, or the `--json`
 * error form on stderr. A diagnostic line the transport writes before it is skipped.
 */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

const HOME_VARIABLES = ["HOME", "USERPROFILE", "GRIPEVENTSCTL_CONFIG_FILE", "NO_COLOR"] as const;

describe.skipIf(subject === undefined)(
  "[CAP-WRITES] the three writes send the documented bodies, report the answer, stop at the swipe cap and log a failed POST (S13 to S21)",
  () => {
    // A skipped `describe` still runs this callback to collect its tests, so nothing here may
    // dereference a missing subject; the tests themselves run only when it exists.
    const live = (): NonNullable<typeof subject> => {
      if (subject === undefined) throw new Error("unreachable: the suite is skipped without its subject");
      return subject;
    };
    const grip = subject?.testing.mockGrip();
    const agent: MockAgentLike | undefined = grip === undefined ? undefined : "agent" in grip ? grip.agent : grip;
    agent?.disableNetConnect();
    agent?.enableCallHistory();
    const sessionToken = subject?.testing.fixtureSecrets().sessionToken ?? "";

    let home = "";
    let env: NodeJS.ProcessEnv = {};
    let sendLog = "";
    let journal = "";
    const savedEnv: Partial<Record<(typeof HOME_VARIABLES)[number], string | undefined>> = {};

    /** A fresh temporary home holding a synthetic session with writes enabled (#4's config shape). */
    async function resetHome(): Promise<void> {
      if (home !== "") await rm(home, { recursive: true, force: true });
      home = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-writes-"));
      const configFile = join(home, ".gripeventsctl.yaml");
      sendLog = join(home, ".gripeventsctl.send-log.jsonl");
      journal = join(home, ".gripeventsctl.go-aheads.jsonl");
      env = { HOME: home, USERPROFILE: home, GRIPEVENTSCTL_CONFIG_FILE: configFile, NO_COLOR: "1" };
      for (const name of ["PATH", "SYSTEMROOT", "TMPDIR", "LANG"]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      for (const name of HOME_VARIABLES) process.env[name] = env[name];
      const config = [
        "version: 1",
        "session:",
        "  slug: test-event-1",
        `  container_id: ${String(CONTAINER_ID)}`,
        `  token: ${sessionToken}`,
        '  signed_in_at: "2026-10-12T10:00:00.000Z"',
        "writes:",
        "  enabled: true",
        "",
      ].join("\n");
      await writeFile(configFile, config, { mode: 0o600 });
    }

    beforeEach(async () => {
      for (const name of HOME_VARIABLES) savedEnv[name] = process.env[name];
      await resetHome();
    });

    afterEach(async () => {
      for (const name of HOME_VARIABLES) {
        const saved = savedEnv[name];
        if (saved === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = saved;
      }
      await rm(home, { recursive: true, force: true });
      home = "";
    });

    const calls = (): CallLog[] => agent?.getCallHistory()?.calls() ?? [];
    const callsSince = (before: number): CallLog[] => calls().slice(before);
    const readSendLog = (): Promise<SendLogLine[]> => readJsonLines<SendLogLine>(sendLog);
    const readJournal = (): Promise<Record<string, unknown>[]> => readJsonLines<Record<string, unknown>>(journal);

    function arm(method: "GET" | "POST", path: string, status: number, body: string): void {
      (agent as MockAgentLike)
        .get(API_ORIGIN)
        .intercept({ path, method })
        .reply(status, body, { headers: JSON_HEADERS });
    }

    /** A recorded go-ahead for one exact write (#16 § The go-ahead journal): `proposed`, then `approved`. */
    async function approveGoAhead(kind: string, text: string): Promise<string> {
      const id = randomBytes(8).toString("base64url");
      const fields = { id, kind, container_id: CONTAINER_ID, target_thing_id: THING_ID, message_sha256: sha256(text) };
      const events = [
        { time: "2026-10-12T11:00:00.000Z", event: "proposed", ...fields, message: text, source: "mcp" },
        { time: "2026-10-12T11:30:00.000Z", event: "approved", ...fields, source: "cli" },
      ];
      await appendFile(journal, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
      return id;
    }

    interface CliRun {
      exitCode: number;
      stdout: string;
      stderr: string;
      json: unknown;
      terminal: FakeTerminal;
      sleeps: number[];
    }

    /** One CLI run through the real program; `--json` unless `human`, so the result is readable. */
    async function cli(argv: string[], opts: { tty?: boolean; human?: boolean } = {}): Promise<CliRun> {
      const terminal = fakeTerminal(opts.tty ?? false);
      const clock = fixedClock();
      const result = await live().testing.runCli(opts.human === true ? argv : ["--json", ...argv], {
        terminal: terminal.terminal,
        dispatcher: agent,
        clock,
        env,
      });
      const text =
        opts.human === true ? "" : result.exitCode === 0 || result.exitCode === 4 ? result.stdout : result.stderr;
      const json = parseJson(text);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        json,
        terminal,
        sleeps: clock.sleeps,
      };
    }

    /** One tool call through the real server over the in-memory transport. */
    async function mcp(name: string, args: Record<string, unknown>): Promise<{ tool: ToolResult; sleeps: number[] }> {
      const clock = fixedClock();
      const server = live().mcp.buildServer("0.0.0", { env, clock, dispatcher: agent, stderr: new Capture() });
      const link = await live().testing.linkMcp(server);
      try {
        return { tool: await link.callTool(name, args), sleeps: clock.sleeps };
      } finally {
        await link.close();
      }
    }

    const textOf = (tool: ToolResult): string => tool.content.map((block) => block.text ?? "").join("\n");

    describe("surface", () => {
      it('S13: interest show sends exactly {"message":"<text>"} as application/json, with no query string, and the plan shows the same request', async () => {
        await approveGoAhead("interest.show", "Hello");
        const before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: "Hello" });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        const post = callsSince(before)[1] as CallLog;
        expect(post.method).toBe("POST");
        expect(post.path).toBe(YES_PATH);
        expect(bodyText(post)).toBe('{"message":"Hello"}');
        expect(header(post, "content-type")).toBe("application/json");
        expect(Object.keys(post.searchParams ?? {})).toEqual([]);
        expect(post.fullUrl ?? "").not.toContain("?");
        const result = writeResult(tool.structuredContent);
        expect(result.plan.request).toEqual({
          method: "POST",
          path: `container/${String(CONTAINER_ID)}/thing/user_id/match_manual/yes/to_thing/${String(THING_ID)}`,
          body: { message: "Hello" },
        });
        expect(result.plan.kind).toBe("interest.show");
        expect(result.plan.target_thing_id).toBe(THING_ID);
      });

      it('S14: interest show without a message sends exactly {"message":""}, never {}, asks no confirmation and needs no go-ahead, on both paths', async () => {
        let before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const run = await cli(["interest", "show", String(THING_ID)], { tty: true });
        expect(run.exitCode, run.stderr).toBe(0);
        expect(run.terminal.prompts, "no message, so no confirmation").toHaveLength(0);
        expect(bodyText(callsSince(before)[1] as CallLog)).toBe('{"message":""}');
        expect(writeResult(run.json).outcome).toBe("sent");
        let log = await readSendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ message: null, message_sha256: null, go_ahead: null, outcome: "sent" });

        await resetHome();
        before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(writeResult(tool.structuredContent).outcome).toBe("sent");
        expect(bodyText(callsSince(before)[1] as CallLog)).toBe('{"message":""}');
        log = await readSendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
          source: "mcp",
          message: null,
          message_sha256: null,
          go_ahead: null,
          outcome: "sent",
        });
        expect(await readJournal(), "no text, so no proposal").toEqual([]);
      });

      it('S15: chat send posts exactly {"message":"<text>","container_id":<id>} to chat/thing/<thing id> with no status read, and an empty text is a usage error', async () => {
        const text = "See you at the booth";
        const body = `{"message":"${text}","container_id":${String(CONTAINER_ID)}}`;
        let before = calls().length;
        arm("POST", CHAT_PATH, 200, chatSend200(7));
        const run = await cli(["chat", "send", String(THING_ID), text], { tty: true, human: true });
        expect(run.exitCode, run.stderr).toBe(0);
        expect(summary(callsSince(before))).toEqual([`POST ${CHAT_PATH}`]);
        expect(bodyText(callsSince(before)[0] as CallLog)).toBe(body);
        expect(run.stdout.trimEnd().split("\n").at(-1)).toBe("sent: message 7");
        let log = await readSendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
          kind: "chat.send",
          source: "cli",
          status_before: null,
          message: text,
          go_ahead: "terminal-confirmation",
          outcome: "sent",
          http_status: 200,
          message_id: 7,
          response: null,
        });

        before = calls().length;
        const empty = await cli(["chat", "send", String(THING_ID), ""], { tty: true });
        expect(empty.exitCode).toBe(2);
        expect(callsSince(before)).toHaveLength(0);
        expect(empty.terminal.prompts).toHaveLength(0);
        expect(await readSendLog(), "a usage error leaves no send log line").toHaveLength(1);

        await resetHome();
        await approveGoAhead("chat.send", text);
        before = calls().length;
        arm("POST", CHAT_PATH, 200, chatSend200(7));
        const { tool } = await mcp(CHAT_TOOL, { thing_id: THING_ID, message: text });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(summary(callsSince(before))).toEqual([`POST ${CHAT_PATH}`]);
        expect(bodyText(callsSince(before)[0] as CallLog)).toBe(body);
        const result = writeResult(tool.structuredContent);
        expect(result.plan.request).toEqual({
          method: "POST",
          path: `chat/thing/${String(THING_ID)}`,
          body: { message: text, container_id: CONTAINER_ID },
        });
        expect(result.plan.status_before).toBeNull();
        log = await readSendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
          kind: "chat.send",
          source: "mcp",
          status_before: null,
          outcome: "sent",
          message_id: 7,
        });
      });

      it("S16: connection 1 is reported as a mutual connection and connection 0 as interest shown, in the result, the human line and the log", async () => {
        let before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(1));
        const mutual = await cli(["interest", "show", String(THING_ID)], { human: true });
        expect(mutual.exitCode, mutual.stderr).toBe(0);
        expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
        expect(mutual.stdout.trimEnd().split("\n").at(-1)).toBe("sent: interest shown; mutual connection");
        expect((await readSendLog()).map((line) => [line.outcome, line.connection, line.response])).toEqual([
          ["sent", 1, null],
        ]);

        await resetHome();
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const shown = await cli(["interest", "show", String(THING_ID)], { human: true });
        expect(shown.exitCode, shown.stderr).toBe(0);
        expect(shown.stdout.trimEnd().split("\n").at(-1)).toBe("sent: interest shown");
        expect((await readSendLog()).map((line) => [line.outcome, line.connection])).toEqual([["sent", 0]]);

        await resetHome();
        before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(1));
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
        const result = writeResult(tool.structuredContent);
        expect(result.outcome).toBe("sent");
        expect(result.connection).toBe(1);
        expect(textOf(tool)).toContain("sent: interest shown; mutual connection");
        expect((await readSendLog()).map((line) => line.connection)).toEqual([1]);
      });

      it("S17: the message id of a sent chat message is reported in the result, the human line and the log, on both paths", async () => {
        const text = "synthetic message 1";
        arm("POST", CHAT_PATH, 200, chatSend200(7));
        const run = await cli(["chat", "send", String(THING_ID), text], { tty: true });
        expect(run.exitCode, run.stderr).toBe(0);
        const result = writeResult(run.json);
        expect(result.outcome).toBe("sent");
        expect(result.message_id).toBe(7);
        expect(result.connection, "a chat result carries no connection").toBeUndefined();
        expect((await readSendLog()).map((line) => [line.outcome, line.message_id, line.connection])).toEqual([
          ["sent", 7, null],
        ]);

        await resetHome();
        await approveGoAhead("chat.send", text);
        arm("POST", CHAT_PATH, 200, chatSend200(7));
        const { tool } = await mcp(CHAT_TOOL, { thing_id: THING_ID, message: text });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(writeResult(tool.structuredContent).message_id).toBe(7);
        expect(textOf(tool)).toContain("sent: message 7");
        expect((await readSendLog()).map((line) => line.message_id)).toEqual([7]);
      });

      it("S18: the swipe-cap body stops the write after exactly one POST, logged as failed, with no retry and no wait, on both paths", async () => {
        const hint = "stop for today; the cap is the platform's";
        let before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 200, swipeCap());
        const run = await cli(["interest", "show", String(THING_ID)]);
        expect(run.exitCode, run.stderr).toBe(5);
        expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
        expect(run.sleeps, "no backoff wait").toEqual([]);
        expect(run.stdout.trim()).toBe("");
        const error = errorOf(run.json);
        expect(error.kind).toBe("swipe-cap");
        expect(error.hint).toBe(hint);
        let log = await readSendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
          kind: "interest.show",
          outcome: "failed",
          refusal: null,
          response: SWIPE_CAP_BODY,
        });

        await resetHome();
        before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 200, swipeCap());
        const { tool, sleeps } = await mcp(SHOW_TOOL, { thing_id: THING_ID });
        expect(tool.isError).toBe(true);
        expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
        expect(sleeps).toEqual([]);
        const mcpError = errorOf(tool.structuredContent);
        expect(mcpError.kind).toBe("swipe-cap");
        expect(mcpError.hint).toBe(hint);
        log = await readSendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ source: "mcp", outcome: "failed", response: SWIPE_CAP_BODY });
        expect(calls().length - before, "no second POST follows").toBe(2);
      });

      const failureCases = [
        {
          id: "S19",
          name: "the mode-phase body",
          status: 200,
          body: modePhase(),
          kind: "mode-phase",
          httpStatus: 200,
          response: MODE_PHASE_BODY,
        },
        {
          id: "S20",
          name: "an HTTP 409 with an error.data array",
          status: 409,
          body: conflict409(["synthetic conflict 1"]),
          kind: "conflict",
          httpStatus: 409,
          response: null,
        },
      ];
      for (const failure of failureCases) {
        it(`${failure.id}: ${failure.name} is logged as failed with the reason and propagates as ${failure.kind} (exit 1), on both paths`, async () => {
          let before = calls().length;
          arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
          arm("POST", YES_PATH, failure.status, failure.body);
          const run = await cli(["interest", "show", String(THING_ID)]);
          expect(run.exitCode, run.stderr).toBe(1);
          expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
          expect(errorOf(run.json).kind).toBe(failure.kind);
          let log = await readSendLog();
          expect(log).toHaveLength(1);
          expect(log[0]).toMatchObject({
            outcome: "failed",
            refusal: null,
            http_status: failure.httpStatus,
            status_before: "has_match_none",
          });
          expect(log[0]?.response, "the reason is logged").toBeTypeOf("string");
          if (failure.response !== null) expect(log[0]?.response).toBe(failure.response);

          await resetHome();
          before = calls().length;
          arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
          arm("POST", YES_PATH, failure.status, failure.body);
          const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID });
          expect(tool.isError).toBe(true);
          expect(errorOf(tool.structuredContent).kind).toBe(failure.kind);
          expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
          log = await readSendLog();
          expect(log).toHaveLength(1);
          expect(log[0]).toMatchObject({ source: "mcp", outcome: "failed", http_status: failure.httpStatus });
        });
      }

      it("S21: a second interest show to the same person with a new text is refused before any request, and the hint names the earlier send and says the app edits the intro message (value open: the wording of that sentence)", async () => {
        const earlier: SendLogLine = {
          time: "2026-10-12T09:00:00.000Z",
          kind: "interest.show",
          source: "cli",
          container_id: CONTAINER_ID,
          target_thing_id: THING_ID,
          status_before: "has_match_none",
          message: "Hello",
          message_sha256: sha256("Hello"),
          go_ahead: "terminal-confirmation",
          dry_run: false,
          outcome: "sent",
          refusal: null,
          http_status: 201,
          response: null,
          connection: 0,
          message_id: null,
        };
        await appendFile(sendLog, `${JSON.stringify(earlier)}\n`, { mode: 0o600 });
        const before = calls().length;

        const run = await cli(["interest", "show", String(THING_ID), "--message", "Again"], { tty: true });
        expect(run.exitCode, run.stderr).toBe(4);
        expect(run.terminal.prompts).toHaveLength(0);
        const result = writeResult(run.json);
        expect(result.outcome).toBe("refused");
        expect(result.refusal).toBe("repeat-guard");
        expect(result.hint).toContain("2026-10-12T09:00:00");
        expect(result.hint).toMatch(/edit/);
        expect(result.hint).toMatch(/intro message/);

        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: "Again" });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        const mcpResult = writeResult(tool.structuredContent);
        expect(mcpResult.outcome).toBe("refused");
        expect(mcpResult.refusal).toBe("repeat-guard");
        expect(mcpResult.hint).toContain("2026-10-12T09:00:00");
        expect(mcpResult.hint).toMatch(/edit/);

        expect(callsSince(before), "the guard refuses before the status read").toHaveLength(0);
        expect(await readJournal(), "the guard refuses before the go-ahead step: no proposal").toEqual([]);
        const log = await readSendLog();
        expect(log.map((line) => [line.outcome, line.refusal])).toEqual([
          ["sent", null],
          ["refused", "repeat-guard"],
          ["refused", "repeat-guard"],
        ]);

        if (skipRegistered) {
          // Another kind to the same person is not blocked by that entry: the status is read.
          arm("GET", STATUS_PATH, 200, matchStatus("has_match_yes"));
          const skip = await cli(["interest", "skip", String(THING_ID)]);
          expect(skip.exitCode, skip.stderr).toBe(4);
          expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`]);
          expect(writeResult(skip.json).refusal).toBe("status-not-none");
        }
      });
    });
  },
);
