// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-OUTPUT, surface level: the redaction backstop (S20) and the output
 * projection of every read operation (S21 to S29). It drives the real CLI program and the real MCP
 * server over a mocked platform, in a temporary home, and never reaches the network or the real
 * config file. The implementing pull request leaves this file byte-identical.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

// The contract this oracle grades, as the registry item fixes it in its Specification.
interface OracleClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}
interface SurfaceDeps {
  env?: NodeJS.ProcessEnv;
  clock?: OracleClock;
  dispatcher?: unknown;
  stderr?: Writable;
}
interface CliDeps extends SurfaceDeps {
  stdout?: Writable;
  isTTY?: boolean;
}
interface CommanderLike {
  parseAsync(argv: readonly string[], options: { from: "user" }): Promise<unknown>;
}
interface CliModule {
  buildProgram(deps?: CliDeps): CommanderLike;
  writeOutput: (...args: never[]) => unknown;
}
interface McpModule {
  buildServer(version?: string, deps?: SurfaceDeps): unknown;
  toolFromOperation: (...args: never[]) => unknown;
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
interface MockPoolLike {
  intercept(options: { path: string | ((path: string) => boolean); method: string }): {
    reply(
      status: number,
      body: string,
      options?: { headers?: Record<string, string> },
    ): { persist(): unknown; times(n: number): unknown };
  };
}
interface MockAgentLike {
  get(origin: string): MockPoolLike;
}
interface FixtureSecrets {
  sessionToken: string;
  chatToken: string;
  applicationToken: string;
}
interface TestingModule {
  linkMcp(server: unknown): Promise<McpLink>;
  mockGrip(): MockAgentLike | { agent: MockAgentLike };
  fixtureSecrets(): FixtureSecrets;
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

// Oracle subjects: packages/cli/src/lib/output.ts and packages/mcp/src/lib/tool-from-operation.ts
// (not built yet when this file was written), reached through the package entry points, plus the
// shared test package of the test helpers item.
const cliEntry = (await importSubject("@gripeventsctl/cli")) as Partial<CliModule> | undefined;
const mcpEntry = (await importSubject("@gripeventsctl/mcp")) as Partial<McpModule> | undefined;
const testing = (await importSubject("@gripeventsctl/testing")) as TestingModule | undefined;
const missing: string[] = [];
if (cliEntry === undefined || typeof cliEntry.writeOutput !== "function")
  missing.push("packages/cli/src/lib/output.ts");
if (mcpEntry === undefined || typeof mcpEntry.toolFromOperation !== "function") {
  missing.push("packages/mcp/src/lib/tool-from-operation.ts");
}
if (testing === undefined) missing.push("packages/testing/src/index.ts");
const subject =
  missing.length === 0 && cliEntry !== undefined && mcpEntry !== undefined && testing !== undefined
    ? { cli: cliEntry as CliModule, mcp: mcpEntry as McpModule, testing }
    : undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}

const API_ORIGIN = "https://api-prod.grip.events";
const JSON_HEADERS = { "content-type": "application/json" };
const REDACTED = "<REDACTED>";

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    callback();
  }
}

