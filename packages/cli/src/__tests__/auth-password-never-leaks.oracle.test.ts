// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Oracle for CAP-AUTH, the password-never-leaks cases S2 to S5 and S9.
 *
 * Written before the auth commands exist, from the public specification of the auth item (#7).
 * The implementing change leaves this file byte-identical and makes it pass. The other CAP-AUTH
 * cases (S1, S6 to S8, S10 to S13) are implementer-written and live in the item's own test files.
 *
 * What the oracle grades (#7 § Specification, § Acceptance Criteria):
 * - `auth signin <slug> [--container-id <n>] [--email <email>]` reads the password from the
 *   terminal's hidden prompt, sends the login once, stores the session, and never prints the
 *   password, its `Basic` value, the application token or the chat token.
 * - A login failing at the network exits 7; a login failing with a 500 or with an invalid JSON
 *   body exits 1; none of them leaves a secret in a stream, in `error.cause` or in
 *   `JSON.stringify(error)`.
 * - No `--password` option exists; `--password <value>` is refused with exit 2.
 *
 * What the oracle drives, as the related items fix it:
 * - `Terminal` (#7, `packages/cli/src/lib/terminal.ts`): `isStdinTTY()`, `isStdoutTTY()`,
 *   `prompt(label)`, `promptHidden(label)`, `write(stream, text)`. The oracle brings its own fake.
 * - `Clock` (#4, `packages/core/src/lib/clock.ts`): `now()`, `sleep(ms)`, `timeoutSignal(ms)`.
 *   The oracle brings its own fake.
 * - `runCli(argv, io)` (#7, `packages/testing/src/cli-harness.ts`): runs
 *   `buildProgram().parseAsync` with captured streams and an exit code. #7 fixes the name and
 *   that much of the shape; the `RunCliIo` and `RunCliResult` interfaces below fix the rest.
 * - `mockGrip()` (#5) hands out the undici `MockAgent` the client is given as its dispatcher.
 * - `fixtureSecrets()` (#4) generates every secret-shaped value at run time.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The Terminal seam, as #7 fixes it.
interface Terminal {
  isStdinTTY(): boolean;
  isStdoutTTY(): boolean;
  prompt(label: string): Promise<string>;
  promptHidden(label: string): Promise<string>;
  write(stream: unknown, text: string): void;
}

// The Clock seam, as #4 fixes it.
interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

// What `runCli` receives: the seams the command must take from the harness instead of the process.
interface RunCliIo {
  terminal: Terminal;
  dispatcher: unknown;
  clock: Clock;
  env: NodeJS.ProcessEnv;
}

// What `runCli` returns. `error` is the error the exit-code printer received, when the run failed.
interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: unknown;
}

// The per-run secrets of `fixtureSecrets()`; the `Basic` value is derived here from the email used.
interface FixtureSecrets {
  sessionToken: string;
  chatToken: string;
  applicationToken: string;
  password: string;
}

// One entry of undici's `MockCallHistory.calls()` (undici 8.11.2, `lib/mock/mock-call-history.js`).
interface CallLog {
  method: string;
  path: string;
  searchParams: Record<string, string>;
  headers: Record<string, string | string[]> | undefined;
  body: unknown;
}

// The part of undici's `MockAgent` the oracle uses.
interface MockAgentLike {
  disableNetConnect(): void;
  enableCallHistory(): unknown;
  getCallHistory(): { calls(): CallLog[] } | undefined;
  get(origin: string): {
    intercept(options: { path: string | ((requestPath: string) => boolean); method: string }): {
      reply(status: number, body: string, options?: { headers?: Record<string, string> }): unknown;
      replyWithError(error: Error): unknown;
    };
  };
}

interface TestingModule {
  runCli(argv: string[], io: RunCliIo): Promise<RunCliResult>;
  mockGrip(): MockAgentLike | { agent: MockAgentLike };
  fixtureSecrets(): FixtureSecrets;
}

// Oracle subject: packages/cli/src/commands/auth/signin.ts (not built yet when this file was written).
const subject = (await import("../commands/auth/signin.js").catch(() => undefined)) as object | undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error("oracle subject missing: packages/cli/src/commands/auth/signin.ts");
}
// The harness the surface cases go through; it lands with the subject (#7 creates `runCli`).
const testing = (await import("@gripeventsctl/testing").catch(() => undefined)) as TestingModule | undefined;

const API_ORIGIN = "https://api-prod.grip.events";
const SLUG = "test-event-1";
const DISPLAY_NAME = "Test Event 1";
const CONTAINER_ID = 7;
const EMAIL = "test-person-1@example.com";
const SIGNED_IN_AT = "2026-10-12T19:09:00.000Z";

// docs/api/containers.md § Config by slug, § Fields of a 200 answer: the 200 answer to
// `GET /1/config?container_name=<slug>`. Field names from the page; every value synthetic.
function configLookup200(applicationToken: string): string {
  return JSON.stringify({
    success: true,
    data: {
      container: { general: { display_name: DISPLAY_NAME, name: SLUG, active: 1 } },
      application: {
        general: { application_name: "Example Org 1", application_id: 1, token: applicationToken },
        permissions: { type_permissions: {} },
      },
    },
  });
}

// docs/api/login.md § Response: the 200 answer to `POST /1/user/account/login`. Field names from
// the page; the two tokens come from `fixtureSecrets()`, the ids are synthetic.
function login200(sessionToken: string, chatToken: string): string {
  return JSON.stringify({
    success: true,
    data: {
      first_login: false,
      user_token: sessionToken,
      chat_token: {
        IdentityId: "eu-west-1:test-identity-1",
        Token: chatToken,
        $metadata: { httpStatusCode: 200, requestId: "test-request-1", attempts: 1, totalRetryDelay: 0 },
      },
    },
  });
}

// docs/api/README.md § Response envelope: an error answer is `success: false` with the reason in
// `data`. No page records a 500 body for the login; this is the documented envelope on that status.
function apiFailure500(): string {
  return JSON.stringify({ success: false, data: "synthetic server error 1" });
}

const JSON_HEADERS = { "content-type": "application/json" };

interface FakeTerminal {
  terminal: Terminal;
  screen(): string;
  visiblePrompts: string[];
  hiddenPrompts: string[];
}

function fakeTerminal(options: { tty: boolean; hiddenAnswers: string[] }): FakeTerminal {
  const screen: string[] = [];
  const visiblePrompts: string[] = [];
  const hiddenPrompts: string[] = [];
  const hiddenAnswers = [...options.hiddenAnswers];
  const terminal: Terminal = {
    isStdinTTY: () => options.tty,
    isStdoutTTY: () => options.tty,
    prompt: (label) => {
      visiblePrompts.push(label);
      return Promise.reject(new Error(`unscripted visible prompt: ${label}`));
    },
    promptHidden: (label) => {
      hiddenPrompts.push(label);
      const answer = hiddenAnswers.shift();
      if (answer === undefined) {
        return Promise.reject(new Error(`unscripted hidden prompt: ${label}`));
      }
      return Promise.resolve(answer);
    },
    write: (_stream, text) => {
      screen.push(text);
    },
  };
  return { terminal, screen: () => screen.join(""), visiblePrompts, hiddenPrompts };
}

const clock: Clock = {
  now: () => new Date(SIGNED_IN_AT),
  sleep: () => Promise.resolve(),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};

interface TempHome {
  dir: string;
  configFile: string;
  env: NodeJS.ProcessEnv;
}

const HOME_VARIABLES = ["HOME", "USERPROFILE", "GRIPEVENTSCTL_CONFIG_FILE", "NO_COLOR"] as const;

async function makeTempHome(): Promise<TempHome> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gripeventsctl-oracle-auth-"));
  const configFile = path.join(dir, ".gripeventsctl.yaml");
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    USERPROFILE: dir,
    GRIPEVENTSCTL_CONFIG_FILE: configFile,
    NO_COLOR: "1",
  };
  for (const name of ["PATH", "SYSTEMROOT", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { dir, configFile, env };
}

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    files[`file ${path.relative(dir, filePath)}`] = await readFile(filePath, "utf8");
  }
  return files;
}

// Every text an error can carry: its string form, its JSON form, its message, stack and hint, and
// the same for each `cause` and each member of an `AggregateError`.
function errorTexts(error: unknown, depth = 0): string[] {
  if (error === undefined || error === null || depth > 8) return [];
  const texts: string[] = [String(error)];
  try {
    texts.push(JSON.stringify(error) ?? "");
  } catch {
    texts.push("<circular>");
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "stack", "hint", "bodyExcerpt"]) {
      const value = record[key];
      if (typeof value === "string") texts.push(value);
    }
    texts.push(...errorTexts(record["cause"], depth + 1));
    const members = record["errors"];
    if (Array.isArray(members)) {
      for (const member of members) texts.push(...errorTexts(member, depth + 1));
    }
  }
  return texts;
}

function expectNoSecretIn(haystacks: Record<string, string>, secrets: Record<string, string>): void {
  for (const [secretName, secret] of Object.entries(secrets)) {
    expect(secret.length, `${secretName} is a fixture secret of at least 8 characters`).toBeGreaterThanOrEqual(8);
    for (const [haystackName, haystack] of Object.entries(haystacks)) {
      expect(haystack, `${secretName} must not appear in ${haystackName}`).not.toContain(secret);
    }
  }
}

function header(call: CallLog, name: string): string | undefined {
  for (const [key, value] of Object.entries(call.headers ?? {})) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(", ") : value;
  }
  return undefined;
}

