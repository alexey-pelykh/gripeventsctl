// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-AUTH, surface: `auth signin` (issue #7 § Acceptance Criteria), the cases the pre-authored oracle
 * `auth-password-never-leaks.oracle.test.ts` leaves to the implementer: S1 (the stored session), S6
 * (credentials from the 1Password item), S7 (the token written back through `op item edit`), S8 (no
 * terminal), S10 (where the container id comes from), S11 (one session, replaced), the unknown slug
 * and the `--json` form. S6 and S7 run on POSIX only: the stub `op` is a shell script.
 */

import { readFile, stat, writeFile } from "node:fs/promises";

import {
  FIXTURE_EMAIL,
  type FixtureSecrets,
  STUB_OP_SUPPORTED,
  type TempHome,
  configLookup200,
  configLookup404,
  fakeClock,
  fakeTerminal,
  fixtureSecrets,
  gripPool,
  login200,
  mockGrip,
  removeTempHome,
  restoreHomeEnv,
  runCli,
  saveHomeEnv,
  createTempHome,
  stubOp,
} from "@gripeventsctl/testing";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONTAINER_ID_MISSING_MESSAGE, NEXT_STEP_LINE, NO_TERMINAL_MESSAGE } from "../commands/auth/signin.js";

const SLUG = "test-event-1";
const CONTAINER_ID = 7;
const SIGNED_IN_AT = "2026-10-12T19:09:00Z";

const agent: MockAgent = mockGrip();
let secrets: FixtureSecrets;
let home: TempHome;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  secrets = fixtureSecrets();
  saved = saveHomeEnv();
  home = await createTempHome("gripeventsctl-auth-signin-");
});

afterEach(async () => {
  restoreHomeEnv(saved);
  await removeTempHome(home);
});

function interceptLookup(options: { containerId?: number; slug?: string } = {}): void {
  const reply = configLookup200({
    slug: options.slug ?? SLUG,
    applicationToken: secrets.applicationToken,
    ...(options.containerId === undefined ? {} : { containerId: options.containerId }),
  });
  gripPool(agent)
    .intercept({ path: (requestPath) => requestPath.startsWith("/1/config"), method: "GET" })
    .reply(reply.statusCode, reply.data, reply.responseOptions);
}

function interceptLogin(): void {
  const reply = login200({ sessionToken: secrets.sessionToken, chatToken: secrets.chatToken });
  gripPool(agent)
    .intercept({ path: "/1/user/account/login", method: "POST" })
    .reply(reply.statusCode, reply.data, reply.responseOptions);
}

function loginCalls(): number {
  return (agent.getCallHistory()?.calls() ?? []).filter((call) => call.path === "/1/user/account/login").length;
}

function clockAt(time = SIGNED_IN_AT) {
  return fakeClock(time);
}

async function configText(): Promise<string> {
  return readFile(home.configFile, "utf8");
}

function windowsOf(value: string, size = 8): string[] {
  const windows: string[] = [];
  for (let at = 0; at + size <= value.length; at += 1) windows.push(value.slice(at, at + size));
  return windows;
}