/** A clock whose waits end at once: the pacing pauses are not the subject of this file. */
function instantClock(): OracleClock {
  return {
    now: () => new Date(),
    sleep: () => Promise.resolve(),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}

function envelope(data: unknown): string {
  // docs/api/README.md § Response envelope: every answer is `{ success, data }`.
  return JSON.stringify({ success: true, data });
}

function queryOf(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}

/** One surface case: the same operation reached through the CLI and through the MCP server. */
interface SurfaceCase {
  id: string;
  title: string;
  cliArgs: readonly string[];
  tool: string;
  toolArgs: Record<string, unknown>;
  /** Registers the mocked answers for one run on one surface. */
  arm: (pool: MockPoolLike, marker: string, secrets: FixtureSecrets) => void;
  /** The documented keys of one output record, where the operation's item fixes them. */
  recordKeys?: readonly string[];
  /**
   * True where the operation's item keeps unknown keys of the record (the attendees item's loose
   * directory entry): the planted key may pass through, so the case plants the registered session
   * token as its value and grades only that the value reaches no output form.
   */
  extraKeyPassesThrough?: boolean;
  /** Picks the records out of the parsed CLI `--json` output. */
  records?: (json: unknown) => unknown[];
}

// The temporary home of this file, the synthetic session in it, and the tool names the real server
// lists. All of it is prepared at module level because a `describe` callback must stay synchronous.
const secrets: FixtureSecrets = subject?.testing.fixtureSecrets() ?? {
  sessionToken: "",
  chatToken: "",
  applicationToken: "",
};
const home = subject === undefined ? "" : await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-output-"));
const configFile = join(home, ".gripeventsctl.yaml");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  GRIPEVENTSCTL_CONFIG_FILE: configFile,
  NO_COLOR: "1",
};
if (subject !== undefined) {
  // The config shape of the config and session store item: one versioned session, writes off. The
  // slug, the container id and the signed-in time are synthetic; the token is generated per run.
  const config = [
    "version: 1",
    "session:",
    "  slug: test-event-1",
    "  container_id: 1",
    `  token: ${secrets.sessionToken}`,
    '  signed_in_at: "2026-10-12T10:00:00.000Z"',
    "writes:",
    "  enabled: false",
    "",
  ].join("\n");
  await writeFile(configFile, config, { mode: 0o600 });
}
// Which operations the registry carries is read from the real server, never from a hand-made list.
const registeredTools: string[] = await (async () => {
  if (subject === undefined) return [];
  const link = await subject.testing.linkMcp(subject.mcp.buildServer("0.0.0", { env }));
  try {
    return (await link.listTools()).map((tool) => tool.name);
  } finally {
    await link.close();
  }
})();

