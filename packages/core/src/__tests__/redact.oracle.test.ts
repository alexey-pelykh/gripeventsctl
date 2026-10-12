// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Oracle for CAP-REDACT, the transport client's share: every secret shape and every registered
 * live value is redacted on every path, the registry stays in memory, and the lint patterns leave
 * the `docs/api/` placeholders alone. The repository-gate cases of the leakage script are not
 * oracles. Written before the subject's new exports exist; the implementing change leaves this
 * file byte-identical. Every helper the file needs lives inside it. The existing `redact.test.ts`
 * stays as it is.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, type Dispatcher } from "undici";

// The contract this oracle grades, as the config and transport items fix it.
interface RedactModule {
  REDACTED: string;
  SECRET_PATTERN_SOURCES: readonly string[];
  RUNTIME_ONLY_PATTERN_SOURCES: readonly string[];
  registerSecret(value: string): void;
  redactString(input: string): string;
}

interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

interface GripClientOptions {
  dispatcher?: Dispatcher;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  stderr?: NodeJS.WritableStream;
}

interface GripClientInstance {
  get<T>(path: string, opts?: { query?: Record<string, string | number> }): Promise<T>;
}

interface ClientModule {
  GripClient: new (opts?: GripClientOptions) => GripClientInstance;
}

interface GripErrorShape {
  kind: string;
  message: string;
  hint: string;
  status?: number;
  bodyExcerpt?: string;
  cause?: unknown;
}

// Oracle subjects: packages/core/src/lib/redact.ts, which exists but gains `registerSecret` and
// `RUNTIME_ONLY_PATTERN_SOURCES` from the transport item, and transport/client.ts (not built yet when this file was written).
const redactModule = (await import("../lib/redact.js").catch(() => undefined)) as Partial<RedactModule> | undefined;
const redact =
  redactModule !== undefined &&
  typeof redactModule.registerSecret === "function" &&
  Array.isArray(redactModule.RUNTIME_ONLY_PATTERN_SOURCES)
    ? (redactModule as RedactModule)
    : undefined;
const client = (await import("../transport/client.js").catch(() => undefined)) as ClientModule | undefined;
const missing = [
  ...(redact === undefined ? ["packages/core/src/lib/redact.ts (registerSecret, RUNTIME_ONLY_PATTERN_SOURCES)"] : []),
  ...(client === undefined ? ["packages/core/src/transport/client.ts"] : []),
];
if (missing.length > 0 && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}

const API_ORIGIN = "https://api-prod.grip.events";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const REDACT_SOURCE = fileURLToPath(new URL("../lib/redact.ts", import.meta.url));

// ---------------------------------------------------------------------------------------------
// Helpers: per-run secrets, a clock, a stderr sink, a temporary home with a session.
// ---------------------------------------------------------------------------------------------

interface Secrets {
  sessionToken: string;
  chatToken: string;
  applicationToken: string;
  password: string;
  basic: string;
}

/** Secret-shaped values are generated per run; none is a literal in this file. */
function fixtureSecrets(): Secrets {
  const segment = (bytes: number): string => randomBytes(bytes).toString("base64url");
  const password = segment(18);
  return {
    sessionToken: randomUUID(),
    chatToken: `eyJ${segment(24)}.${segment(60)}.${segment(32)}`,
    applicationToken: randomBytes(16).toString("hex"),
    password,
    basic: Buffer.from(`test.person.1@example.com:${password}`, "utf8").toString("base64"),
  };
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

/** A `Clock` whose sleeps advance time at once; nothing in this file waits on it. */
class AutoClock implements Clock {
  private current = Date.UTC(2026, 9, 12, 12, 0, 0);
  private readonly timeouts: { due: number; controller: AbortController }[] = [];

  now(): Date {
    return new Date(this.current);
  }

  sleep(ms: number): Promise<void> {
    this.current += ms;
    for (const timeout of this.timeouts.filter((entry) => entry.due <= this.current)) {
      timeout.controller.abort(new Error("fake clock: request timeout"));
    }
    return Promise.resolve();
  }

  timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    this.timeouts.push({ due: this.current + ms, controller });
    return controller.signal;
  }
}

class Sink extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