describe("[CAP-AUTH] auth signin", () => {
  it("S1: a terminal sign-in stores the session with the clock's time at mode 0600 and prints the next step", async () => {
    interceptLookup({ containerId: CONTAINER_ID });
    interceptLogin();
    const terminal = fakeTerminal({ tty: true, answers: [FIXTURE_EMAIL], hiddenAnswers: [secrets.password] });
    const loginsBefore = loginCalls();

    const result = await runCli(["auth", "signin", SLUG], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(terminal.visiblePrompts).toEqual(["email"]);
    expect(terminal.hiddenPrompts).toEqual(["password"]);
    expect(loginCalls() - loginsBefore).toBe(1);

    const text = await configText();
    expect(text).toContain(`slug: ${SLUG}`);
    expect(text).toContain(`container_id: ${String(CONTAINER_ID)}`);
    expect(text).toContain(`token: ${secrets.sessionToken}`);
    expect(text).toContain(`signed_in_at: ${SIGNED_IN_AT}`);
    expect(text).not.toContain("auth_failed_at");
    if (process.platform !== "win32") {
      expect((await stat(home.configFile)).mode & 0o777).toBe(0o600);
    }

    expect(result.stdout).toContain(
      `signed in to Test Event 1 (${SLUG}, container ${String(CONTAINER_ID)}, container id from the event config)`,
    );
    expect(result.stdout).toContain(NEXT_STEP_LINE);
    for (const window of windowsOf(secrets.sessionToken)) {
      expect(result.stdout + result.stderr).not.toContain(window);
    }
  });

  it("--json prints the slug, the container id and the sign-in time, and nothing else on stdout", async () => {
    interceptLookup({ containerId: CONTAINER_ID });
    interceptLogin();
    const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });

    const result = await runCli(["--json", "auth", "signin", SLUG, "--email", FIXTURE_EMAIL], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ slug: SLUG, container_id: CONTAINER_ID, signed_in_at: SIGNED_IN_AT });
  });

  it("unknown slug: the documented 404 is reported with the web-address hint, exit 1, and no login is sent", async () => {
    const reply = configLookup404();
    gripPool(agent)
      .intercept({ path: (requestPath) => requestPath.startsWith("/1/config"), method: "GET" })
      .reply(reply.statusCode, reply.data, reply.responseOptions);
    const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });
    const loginsBefore = loginCalls();

    const result = await runCli(["auth", "signin", "nosuchslug", "--email", FIXTURE_EMAIL], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only this slug is unknown");
    expect(result.stderr).toContain("https://matchmaking.grip.events/<slug>");
    expect(loginCalls() - loginsBefore).toBe(0);
    expect(terminal.hiddenPrompts).toHaveLength(0);
    expect(result.stdout).toBe("");
  });

  it("S8: without a terminal, --email or auth.credentials, the sign-in is refused with exit 2 before any request", async () => {
    const terminal = fakeTerminal({ tty: false });
    const before = agent.getCallHistory()?.calls().length ?? 0;

    const result = await runCli(["auth", "signin", SLUG], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    // No interceptor is declared: the refusal comes before the lookup, so no request reaches the mock agent.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(NO_TERMINAL_MESSAGE);
    expect(result.stderr).toContain("--email");
    expect(result.stderr).toContain("auth.credentials");
    expect((agent.getCallHistory()?.calls().length ?? 0) - before).toBe(0);
    expect(terminal.visiblePrompts).toHaveLength(0);
    expect(terminal.hiddenPrompts).toHaveLength(0);
  });

  it("S10: no container id in the lookup and no --container-id is refused with exit 2 and the explanation, and no login", async () => {
    interceptLookup();
    const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });
    const loginsBefore = loginCalls();

    const result = await runCli(["auth", "signin", SLUG, "--email", FIXTURE_EMAIL], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(CONTAINER_ID_MISSING_MESSAGE);
    expect(loginCalls() - loginsBefore).toBe(0);
    expect(terminal.hiddenPrompts).toHaveLength(0);
  });

  it("S10: --container-id wins over the lookup and the output names its source", async () => {
    interceptLookup({ containerId: 3 });
    interceptLogin();
    const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });

    const result = await runCli(["auth", "signin", SLUG, "--container-id", "9840", "--email", FIXTURE_EMAIL], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`container 9840, container id from --container-id`);
    expect(await configText()).toContain("container_id: 9840");
  });

  it("S10: a --container-id that is not a positive integer is a usage error, exit 2, with no login request", async () => {
    const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });
    interceptLookup({ containerId: 3 });
    const loginsBefore = loginCalls();
    const result = await runCli(["auth", "signin", SLUG, "--container-id", "zero", "--email", FIXTURE_EMAIL], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--container-id must be a positive integer");
    expect(loginCalls() - loginsBefore).toBe(0);
  });

  it("S11: signing in to a second event replaces the one stored session and says so", async () => {
    const other = fixtureSecrets();
    await writeFile(
      home.configFile,
      `version: 1\nsession:\n  slug: wsai25\n  container_id: 2\n  token: ${other.sessionToken}\n  signed_in_at: 2026-10-01T10:00:00Z\n  auth_failed_at: 2026-10-02T10:00:00Z\nwrites:\n  enabled: true\n`,
      { mode: 0o600 },
    );
    interceptLookup({ containerId: CONTAINER_ID, slug: "wsai26" });
    interceptLogin();
    const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });

    const result = await runCli(["auth", "signin", "wsai26", "--email", FIXTURE_EMAIL], {
      terminal: terminal.terminal,
      dispatcher: agent,
      clock: clockAt(),
      env: home.env,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("replaced the session for wsai25");
    const text = await configText();
    expect(text.match(/^session:/gm)).toHaveLength(1);
    expect(text).toContain("slug: wsai26");
    expect(text).not.toContain("wsai25");
    expect(text).not.toContain(other.sessionToken);
    expect(text).toContain(secrets.sessionToken);
    expect(text).not.toContain("auth_failed_at");
    expect(text).toContain("enabled: true");
  });

  it.skipIf(!STUB_OP_SUPPORTED)(
    "S6: auth.credentials reads the email and the password from the 1Password item through `op item get`, with no prompt (POSIX only: the stub op is a shell script)",
    async () => {
      await writeFile(
        home.configFile,
        `version: 1\nauth:\n  credentials: op://Vault/Item\nwrites:\n  enabled: false\n`,
        {
          mode: 0o600,
        },
      );
      const fields = JSON.stringify([
        { id: "username", type: "STRING", label: "username", value: FIXTURE_EMAIL },
        { id: "password", type: "CONCEALED", label: "password", value: secrets.password },
      ]);
      const stub = await stubOp(`printf '%s\\n' '${fields}'`);
      try {
        interceptLookup({ containerId: CONTAINER_ID });
        interceptLogin();
        const terminal = fakeTerminal({ tty: false });

        const result = await runCli(["auth", "signin", SLUG], {
          terminal: terminal.terminal,
          dispatcher: agent,
          clock: clockAt(),
          env: { ...home.env, PATH: stub.path },
        });

        expect(result.exitCode, result.stderr).toBe(0);
        expect(terminal.visiblePrompts).toHaveLength(0);
        expect(terminal.hiddenPrompts).toHaveLength(0);
        const calls = await stub.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.argv).toEqual([
          "item",
          "get",
          "Item",
          "--vault",
          "Vault",
          "--format",
          "json",
          "--fields",
          "label=username,label=password",
        ]);
        const login = agent
          .getCallHistory()
          ?.calls()
          .filter((call) => call.path === "/1/user/account/login")
          .at(-1);
        expect(login).toBeDefined();
        const authorization = Object.entries(login?.headers ?? {}).find(
          ([name]) => name.toLowerCase() === "authorization",
        );
        expect(authorization?.[1]).toBe(`Bearer ${secrets.applicationToken}, Basic ${secrets.basic}`);
        expect(result.stdout + result.stderr).not.toContain(secrets.password);
        expect(result.stdout + result.stderr).not.toContain(secrets.basic);
      } finally {
        await stub.remove();
      }
    },
  );

  it.skipIf(!STUB_OP_SUPPORTED)(
    "S7: a session.token op:// reference receives the fresh token through `op item edit` with the template on stdin and stays a reference (POSIX only: the stub op is a shell script)",
    async () => {
      const reference = "op://Vault/Item/token";
      await writeFile(
        home.configFile,
        `version: 1\nsession:\n  slug: ${SLUG}\n  container_id: ${String(CONTAINER_ID)}\n  token: ${reference}\n  signed_in_at: 2026-10-01T10:00:00Z\nwrites:\n  enabled: false\n`,
        { mode: 0o600 },
      );
      const stub = await stubOp(`printf '%s\\n' '{"id":"item1"}'`);
      try {
        interceptLookup({ containerId: CONTAINER_ID });
        interceptLogin();
        const terminal = fakeTerminal({ tty: true, hiddenAnswers: [secrets.password] });

        const result = await runCli(["auth", "signin", SLUG, "--email", FIXTURE_EMAIL], {
          terminal: terminal.terminal,
          dispatcher: agent,
          clock: clockAt(),
          env: { ...home.env, PATH: stub.path },
        });

        expect(result.exitCode, result.stderr).toBe(0);
        const calls = await stub.calls();
        expect(calls).toHaveLength(1);
        const call = calls[0];
        expect(call?.argv).toEqual(["item", "edit", "Item", "--vault", "Vault", "--format", "json"]);
        expect(call?.argv.join(" ")).not.toContain(secrets.sessionToken);
        expect(JSON.parse(call?.stdin ?? "")).toEqual({
          fields: [{ label: "token", type: "CONCEALED", value: secrets.sessionToken }],
        });
        const text = await configText();
        expect(text).toContain(`token: ${reference}`);
        expect(text).not.toContain(secrets.sessionToken);
        expect(text).toContain(`signed_in_at: ${SIGNED_IN_AT}`);
        expect(result.stdout + result.stderr).not.toContain(secrets.sessionToken);
      } finally {
        await stub.remove();
      }
    },
  );
});