// The request body as text: the mock dispatcher records the string or bytes the client handed to fetch.
function bodyText(call: CallLog): string {
  const body: unknown = call.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  return String(body);
}

function callsOf(agent: MockAgentLike): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

describe.skipIf(subject === undefined)(
  "[CAP-AUTH] the password never leaks: not to a stream, a file or an error",
  () => {
    let agent: MockAgentLike;
    let secrets: FixtureSecrets;
    let basic: string;
    let home: TempHome;
    const savedEnv: Partial<Record<(typeof HOME_VARIABLES)[number], string | undefined>> = {};

    if (testing !== undefined) {
      // Created once per file, as the transport item specifies for `mockGrip()`.
      const grip = testing.mockGrip();
      agent = "getCallHistory" in grip ? grip : grip.agent;
      agent.disableNetConnect();
      agent.enableCallHistory();
    }

    beforeAll(() => {
      if (testing === undefined) {
        throw new Error(
          "test harness missing: @gripeventsctl/testing with runCli, mockGrip and fixtureSecrets (the auth item creates runCli)",
        );
      }
      secrets = testing.fixtureSecrets();
      for (const name of ["sessionToken", "chatToken", "applicationToken", "password"] as const) {
        expect(typeof secrets[name], `fixtureSecrets().${name} is a string`).toBe("string");
      }
      basic = Buffer.from(`${EMAIL}:${secrets.password}`).toString("base64");
    });

    beforeEach(async () => {
      home = await makeTempHome();
      for (const name of HOME_VARIABLES) {
        savedEnv[name] = process.env[name];
        process.env[name] = home.env[name];
      }
    });

    afterEach(async () => {
      for (const name of HOME_VARIABLES) {
        const saved = savedEnv[name];
        if (saved === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = saved;
      }
      await rm(home.dir, { recursive: true, force: true });
    });

    function interceptLookup(): void {
      agent
        .get(API_ORIGIN)
        .intercept({ path: (requestPath) => requestPath.startsWith("/1/config"), method: "GET" })
        .reply(200, configLookup200(secrets.applicationToken), { headers: JSON_HEADERS });
    }

    function loginInterceptor() {
      return agent.get(API_ORIGIN).intercept({ path: "/1/user/account/login", method: "POST" });
    }

    function signinArgv(...extra: string[]): string[] {
      return ["auth", "signin", SLUG, "--container-id", String(CONTAINER_ID), "--email", EMAIL, ...extra];
    }

    async function runSignin(terminal: FakeTerminal, extra: string[] = []): Promise<RunCliResult> {
      if (testing === undefined) throw new Error("unreachable: beforeAll checked the harness");
      return testing.runCli(signinArgv(...extra), {
        terminal: terminal.terminal,
        dispatcher: agent,
        clock,
        env: home.env,
      });
    }

    function secretsNeverPrinted(): Record<string, string> {
      return {
        password: secrets.password,
        "Basic value": basic,
        "application token": secrets.applicationToken,
        "chat token": secrets.chatToken,
      };
    }

    function expectLoginCarriedTheCredentials(call: CallLog | undefined): void {
      expect(call, "a login request was sent").toBeDefined();
      if (call === undefined) return;
      expect(call.method).toBe("POST");
      expect(call.path).toBe("/1/user/account/login");
      expect(header(call, "authorization")).toBe(`Bearer ${secrets.applicationToken}, Basic ${basic}`);
      expect(JSON.parse(bodyText(call))).toEqual({ container_id: CONTAINER_ID });
    }

    describe("surface", () => {
      it("S2: a successful sign-in leaves the password, its Basic value, the application token and the chat token in no stream and no file", async () => {
        interceptLookup();
        loginInterceptor().reply(200, login200(secrets.sessionToken, secrets.chatToken), { headers: JSON_HEADERS });
        const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });
        const before = callsOf(agent).length;

        const result = await runSignin(terminal);

        expect(result.exitCode, result.stderr).toBe(0);
        expect(terminal.hiddenPrompts, "the password is read through one hidden prompt").toHaveLength(1);
        expect(terminal.visiblePrompts, "--email was given, so nothing is prompted visibly").toHaveLength(0);

        const calls = callsOf(agent).slice(before);
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
          "GET /1/config",
          "POST /1/user/account/login",
        ]);
        expect(calls[0]?.searchParams).toEqual({ container_name: SLUG });
        expectLoginCarriedTheCredentials(calls[1]);

        const files = await filesUnder(home.dir);
        const configText = files[`file ${path.basename(home.configFile)}`];
        expect(configText, "the config file holds the stored session").toContain(secrets.sessionToken);

        const output = result.stdout + terminal.screen();
        expect(output).toContain(
          `signed in to ${DISPLAY_NAME} (${SLUG}, container ${String(CONTAINER_ID)}, container id from --container-id)`,
        );

        const errors = Object.fromEntries(
          errorTexts(result.error).map((text, index) => [`error text ${String(index)}`, text]),
        );
        expectNoSecretIn(
          { stdout: result.stdout, stderr: result.stderr, "terminal screen": terminal.screen(), ...files, ...errors },
          secretsNeverPrinted(),
        );
      });

      const failures = [
        {
          id: "S3",
          failure: "failing at the network",
          exitCode: 7,
          arrange: () => loginInterceptor().replyWithError(new Error("synthetic connection reset")),
        },
        {
          id: "S4",
          failure: "answered with a 500",
          exitCode: 1,
          arrange: () => loginInterceptor().reply(500, apiFailure500(), { headers: JSON_HEADERS }),
        },
        {
          id: "S5",
          failure: "answered with an invalid JSON body",
          exitCode: 1,
          arrange: () => loginInterceptor().reply(200, "not json {", { headers: JSON_HEADERS }),
        },
      ];

      it.each(failures)(
        "$id: a login $failure exits $exitCode and leaves no secret in the streams, error.cause or JSON.stringify(error)",
        async ({ exitCode, arrange }) => {
          interceptLookup();
          arrange();
          const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });
          const before = callsOf(agent).length;

          const result = await runSignin(terminal);

          expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
          const calls = callsOf(agent).slice(before);
          expect(
            calls.filter((call) => call.path === "/1/user/account/login"),
            "the login was sent once",
          ).toHaveLength(1);
          expectLoginCarriedTheCredentials(calls.find((call) => call.path === "/1/user/account/login"));
          expect(result.error, "runCli returns the error the command failed with").toBeDefined();

          const errors = Object.fromEntries(
            errorTexts(result.error).map((text, index) => [`error text ${String(index)}`, text]),
          );
          expect(Object.keys(errors).length).toBeGreaterThan(0);
          const files = await filesUnder(home.dir);
          expectNoSecretIn(
            { stdout: result.stdout, stderr: result.stderr, "terminal screen": terminal.screen(), ...files, ...errors },
            secretsNeverPrinted(),
          );
        },
      );

      it("S9: no --password option exists, and --password <value> is refused with exit 2 before any request or prompt", async () => {
        if (testing === undefined) throw new Error("unreachable: beforeAll checked the harness");
        const helpTerminal = fakeTerminal({ tty: true, hiddenAnswers: [] });
        const help = await testing.runCli(["auth", "signin", "--help"], {
          terminal: helpTerminal.terminal,
          dispatcher: agent,
          clock,
          env: home.env,
        });
        const helpText = help.stdout + help.stderr + helpTerminal.screen();
        expect(help.exitCode, helpText).toBe(0);
        expect(helpText).toContain("--container-id");
        expect(helpText).toContain("--email");
        expect(helpText).not.toContain("--password");

        const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });
        const before = callsOf(agent).length;
        const result = await runSignin(terminal, ["--password", secrets.password]);

        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(2);
        expect(callsOf(agent).slice(before), "no request is sent").toHaveLength(0);
        expect(terminal.hiddenPrompts, "no prompt is shown").toHaveLength(0);
        expect(terminal.visiblePrompts).toHaveLength(0);
        const files = await filesUnder(home.dir);
        expectNoSecretIn(
          { stdout: result.stdout, stderr: result.stderr, "terminal screen": terminal.screen(), ...files },
          { password: secrets.password },
        );
      });
    });
  },
);
