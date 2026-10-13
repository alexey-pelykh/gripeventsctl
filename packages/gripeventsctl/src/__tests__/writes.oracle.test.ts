// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-WRITES, surface level, cases S1 to S12: the three gated writes read
 * the status first, post only to `has_match_none`, and enforce the message policy. The sibling
 * file `writes-bodies.oracle.test.ts` carries S13 to S21 (the documented bodies, the reported
 * answers, the swipe cap, the failed POSTs and the repeat refusal) at the same surface level; the
 * capability's 21 cases are split in two files only to keep each file readable, and both files
 * carry the same harness. It drives the real CLI program (`runCli`) and the real MCP
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
const SKIP_HELD = " (skips while interest skip is held out of the registry pending its live no POST)";

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

function summary(calls: CallLog[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}

function writeResult(value: unknown): WriteResult {
  expect(value, "a write result object").toBeTypeOf("object");
  return value as WriteResult;
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
  "[CAP-WRITES] the three writes read the status first, post only to has_match_none and enforce the message policy (S1 to S12)",
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
      it("S1: the status read precedes the POST in the call history, on the CLI with the typed confirmation and on MCP with a recorded go-ahead", async () => {
        let before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const run = await cli(["interest", "show", String(THING_ID), "--message", "Hello"], { tty: true });
        expect(run.exitCode, run.stderr).toBe(0);
        expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
        expect(run.terminal.prompts, "one confirmation prompt, after the status read").toHaveLength(1);
        expect(run.terminal.screen()).toContain("Hello");
        const result = writeResult(run.json);
        expect(result.outcome).toBe("sent");
        expect(result.plan.status_before).toBe("has_match_none");
        expect(result.connection).toBe(0);
        const cliLog = await readSendLog();
        expect(cliLog).toHaveLength(1);
        expect(cliLog[0]).toMatchObject({
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
        });

        await resetHome();
        const id = await approveGoAhead("interest.show", "Hello");
        before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: "Hello" });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
        expect(writeResult(tool.structuredContent).outcome).toBe("sent");
        const mcpLog = await readSendLog();
        expect(mcpLog).toHaveLength(1);
        expect(mcpLog[0]).toMatchObject({
          kind: "interest.show",
          source: "mcp",
          status_before: "has_match_none",
          message: "Hello",
          go_ahead: id,
          outcome: "sent",
          http_status: 201,
          response: null,
          connection: 0,
        });
      });

      const statusCases = [
        { id: "S2", op: "show", status: "has_match_yes" },
        { id: "S3", op: "show", status: "has_match_no" },
        { id: "S4", op: "show", status: "has_connection" },
        { id: "S5", op: "skip", status: "has_match_yes" },
        { id: "S6", op: "skip", status: "has_match_no" },
        { id: "S7", op: "skip", status: "has_connection" },
      ] as const;
      for (const statusCase of statusCases) {
        const held = statusCase.op === "skip" && !skipRegistered;
        it.skipIf(held)(
          `${statusCase.id}: no POST on ${statusCase.status} for interest ${statusCase.op}: the status GET is the only request on both paths${statusCase.op === "skip" ? SKIP_HELD : ""}`,
          async () => {
            const argv =
              statusCase.op === "show"
                ? ["interest", "show", String(THING_ID), "--message", "Hello"]
                : ["interest", "skip", String(THING_ID)];
            const toolName = statusCase.op === "show" ? SHOW_TOOL : SKIP_TOOL;
            const toolArgs =
              statusCase.op === "show" ? { thing_id: THING_ID, message: "Hello" } : { thing_id: THING_ID };
            const kind = statusCase.op === "show" ? "interest.show" : "interest.skip";
            const hint = `the status is ${statusCase.status}; this tool posts only to has_match_none, so an answer you set in the app stays as you set it`;

            let before = calls().length;
            arm("GET", STATUS_PATH, 200, matchStatus(statusCase.status));
            const run = await cli(argv, { tty: true });
            expect(run.exitCode, run.stderr).toBe(4);
            expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`]);
            expect(run.terminal.prompts, "no confirmation is asked for a refused write").toHaveLength(0);
            const result = writeResult(run.json);
            expect(result.outcome).toBe("refused");
            expect(result.refusal).toBe("status-not-none");
            expect(result.hint).toContain(hint);
            expect(result.plan.status_before).toBe(statusCase.status);
            if (statusCase.op === "show" && statusCase.status === "has_match_yes") {
              // #17: with has_match_yes and a new text the hint also says the app edits the intro message
              // (value open: the wording of that sentence).
              expect(result.hint).toMatch(/edit/);
              expect(result.hint).toMatch(/intro message/);
            }

            before = calls().length;
            arm("GET", STATUS_PATH, 200, matchStatus(statusCase.status));
            const { tool } = await mcp(toolName, toolArgs);
            expect(tool.isError, textOf(tool)).toBeFalsy();
            expect(summary(callsSince(before))).toEqual([`GET ${STATUS_PATH}`]);
            const mcpResult = writeResult(tool.structuredContent);
            expect(mcpResult.outcome).toBe("refused");
            expect(mcpResult.refusal).toBe("status-not-none");
            expect(mcpResult.hint).toContain(hint);

            const log = await readSendLog();
            expect(
              log.map((line) => [
                line.source,
                line.kind,
                line.outcome,
                line.refusal,
                line.status_before,
                line.go_ahead,
              ]),
            ).toEqual([
              ["cli", kind, "refused", "status-not-none", statusCase.status, null],
              ["mcp", kind, "refused", "status-not-none", statusCase.status, null],
            ]);
            expect(await readJournal(), "the status refusal comes before the go-ahead step: no proposal").toEqual([]);
          },
        );
      }

      it("S8: a 251-code-point message is refused as message-too-long before any request, on both paths and on a dry run", async () => {
        const text = "a".repeat(251);
        const hint =
          "the message is 251 characters; the app allows at most 250, and what the server does with more is not verified";
        const before = calls().length;

        const run = await cli(["interest", "show", String(THING_ID), "--message", text], { tty: true });
        expect(run.exitCode, run.stderr).toBe(4);
        expect(run.terminal.prompts).toHaveLength(0);
        const result = writeResult(run.json);
        expect(result.outcome).toBe("refused");
        expect(result.refusal).toBe("message-too-long");
        expect(result.hint).toBe(hint);

        const show = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: text });
        expect(show.tool.isError, "a policy refusal is a result, not a schema error").toBeFalsy();
        expect(writeResult(show.tool.structuredContent)).toMatchObject({
          outcome: "refused",
          refusal: "message-too-long",
          hint,
        });
        const chat = await mcp(CHAT_TOOL, { thing_id: THING_ID, message: text });
        expect(chat.tool.isError, textOf(chat.tool)).toBeFalsy();
        expect(writeResult(chat.tool.structuredContent)).toMatchObject({
          outcome: "refused",
          refusal: "message-too-long",
          hint,
        });

        const dry = await cli(["interest", "show", String(THING_ID), "--message", text, "--dry-run"]);
        expect(dry.exitCode, dry.stderr).toBe(4);
        expect(writeResult(dry.json)).toMatchObject({ outcome: "refused", refusal: "message-too-long" });

        expect(callsSince(before), "no status read and no POST").toHaveLength(0);
        const log = await readSendLog();
        expect(log).toHaveLength(4);
        for (const line of log) {
          expect(line).toMatchObject({
            outcome: "refused",
            refusal: "message-too-long",
            status_before: null,
            go_ahead: null,
            http_status: null,
          });
        }
        expect(log.map((line) => line.dry_run)).toEqual([false, false, false, true]);
        expect(await readJournal()).toEqual([]);
      });

      it("S9: a 250-code-point message is accepted: 250 ASCII characters on the CLI, 250 emoji of 500 UTF-16 units on MCP", async () => {
        const ascii = "b".repeat(250);
        let before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const run = await cli(["interest", "show", String(THING_ID), "--message", ascii], { tty: true });
        expect(run.exitCode, run.stderr).toBe(0);
        expect(writeResult(run.json).outcome).toBe("sent");
        const post = callsSince(before)[1];
        expect(post).toBeDefined();
        expect(JSON.parse(bodyText(post as CallLog))).toEqual({ message: ascii });

        await resetHome();
        const emoji = "😀".repeat(250);
        expect([...emoji]).toHaveLength(250);
        expect(emoji).toHaveLength(500);
        await approveGoAhead("interest.show", emoji);
        before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: emoji });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(writeResult(tool.structuredContent).outcome).toBe("sent");
        const mcpPost = callsSince(before)[1];
        expect(mcpPost).toBeDefined();
        expect(JSON.parse(bodyText(mcpPost as CallLog))).toEqual({ message: emoji });
        const log = await readSendLog();
        expect(log.map((line) => [line.outcome, line.message_sha256])).toEqual([["sent", sha256(emoji)]]);
      });

      it("S10: a message holding U+202E is refused as message-characters with its position and code point, and no request is sent", async () => {
        const text = "Hello‮world";
        const hint =
          "the message holds a control or direction-override character at position 5 (U+202E); remove it and run again";
        const before = calls().length;

        const run = await cli(["interest", "show", String(THING_ID), "--message", text], { tty: true });
        expect(run.exitCode, run.stderr).toBe(4);
        expect(run.terminal.prompts).toHaveLength(0);
        expect(writeResult(run.json)).toMatchObject({ outcome: "refused", refusal: "message-characters", hint });
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: text });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(writeResult(tool.structuredContent)).toMatchObject({
          outcome: "refused",
          refusal: "message-characters",
          hint,
        });
        const chat = await cli(["chat", "send", String(THING_ID), text], { tty: true });
        expect(chat.exitCode, chat.stderr).toBe(4);
        expect(writeResult(chat.json)).toMatchObject({ outcome: "refused", refusal: "message-characters", hint });

        expect(callsSince(before)).toHaveLength(0);
        const log = await readSendLog();
        expect(log.map((line) => [line.kind, line.outcome, line.refusal, line.status_before, line.go_ahead])).toEqual([
          ["interest.show", "refused", "message-characters", null, null],
          ["interest.show", "refused", "message-characters", null, null],
          ["chat.send", "refused", "message-characters", null, null],
        ]);
        expect(await readJournal()).toEqual([]);
      });

      it("S11: a message holding \\x1b, U+2066, U+0085 or U+007F is refused as message-characters on chat send and interest show, and no request is sent", async () => {
        const hostile = [
          { text: "\x1b[2Jhi", position: 0, codePoint: "U+001B" },
          { text: "hi⁦there", position: 2, codePoint: "U+2066" },
          { text: "a\u0085b", position: 1, codePoint: "U+0085" },
          { text: "x\u007Fy", position: 1, codePoint: "U+007F" },
        ];
        const hintFor = (position: number, codePoint: string): string =>
          `the message holds a control or direction-override character at position ${String(position)} (${codePoint}); remove it and run again`;
        const before = calls().length;

        for (const { text, position, codePoint } of hostile) {
          const { tool } = await mcp(CHAT_TOOL, { thing_id: THING_ID, message: text });
          expect(tool.isError, textOf(tool)).toBeFalsy();
          expect(writeResult(tool.structuredContent)).toMatchObject({
            outcome: "refused",
            refusal: "message-characters",
            hint: hintFor(position, codePoint),
          });
        }
        const escape = hostile[0] as { text: string; position: number; codePoint: string };
        const chat = await cli(["chat", "send", String(THING_ID), escape.text], { tty: true });
        expect(chat.exitCode, chat.stderr).toBe(4);
        expect(chat.terminal.prompts).toHaveLength(0);
        expect(writeResult(chat.json)).toMatchObject({
          outcome: "refused",
          refusal: "message-characters",
          hint: hintFor(0, "U+001B"),
        });
        const show = await cli(["interest", "show", String(THING_ID), "--message", escape.text], { tty: true });
        expect(show.exitCode, show.stderr).toBe(4);
        expect(writeResult(show.json)).toMatchObject({
          outcome: "refused",
          refusal: "message-characters",
          hint: hintFor(0, "U+001B"),
        });

        expect(callsSince(before)).toHaveLength(0);
        const log = await readSendLog();
        expect(log).toHaveLength(6);
        for (const line of log)
          expect(line).toMatchObject({ outcome: "refused", refusal: "message-characters", http_status: null });
      });

      it("S12: a message with right-to-left letters, an emoji and a newline is accepted and sent raw in the body, on both paths", async () => {
        const text = "שלום Hello 😀\nمرحبا";
        let before = calls().length;
        arm("POST", CHAT_PATH, 200, chatSend200(7));
        const run = await cli(["chat", "send", String(THING_ID), text], { tty: true });
        expect(run.exitCode, run.stderr).toBe(0);
        expect(writeResult(run.json).outcome).toBe("sent");
        expect(summary(callsSince(before))).toEqual([`POST ${CHAT_PATH}`]);
        expect(JSON.parse(bodyText(callsSince(before)[0] as CallLog))).toEqual({
          message: text,
          container_id: CONTAINER_ID,
        });

        await resetHome();
        await approveGoAhead("interest.show", text);
        before = calls().length;
        arm("GET", STATUS_PATH, 200, matchStatus("has_match_none"));
        arm("POST", YES_PATH, 201, matchAnswer201(0));
        const { tool } = await mcp(SHOW_TOOL, { thing_id: THING_ID, message: text });
        expect(tool.isError, textOf(tool)).toBeFalsy();
        expect(writeResult(tool.structuredContent).outcome).toBe("sent");
        expect(JSON.parse(bodyText(callsSince(before)[1] as CallLog))).toEqual({ message: text });
        expect((await readSendLog()).map((line) => [line.outcome, line.message])).toEqual([["sent", text]]);
      });
    });
  },
);