describe.skipIf(subject === undefined)(
  "[CAP-OUTPUT] every output form is redacted at the last step and projects only the documented fields",
  () => {
    // A skipped `describe` still runs this callback to collect its tests, so nothing here may
    // dereference a missing subject; the tests themselves run only when it exists.
    const live = (): NonNullable<typeof subject> => {
      if (subject === undefined) throw new Error("unreachable: the suite is skipped without its subject");
      return subject;
    };
    const grip = subject?.testing.mockGrip();
    const agent: MockAgentLike | undefined = grip === undefined ? undefined : "agent" in grip ? grip.agent : grip;
    let runCount = 0;

    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
    });

    async function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
      const stdout = new Capture();
      const stderr = new Capture();
      const program = live().cli.buildProgram({
        env,
        clock: instantClock(),
        dispatcher: agent,
        stdout,
        stderr,
        isTTY: false,
      });
      await program.parseAsync(args, { from: "user" });
      return { stdout: stdout.text, stderr: stderr.text };
    }

    async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const stderr = new Capture();
      const server = live().mcp.buildServer("0.0.0", { env, clock: instantClock(), dispatcher: agent, stderr });
      const link = await live().testing.linkMcp(server);
      try {
        return await link.callTool(name, args);
      } finally {
        await link.close();
      }
    }

    const pool = (): MockPoolLike => (agent as MockAgentLike).get(API_ORIGIN);

    describe("surface", () => {
      it.skipIf(!registeredTools.includes("gripeventsctl_events_list"))(
        "S20: a registered secret and a secret-shaped value in a result give zero occurrences in the CLI text, --json, the MCP text block and structuredContent",
        async () => {
          // docs/api/containers.md § Containers a session sees: `GET container` answers a list of
          // `{ id, name, format, has_joined, branch_url }`. The names carry the session token (registered
          // when the client resolved it for this request) and a JWT-shaped chat token.
          const answer = envelope([
            {
              id: 1,
              name: secrets.sessionToken,
              format: "engagement_hub",
              has_joined: false,
              branch_url: "https://example.invalid/1",
            },
            {
              id: 2,
              name: secrets.chatToken,
              format: "engagement_hub",
              has_joined: true,
              branch_url: "https://example.invalid/2",
            },
          ]);
          const arm = () =>
            pool()
              .intercept({ path: (p) => p.split("?")[0] === "/1/container", method: "GET" })
              .reply(200, answer, { headers: JSON_HEADERS });

          arm();
          const human = await runCli(["events", "list"]);
          arm();
          const machine = await runCli(["--json", "events", "list"]);
          arm();
          const result = await callTool("gripeventsctl_events_list", {});

          const forms: Record<string, string> = {
            "CLI human stdout": human.stdout,
            "CLI human stderr": human.stderr,
            "CLI --json stdout": machine.stdout,
            "CLI --json stderr": machine.stderr,
            "MCP text block": result.content.map((block) => block.text ?? "").join("\n"),
            "MCP structuredContent": JSON.stringify(result.structuredContent),
          };
          for (const [form, text] of Object.entries(forms)) {
            expect(occurrences(text, secrets.sessionToken), `${form} holds the session token`).toBe(0);
            expect(occurrences(text, secrets.chatToken), `${form} holds the chat token`).toBe(0);
          }
          expect(human.stdout).toContain(REDACTED);
          expect(machine.stdout).toContain(REDACTED);
          expect(forms["MCP text block"]).toContain(REDACTED);
          expect(forms["MCP structuredContent"]).toContain(REDACTED);
          expect(result.isError).toBeFalsy();
          expect(JSON.parse(machine.stdout)).toHaveLength(2);
        },
      );

      const projectionCases: SurfaceCase[] = [
        {
          id: "S21",
          title: "events check",
          cliArgs: ["events", "check", "test-event-1"],
          tool: "gripeventsctl_events_check",
          toolArgs: { slug: "test-event-1" },
          arm: (p, marker, s) => {
            // docs/api/containers.md § Config by slug and § Fields of a 200 answer: the config lookup by
            // slug; `data.application.general.token` is the per-event application token. The extra
            // `token` key beside `container` is the undocumented field this case plants.
            const answer = envelope({
              container: { general: { display_name: "Test Event 1", name: "test-event-1", active: 1 } },
              application: {
                general: { application_name: "Example Org 1", application_id: 1, token: s.applicationToken },
                permissions: { type_permissions: {} },
              },
              token: marker,
            });
            p.intercept({
              path: (path) => path.startsWith("/1/config?") && queryOf(path).get("container_name") === "test-event-1",
              method: "GET",
            }).reply(200, answer, { headers: JSON_HEADERS });
          },
          recordKeys: [
            "slug_found",
            "display_name",
            "name",
            "active",
            "application_name",
            "container_id",
            "type_permissions",
          ],
          records: (json) => [json],
        },
        {
          id: "S22",
          title: "events list",
          cliArgs: ["events", "list"],
          tool: "gripeventsctl_events_list",
          toolArgs: {},
          arm: (p, marker) => {
            // docs/api/containers.md § Containers a session sees.
            const answer = envelope([
              {
                id: 1,
                name: "Test Event 1",
                format: "engagement_hub",
                has_joined: true,
                branch_url: "https://example.invalid/1",
                token: marker,
              },
            ]);
            p.intercept({ path: (path) => path.split("?")[0] === "/1/container", method: "GET" }).reply(200, answer, {
              headers: JSON_HEADERS,
            });
          },
          recordKeys: ["id", "name", "format", "has_joined"],
          records: (json) => json as unknown[],
        },
        {
          id: "S23",
          title: "attendees list",
          cliArgs: ["attendees", "list", "--type", "1", "--page", "1"],
          tool: "gripeventsctl_attendees_list",
          toolArgs: { type_ids: [1], page: 1 },
          arm: (p, _marker, s) => {
            // docs/api/attendees.md § Directory search: one page of entries, each with the thing id in `id`;
            // the page records no other field name. The attendees item keeps unknown keys of the entry, so
            // the planted key may pass through; the planted value is the registered session token, which
            // redaction removes from every form.
            const answer = envelope([{ id: 1, name: "Test Person 1", token: s.sessionToken }]);
            p.intercept({
              path: (path) => path.startsWith("/1/container/1/search/?") && queryOf(path).get("page") === "1",
              method: "GET",
            }).reply(200, answer, { headers: JSON_HEADERS });
          },
          extraKeyPassesThrough: true,
        },
        {
          id: "S24",
          title: "attendees dump",
          cliArgs: ["attendees", "dump", "--type", "1", "--out", "OUT"],
          tool: "gripeventsctl_attendees_dump",
          toolArgs: { type_ids: [1], out: "OUT" },
          arm: (p, marker) => {
            // docs/api/attendees.md § Directory search: page until `data` is an empty array.
            const page1 = envelope([{ id: 1, name: "Test Person 1", token: marker }]);
            const page2 = envelope([]);
            p.intercept({
              path: (path) => path.startsWith("/1/container/1/search/?") && queryOf(path).get("page") === "1",
              method: "GET",
            }).reply(200, page1, { headers: JSON_HEADERS });
            p.intercept({
              path: (path) => path.startsWith("/1/container/1/search/?") && queryOf(path).get("page") === "2",
              method: "GET",
            }).reply(200, page2, { headers: JSON_HEADERS });
          },
        },
        {
          id: "S25",
          title: "attendees get",
          cliArgs: ["attendees", "get", "2"],
          tool: "gripeventsctl_attendees_get",
          toolArgs: { thing_id: 2 },
          arm: (p, marker) => {
            // docs/api/attendees.md § The per-person profile: `data.id` equals the requested thing id, plus
            // `rtm`, `rtm_raw`, `sessions.speaker[]`, `common_containers`, `common_connections_count`, `rtm_score`.
            const answer = envelope({
              id: 2,
              name: "Test Person 2",
              rtm: {},
              rtm_raw: {},
              sessions: { speaker: [] },
              common_containers: [],
              common_connections_count: 0,
              rtm_score: 0,
              token: marker,
            });
            p.intercept({ path: "/1/container/1/thing/2", method: "GET" }).reply(200, answer, {
              headers: JSON_HEADERS,
            });
          },
        },
        {
          id: "S26",
          title: "match status",
          cliArgs: ["match", "status", "2"],
          tool: "gripeventsctl_match_status",
          toolArgs: { thing_id: 2 },
          arm: (p, marker) => {
            // docs/api/interest.md § Check the state first: `{ success: true, data: { status } }`.
            const answer = envelope({ status: "has_match_none", token: marker });
            p.intercept({ path: "/1/container/1/thing/user_id/match/2/status", method: "GET" }).reply(200, answer, {
              headers: JSON_HEADERS,
            });
          },
          recordKeys: ["status"],
          records: (json) => [json],
        },
        {
          id: "S27",
          title: "chat list",
          cliArgs: ["chat", "list"],
          tool: "gripeventsctl_chat_list",
          toolArgs: {},
          arm: (p, marker) => {
            // docs/api/chat-and-meetings.md § Chat threads: one record per thread with the ten documented fields.
            const answer = envelope([
              {
                thing_id: 2,
                name: "Test Person 2",
                job_title: "Engineer",
                company_name: "Example Org 1",
                last_message: "synthetic message 1",
                last_message_date: 1760288940,
                last_message_is_read: true,
                new_messages_count: 0,
                total_message_count: 1,
                chat_id: 1,
                token: marker,
              },
            ]);
            p.intercept({
              path: (path) => path.startsWith("/1/chat/latest?") && queryOf(path).get("container_id") === "1",
              method: "GET",
            }).reply(200, answer, { headers: JSON_HEADERS });
          },
          recordKeys: [
            "thing_id",
            "name",
            "job_title",
            "company_name",
            "last_message",
            "last_message_date",
            "last_message_is_read",
            "new_messages_count",
            "total_message_count",
            "chat_id",
          ],
          records: (json) => json as unknown[],
        },
        {
          id: "S28",
          title: "chat thread",
          cliArgs: ["chat", "thread", "2"],
          tool: "gripeventsctl_chat_thread",
          toolArgs: { thing_id: 2 },
          arm: (p, marker) => {
            // docs/api/chat-and-meetings.md § Messages in a thread: `id`, `sender_id`, `recipient_id`, `message`,
            // `date_created` (epoch), `is_read` and `meeting_action`.
            const answer = envelope([
              {
                id: 1,
                sender_id: 2,
                recipient_id: 1,
                message: "synthetic message 1",
                date_created: 1760288940,
                is_read: true,
                meeting_action: null,
                token: marker,
              },
            ]);
            p.intercept({ path: "/1/chat/thing/2", method: "GET" }).reply(200, answer, { headers: JSON_HEADERS });
          },
          recordKeys: ["id", "sender_id", "recipient_id", "message", "date_created", "is_read", "meeting_action"],
          records: (json) => json as unknown[],
        },
        {
          id: "S29",
          title: "schedule info",
          cliArgs: ["schedule", "info"],
          tool: "gripeventsctl_schedule_info",
          toolArgs: {},
          arm: (p, marker) => {
            // docs/api/chat-and-meetings.md § Schedule: `data.schedule`, one entry per meeting and per session.
            const answer = envelope({
              schedule: [
                {
                  type: "meeting",
                  status: "accepted",
                  user_display_type: "confirmed",
                  attendees: [
                    { thing_id: 2, name: "Test Person 2", company_name: "Example Org 1", status: "accepted" },
                  ],
                  requestor_id: 1,
                  date_start_timestamp: 1760288940,
                  date_end_timestamp: 1760290740,
                  location: "Room 1",
                  message: "synthetic message 1",
                  has_conflict: false,
                  token: marker,
                },
              ],
            });
            p.intercept({
              path: (path) =>
                path.startsWith("/1/schedule/thing/user_id/info?") && queryOf(path).get("container_id") === "1",
              method: "GET",
            }).reply(200, answer, { headers: JSON_HEADERS });
          },
          recordKeys: [
            "type",
            "status",
            "user_display_type",
            "attendees",
            "requestor_id",
            "date_start_timestamp",
            "date_end_timestamp",
            "location",
            "message",
            "has_conflict",
          ],
          records: (json) => json as unknown[],
        },
      ];

      for (const surfaceCase of projectionCases) {
        const registered = registeredTools.includes(surfaceCase.tool);
        it.skipIf(!registered)(
          `${surfaceCase.id}: an extra token field in the ${surfaceCase.title} answer reaches no output form by value, nor by key where the item projects the record, and the read succeeds (skips until the operation is registered)`,
          async () => {
            const marker = `not-a-secret-marker-${surfaceCase.id}`;
            const outDir = join(home, `out-${surfaceCase.id}`);
            await mkdir(outDir, { recursive: true });
            const withOut = (value: string, n: number) =>
              value === "OUT" ? join(outDir, `dump-${String(n)}.jsonl`) : value;

            runCount += 1;
            surfaceCase.arm(pool(), marker, secrets);
            const human = await runCli(surfaceCase.cliArgs.map((arg) => withOut(arg, runCount)));
            runCount += 1;
            surfaceCase.arm(pool(), marker, secrets);
            const machine = await runCli(["--json", ...surfaceCase.cliArgs.map((arg) => withOut(arg, runCount))]);
            runCount += 1;
            surfaceCase.arm(pool(), marker, secrets);
            const toolArgs = Object.fromEntries(
              Object.entries(surfaceCase.toolArgs).map(([key, value]) => [
                key,
                typeof value === "string" ? withOut(value, runCount) : value,
              ]),
            );
            const result = await callTool(surfaceCase.tool, toolArgs);

            // The read succeeds: `--json` prints the output on stdout (an error prints nothing there),
            // the human form is not empty, and the MCP result is not an error result.
            expect(human.stdout.length).toBeGreaterThan(0);
            const json: unknown = JSON.parse(machine.stdout);
            expect(result.isError).toBeFalsy();
            expect(result.structuredContent).toBeDefined();
            expect(hasKeyDeep(result.structuredContent, "error")).toBe(false);

            // The extra field's value is absent from every output form and from stderr; its key too, where the
            // operation's item projects the record.
            const text = result.content.map((block) => block.text ?? "").join("\n");
            for (const [form, body] of Object.entries({
              "CLI human stdout": human.stdout,
              "CLI human stderr": human.stderr,
              "CLI --json stdout": machine.stdout,
              "CLI --json stderr": machine.stderr,
              "MCP text block": text,
              "MCP structuredContent": JSON.stringify(result.structuredContent),
            })) {
              expect(occurrences(body, marker), `${form} holds the extra field's value`).toBe(0);
              expect(occurrences(body, secrets.applicationToken), `${form} holds the application token`).toBe(0);
              expect(occurrences(body, secrets.sessionToken), `${form} holds the session token`).toBe(0);
            }
            if (surfaceCase.extraKeyPassesThrough !== true) {
              expect(hasKeyDeep(json, "token")).toBe(false);
              expect(hasKeyDeep(result.structuredContent, "token")).toBe(false);
              expect(text).not.toContain("token");
            }

            // Where the operation's item fixes the record's keys, the projection carries exactly those keys.
            if (surfaceCase.recordKeys !== undefined && surfaceCase.records !== undefined) {
              const records = surfaceCase.records(json);
              expect(records.length).toBeGreaterThan(0);
              for (const record of records) {
                expect(Object.keys(record as Record<string, unknown>).sort()).toEqual(
                  [...surfaceCase.recordKeys].sort(),
                );
              }
            }
          },
        );
      }
    });
  },
);
