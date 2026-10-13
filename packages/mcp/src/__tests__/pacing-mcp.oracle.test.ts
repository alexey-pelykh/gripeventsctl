// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-PACING, surface level, case S5: two MCP tool calls issued together
 * over the in-memory transport are serialised, because the client keeps one request in flight per
 * process. It drives the real MCP server over a mocked platform and never reaches the network. The
 * implementing pull request leaves this file byte-identical.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

// The contract this oracle grades, as the registry item fixes it in its Specification.
interface OracleOperationContext {
  client: { lookupConfig(slug: string): Promise<unknown> };
  source: "cli" | "mcp";
}
interface OracleOperation {
  group: string;
  verb: string;
  kind: "read" | "write";
  description: string;
  needsSession: boolean;
  input: z.ZodObject;
  output: z.ZodType;
  requests: readonly { method: "GET" | "POST"; pathTemplate: string; page: string; section: string }[];
  cli?: { positional?: readonly string[] };
  run(ctx: OracleOperationContext, input: Record<string, unknown>): Promise<unknown>;
}
interface ServerDeps {
  operations?: readonly OracleOperation[];
  env?: NodeJS.ProcessEnv;
  dispatcher?: unknown;
  stderr?: Writable;
}
interface ServerModule {
  buildServer(version?: string, deps?: ServerDeps): unknown;
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
interface ReplyOptions {
  statusCode: number;
  data: string;
  responseOptions?: { headers?: Record<string, string> };
}
interface MockPoolLike {
  intercept(options: { path: string | ((path: string) => boolean); method: string }): {
    reply(callback: (options: { path: string }) => ReplyOptions | Promise<ReplyOptions>): unknown;
  };
}
interface MockAgentLike {
  get(origin: string): MockPoolLike;
  getCallHistory(): { calls(): { path: string; searchParams: Record<string, string> }[] } | undefined;
}
interface TestingModule {
  linkMcp(server: unknown): Promise<McpLink>;
  mockGrip(): MockAgentLike | { agent: MockAgentLike };
  fixtureSecrets(): { applicationToken: string };
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

// Oracle subject: packages/mcp/src/lib/tool-from-operation.ts (not built yet when this file was
// written), reached through `buildServer(version, deps)`, plus the shared test package of the test
// helpers item.
const toolBuilder = await importSubject("../lib/tool-from-operation.js");
const serverEntry = (await importSubject("../index.js")) as ServerModule | undefined;
const testing = (await importSubject("@gripeventsctl/testing")) as TestingModule | undefined;
const missing: string[] = [];
if (toolBuilder === undefined || serverEntry === undefined) missing.push("packages/mcp/src/lib/tool-from-operation.ts");
if (testing === undefined) missing.push("packages/testing/src/index.ts");
const subject =
  missing.length === 0 && serverEntry !== undefined && testing !== undefined
    ? { server: serverEntry, testing }
    : undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}

const API_ORIGIN = "https://api-prod.grip.events";

class Sink extends Writable {
  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

/** A promise the test settles by hand, to hold one mocked answer back. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * A read operation that sends one documented request and needs no session: the config lookup by
 * slug (`docs/api/containers.md` § Config by slug). Two calls of it from one server share the
 * process-wide request queue.
 */
const probeOperation: OracleOperation = {
  group: "pacing",
  verb: "probe",
  kind: "read",
  description: "Look one slug up to probe the request queue",
  needsSession: false,
  input: z.object({ slug: z.string().min(1) }),
  output: z.object({ name: z.string() }),
  requests: [
    { method: "GET", pathTemplate: "config?container_name=<slug>", page: "containers.md", section: "Config by slug" },
  ],
  cli: { positional: ["slug"] },
  async run(ctx, input) {
    const data = (await ctx.client.lookupConfig(String(input["slug"]))) as { container: { general: { name: string } } };
    return { name: data.container.general.name };
  },
};

// docs/api/containers.md § Config by slug and § Fields of a 200 answer: the documented 200 answer, with
// the per-event application token generated per run.
function configAnswer(slug: string, applicationToken: string): ReplyOptions {
  return {
    statusCode: 200,
    responseOptions: { headers: { "content-type": "application/json" } },
    data: JSON.stringify({
      success: true,
      data: {
        container: { general: { display_name: `Test Event ${slug}`, name: slug, active: 1 } },
        application: {
          general: { application_name: "Example Org 1", application_id: 1, token: applicationToken },
          permissions: { type_permissions: {} },
        },
      },
    }),
  };
}

const home = subject === undefined ? "" : await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-pacing-"));

describe.skipIf(subject === undefined)("[CAP-PACING] one request in flight per process, on the MCP path too", () => {
  // A skipped `describe` still runs this callback to collect its tests, so nothing here may
  // dereference a missing subject; the test itself runs only when it exists.
  const live = (): NonNullable<typeof subject> => {
    if (subject === undefined) throw new Error("unreachable: the suite is skipped without its subject");
    return subject;
  };
  const grip = subject?.testing.mockGrip();
  const agent: MockAgentLike | undefined = grip === undefined ? undefined : "agent" in grip ? grip.agent : grip;
  const secrets = subject?.testing.fixtureSecrets() ?? { applicationToken: "" };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GRIPEVENTSCTL_CONFIG_FILE: join(home, ".gripeventsctl.yaml"),
  };

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  describe("surface", () => {
    it("S5: two tool calls issued together over the in-memory transport are serialised: the second request leaves only after the first answered", async () => {
      const pool = (agent as MockAgentLike).get(API_ORIGIN);
      const firstReached = deferred<undefined>();
      const firstRelease = deferred<ReplyOptions>();
      let secondReached = false;

      pool.intercept({ path: (p) => p === "/1/config?container_name=test-event-1", method: "GET" }).reply(() => {
        firstReached.resolve(undefined);
        return firstRelease.promise;
      });
      pool.intercept({ path: (p) => p === "/1/config?container_name=test-event-2", method: "GET" }).reply(() => {
        secondReached = true;
        return configAnswer("test-event-2", secrets.applicationToken);
      });

      const mcpServer = live().server.buildServer("0.0.0", {
        operations: [probeOperation],
        env,
        dispatcher: agent,
        stderr: new Sink(),
      });
      const link = await live().testing.linkMcp(mcpServer);
      try {
        const first = link.callTool("gripeventsctl_pacing_probe", { slug: "test-event-1" });
        const second = link.callTool("gripeventsctl_pacing_probe", { slug: "test-event-2" });

        // The first request is in flight and held back; the second must not have left the process.
        await firstReached.promise;
        await settle();
        expect(secondReached).toBe(false);

        firstRelease.resolve(configAnswer("test-event-1", secrets.applicationToken));
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(secondReached).toBe(true);
        expect(firstResult.isError).toBeFalsy();
        expect(secondResult.isError).toBeFalsy();
        expect(firstResult.structuredContent).toEqual({ name: "test-event-1" });
        expect(secondResult.structuredContent).toEqual({ name: "test-event-2" });

        // The call history shows two requests, in the order the calls were issued.
        const slugs = ((agent as MockAgentLike).getCallHistory()?.calls() ?? [])
          .filter((call) => call.path === "/1/config")
          .map((call) => call.searchParams["container_name"]);
        expect(slugs).toEqual(["test-event-1", "test-event-2"]);
      } finally {
        await link.close();
      }
    });
  });
});