interface Home {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** A fresh home holding a version-1 config with one session, mode 0600, as the config item fixes it. */
async function tempHome(sessionToken: string): Promise<Home> {
  const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-"));
  const configFile = join(dir, ".gripeventsctl.yaml");
  const yaml = [
    "version: 1",
    "session:",
    '  slug: "testevent"',
    "  container_id: 1",
    `  token: "${sessionToken}"`,
    '  signed_in_at: "2026-10-12T11:00:00Z"',
    "writes:",
    "  enabled: false",
    "",
  ].join("\n");
  await writeFile(configFile, yaml, { mode: 0o600 });
  return { dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, GRIPEVENTSCTL_CONFIG_FILE: configFile } };
}

function matches(sources: readonly string[], text: string): string[] {
  const found: string[] = [];
  for (const source of sources) {
    for (const match of text.matchAll(new RegExp(source, "gi"))) found.push(match[0]);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------

describe.skipIf(redact === undefined)(
  "[CAP-REDACT] every secret shape and every live value is redacted on every path",
  () => {
    function subject(): RedactModule {
      if (redact === undefined) throw new Error("unreachable: the describe is skipped");
      return redact;
    }

    describe("unit", () => {
      it("U1: a session token after `user_token` or `x-authorization` is replaced and the key stays", () => {
        const { redactString, REDACTED } = subject();
        const token = randomUUID();
        expect(redactString(`user_token: ${token}`)).toBe(`user_token: ${REDACTED}`);
        expect(redactString(`X-Authorization: ${token}`)).toBe(`X-Authorization: ${REDACTED}`);
        expect(redactString(`{"user_token":"${token}"}`)).toBe(`{"user_token":"${REDACTED}"}`);
      });

      it("U2: a JWT-shaped chat token is replaced wherever it appears", () => {
        const { redactString, REDACTED } = subject();
        const { chatToken } = fixtureSecrets();
        expect(redactString(`"Token": "${chatToken}"`)).toBe(`"Token": "${REDACTED}"`);
        expect(redactString(`chat ${chatToken} end`)).toBe(`chat ${REDACTED} end`);
      });

      it("U3: the login `Authorization` value `Bearer <x>, Basic <y>` is replaced and the header name stays (value open: whether the scheme words stay)", () => {
        const { redactString, REDACTED } = subject();
        const { applicationToken, basic } = fixtureSecrets();
        const line = `Authorization: Bearer ${applicationToken}, Basic ${basic}`;
        const out = redactString(line);
        expect(out.startsWith("Authorization: ")).toBe(true);
        expect(out).toContain(REDACTED);
        expect(out).not.toContain(applicationToken);
        expect(out).not.toContain(basic);
        expect(matches(subject().SECRET_PATTERN_SOURCES, line)).not.toHaveLength(0);
      });

      it("U4: a `Basic <y>` value alone is replaced and the header name stays", () => {
        const { redactString, REDACTED } = subject();
        const { basic } = fixtureSecrets();
        const line = `Authorization: Basic ${basic}`;
        const out = redactString(line);
        expect(out.startsWith("Authorization: ")).toBe(true);
        expect(out).toContain(REDACTED);
        expect(out).not.toContain(basic);
        expect(matches(subject().SECRET_PATTERN_SOURCES, line)).not.toHaveLength(0);
      });

      it("U5: the application token under a `general.token` key is replaced and the key stays", () => {
        const { redactString, REDACTED } = subject();
        const { applicationToken } = fixtureSecrets();
        const json = `{"application": {"general": {"token": "${applicationToken}", "application_id": 1}}}`;
        const outJson = redactString(json);
        expect(outJson).toContain('"token"');
        expect(outJson).toContain(REDACTED);
        expect(outJson).not.toContain(applicationToken);
        expect(outJson).toContain('"application_id": 1');
        const dotted = `general.token: ${applicationToken}`;
        const outDotted = redactString(dotted);
        expect(outDotted.startsWith("general.token")).toBe(true);
        expect(outDotted).toContain(REDACTED);
        expect(outDotted).not.toContain(applicationToken);
        expect(matches(subject().SECRET_PATTERN_SOURCES, json)).not.toHaveLength(0);
      });

      it("U6: a bare `Bearer <x>` is replaced at run time only: the lint patterns leave it, the runtime-only patterns match it", () => {
        const { redactString, REDACTED, SECRET_PATTERN_SOURCES, RUNTIME_ONLY_PATTERN_SOURCES } = subject();
        const { applicationToken } = fixtureSecrets();
        const line = `Authorization: Bearer ${applicationToken}`;
        const out = redactString(line);
        expect(out.startsWith("Authorization: ")).toBe(true);
        expect(out).toContain(REDACTED);
        expect(out).not.toContain(applicationToken);
        expect(RUNTIME_ONLY_PATTERN_SOURCES.length).toBeGreaterThan(0);
        expect(matches(SECRET_PATTERN_SOURCES, line)).toEqual([]);
        expect(matches(RUNTIME_ONLY_PATTERN_SOURCES, line)).not.toHaveLength(0);
      });

      const registered: [string, (secrets: Secrets) => string][] = [
        ["U7: the registered session token", (secrets) => secrets.sessionToken],
        ["U8: the registered chat token", (secrets) => secrets.chatToken],
        ["U9: the registered application token", (secrets) => secrets.applicationToken],
        ["U10: the registered password", (secrets) => secrets.password],
        ["U11: the registered Basic value", (secrets) => secrets.basic],
      ];

      it.each(registered)("%s gives zero bare occurrences wherever it appears", (_title, pick) => {
        const { registerSecret, redactString, REDACTED } = subject();
        const value = pick(fixtureSecrets());
        const line = `before ${value} middle ${value} after`;
        registerSecret(value);
        const out = redactString(line);
        expect(occurrences(out, value)).toBe(0);
        expect(out).toContain(REDACTED);
        expect(out.startsWith("before ")).toBe(true);
        expect(out.endsWith(" after")).toBe(true);
        expect(occurrences(redactString(value), value)).toBe(0);
      });

      it("U12: the registry never touches the file system: the module imports no file or process API, and a run leaves the temporary home empty", async () => {
        const { registerSecret, redactString } = subject();
        const source = await readFile(REDACT_SOURCE, "utf8");
        const importedModules = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
        const forbidden = ["fs", "node:fs", "fs/promises", "node:fs/promises", "child_process", "node:child_process"];
        expect(importedModules.filter((name) => name !== undefined && forbidden.includes(name))).toEqual([]);
        expect(source).not.toMatch(/\brequire\s*\(/);

        const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-"));
        const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TMPDIR: process.env.TMPDIR };
        try {
          process.env.HOME = dir;
          process.env.USERPROFILE = dir;
          for (let i = 0; i < 50; i += 1) {
            const secrets = fixtureSecrets();
            registerSecret(secrets.sessionToken);
            registerSecret(secrets.basic);
            redactString(`user_token: ${secrets.sessionToken} and ${secrets.basic}`);
          }
          expect(await readdir(dir)).toEqual([]);
        } finally {
          for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) Reflect.deleteProperty(process.env, name);
            else process.env[name] = value;
          }
          await rm(dir, { recursive: true, force: true });
        }
      });

      it("U13: the lint patterns leave the docs/api placeholders alone, on the current pages and on the placeholder forms; the printed bootstrap bearer is a runtime-only match", async () => {
        const { redactString, SECRET_PATTERN_SOURCES, RUNTIME_ONLY_PATTERN_SOURCES } = subject();
        const docsDir = join(REPO_ROOT, "docs", "api");
        const pages = (await readdir(docsDir)).filter((name) => name.endsWith(".md")).sort();
        expect(pages.length).toBeGreaterThan(0);
        for (const page of pages) {
          const text = await readFile(join(docsDir, page), "utf8");
          expect(matches(SECRET_PATTERN_SOURCES, text), `${page} must hold no lint-pattern match`).toEqual([]);
        }
        // The config lookup page prints the public bootstrap bearer as `Bearer <value>`; only the runtime list may match it.
        const containers = await readFile(join(docsDir, "containers.md"), "utf8");
        expect(matches(RUNTIME_ONLY_PATTERN_SOURCES, containers).length).toBeGreaterThan(0);

        const placeholders = [
          "X-Authorization: <user_token>",
          '-H "X-Authorization: $GRIPEVENTSCTL_TOKEN"',
          '"user_token": "<session token: a 36-character UUID>"',
          '"Token": "<AWS Cognito token: a JWT about 1,000 characters long>"',
          "Authorization: Bearer <application_token>, Basic <base64(email:password)>",
          "Authorization: Bearer $APPLICATION_TOKEN, Basic $BASIC",
        ];
        for (const placeholder of placeholders) {
          expect(matches(SECRET_PATTERN_SOURCES, placeholder), placeholder).toEqual([]);
        }
        for (const placeholder of placeholders.slice(0, 3)) {
          expect(redactString(placeholder)).toBe(placeholder);
        }
      });
    });

    describe("component", () => {
      let agent: MockAgent;
      let home: Home;
      let secrets: Secrets;
      let stderr: Sink;
      const savedEnv: Record<string, string | undefined> = {};

      beforeEach(async () => {
        secrets = fixtureSecrets();
        home = await tempHome(secrets.sessionToken);
        for (const name of ["HOME", "USERPROFILE", "GRIPEVENTSCTL_CONFIG_FILE"]) {
          savedEnv[name] = process.env[name];
          process.env[name] = home.env[name];
        }
        agent = new MockAgent();
        agent.disableNetConnect();
        agent.enableCallHistory();
        stderr = new Sink();
      });

      afterEach(async () => {
        agent.assertNoPendingInterceptors();
        await agent.close();
        for (const [name, value] of Object.entries(savedEnv)) {
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
        await rm(home.dir, { recursive: true, force: true });
      });

      it.skipIf(client === undefined)(
        "C14: the client's diagnostic sinks, the injected stderr and the error, hold no secret shape, no registered value, no header value and no body",
        async () => {
          if (client === undefined) throw new Error("unreachable: the describe is skipped");
          const { registerSecret } = subject();
          // The auth and transport items register these as they handle them; the session token is registered when it is resolved from the config.
          registerSecret(secrets.password);
          registerSecret(secrets.basic);
          registerSecret(secrets.applicationToken);
          registerSecret(secrets.chatToken);
          const reason = [
            `user_token: ${secrets.sessionToken}`,
            secrets.sessionToken,
            secrets.chatToken,
            secrets.password,
            `Authorization: Basic ${secrets.basic}`,
            `Authorization: Bearer ${secrets.applicationToken}`,
            `{"general": {"token": "${secrets.applicationToken}"}}`,
            "synthetic marker 1",
            "x".repeat(300),
          ].join(" ");
          // Fixture: docs/api/README.md § Response envelope (`success: false`, `data` carries the reason).
          agent
            .get(API_ORIGIN)
            .intercept({ path: "/1/container", method: "GET" })
            .reply(200, JSON.stringify({ success: false, data: reason }), {
              headers: { "content-type": "application/json" },
            });
          const transport = new client.GripClient({ dispatcher: agent, clock: new AutoClock(), env: home.env, stderr });

          const error = await transport.get("container").then(
            () => undefined,
            (thrown: unknown) => thrown,
          );

          expect(error).toBeInstanceOf(Error);
          const gripError = error as Error & GripErrorShape;
          expect(gripError.kind).toBe("api");
          expect(agent.getCallHistory()?.calls()).toHaveLength(1);
          const sinks: Record<string, string> = {
            message: gripError.message,
            string: String(gripError),
            json: JSON.stringify(gripError),
            bodyExcerpt: gripError.bodyExcerpt ?? "",
            cause: gripError.cause === undefined ? "" : `${String(gripError.cause)} ${JSON.stringify(gripError.cause)}`,
            stderr: stderr.text,
          };
          for (const [sink, text] of Object.entries(sinks)) {
            for (const [name, value] of Object.entries(secrets)) {
              expect(occurrences(text, value), `${sink} holds the ${name}`).toBe(0);
            }
          }
          expect(stderr.text).not.toContain("synthetic marker 1");
          if (gripError.bodyExcerpt !== undefined) expect(gripError.bodyExcerpt.length).toBeLessThanOrEqual(200);
        },
      );
    });
  },
);
