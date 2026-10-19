// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-PARITY, CAP-OUTPUT, CAP-TERMINAL-ESCAPING and CAP-PACING, surface: the MCP builder (issue #9 § The MCP
 * builder). The tool
 * list and its schemas (AC-03), the redaction backstop on the MCP forms (AC-08), the extra and the missing field
 * (AC-09), the hostile-input table on the text block with `structuredContent` kept raw (AC-10), the `isError` shape
 * and the text block's equality with the CLI's non-TTY rendering (AC-11), the session check without a request (AC-12),
 * the config loaded per call (AC-13), the input-key ban, the posture sentences and the annotations (AC-15), the
 * read call that writes nothing (AC-16) and, behind S5 of the pacing oracle, two calls issued together handled one
 * at a time in arrival order, driven through the real server over an in-memory link with the synthetic operation
 * registered, a temporary home, the mock agent and a fake clock.
 *
 * Every error result is read on a link that never called `tools/list`: the SDK 1.32.1 client validates
 * `structuredContent` against the cached output schema on error results too, once it has listed the tools.
 */

import { readdir, writeFile } from "node:fs/promises";

import { GripError, OPERATIONS, registerSecret } from "@gripeventsctl/core";
import {
  type McpLink,
  fakeClock,
  fakeTerminal,
  fixtureSecrets,
  linkMcp,
  mockGrip,
  runCli,
  withTempHome,
} from "@gripeventsctl/testing";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { echoOutput, syntheticOperation } from "../../../core/src/__tests__/fixtures/synthetic-operation.js";
import { buildServer } from "../index.js";
import { READ_BOUNDARY, READ_POSTURE, WRITE_BOUNDARY, WRITE_POSTURE, toolName } from "../lib/tool-from-operation.js";

const agent = mockGrip();

function requests(): number {
  return agent.getCallHistory()?.calls().length ?? 0;
}

class Sink {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A fresh server over `env` with `operations`, linked in memory; the caller closes the link. */
async function link(env: NodeJS.ProcessEnv, operations: unknown[]): Promise<McpLink> {
  return linkMcp(buildServer("1.2.3", { operations, env, clock: fakeClock(), dispatcher: agent, stderr: new Sink() }));
}

async function withLink<T>(env: NodeJS.ProcessEnv, operations: unknown[], fn: (l: McpLink) => Promise<T>): Promise<T> {
  const l = await link(env, operations);
  try {
    return await fn(l);
  } finally {
    await l.close();
  }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

/** `record` without `key`: the answer that lacks one documented field. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}

const ECHO_ARGS = { thing_id: 42, type_ids: [1] };

/** The hostile inputs and the visible form of each: the escape sequences, then one code point per hostile range. */
const HOSTILE: [string, string][] = [
  ["\x1b]0;x\x07", "\\x1b]0;x\\x07"],
  ["\x1b[2J", "\\x1b[2J"],
  ["\x07", "\\x07"],
  [String.fromCodePoint(0x85), "\\x85"],
  ...[0x202e, 0x2066, 0x200b, 0xfeff].map((codePoint): [string, string] => [
    String.fromCodePoint(codePoint),
    `\\u{${codePoint.toString(16)}}`,
  ]),
];

/** True for a code point the specification says never reaches a terminal raw. */
function isHostileCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0xfeff
  );
}

function rawHostile(text: string): string[] {
  return [...text].filter((ch) => isHostileCodePoint(ch.codePointAt(0) ?? -1));
}

describe("[CAP-PARITY] [CAP-OUTPUT] [CAP-TERMINAL-ESCAPING] [CAP-PACING] the MCP builder: one tool per operation with the same schemas, a text block and structured content", () => {
  describe("surface", () => {
    it("AC-03: tools/list holds gripeventsctl_synthetic_echo with the five input properties, the CLI's requiredness and defaults, and the object output schema itself", async () => {
      await withTempHome(async (home) => {
        await withLink(home.env, [syntheticOperation()], async (l) => {
          const tools = await l.listTools();
          expect(tools.map((tool) => tool.name)).toEqual(["gripeventsctl_synthetic_echo"]);
          const tool = tools[0];
          if (tool === undefined) throw new Error("no tool");
          const input = tool.inputSchema as {
            properties: Record<string, Record<string, unknown>>;
            required?: string[];
          };
          expect(Object.keys(input.properties)).toEqual(["thing_id", "type_ids", "page", "dry_run", "message"]);
          expect([...(input.required ?? [])].sort()).toEqual(["thing_id", "type_ids"]);
          expect(input.properties["page"]?.["default"]).toBe(1);
          expect(input.properties["dry_run"]?.["default"]).toBe(false);
          expect(input.properties["message"]?.["type"]).toBe("string");
          const output = tool.outputSchema as { properties: Record<string, unknown> } | undefined;
          expect(output).toBeDefined();
          expect(Object.keys(output?.properties ?? {})).toEqual([
            "thing_id",
            "type_ids",
            "page",
            "dry_run",
            "message",
            "token",
            "text",
            "epoch",
          ]);
        });
      });
    });

    it("AC-03: an array output is published as { items } and the result's structuredContent is { items }", async () => {
      await withTempHome(async (home) => {
        const records = [{ id: 1, name: "Test Person 1" }];
        const operation = syntheticOperation({
          output: z.array(z.object({ id: z.number(), name: z.string() })),
          run: () => Promise.resolve(records),
        });
        await withLink(home.env, [operation], async (l) => {
          const [tool] = await l.listTools();
          const output = tool?.outputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
          expect(Object.keys(output.properties)).toEqual(["items"]);
          expect(output.properties["items"]?.type).toBe("array");
          expect(output.required).toEqual(["items"]);
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toEqual({ items: records });
          expect(textOf(result)).toBe("id | name\n1 | Test Person 1");
        });
      });
    });

    it("AC-08: a registered fixture secret in a record reaches neither the text block nor structuredContent; each holds <REDACTED>", async () => {
      await withTempHome(async (home) => {
        const { sessionToken } = fixtureSecrets();
        registerSecret(sessionToken);
        const operation = syntheticOperation({
          run: (_ctx, input) => Promise.resolve(echoOutput(input, { token: sessionToken })),
        });
        await withLink(home.env, [operation], async (l) => {
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(result.isError).toBeFalsy();
          const text = textOf(result);
          const structured = JSON.stringify(result.structuredContent);
          expect(occurrences(text, sessionToken)).toBe(0);
          expect(occurrences(structured, sessionToken)).toBe(0);
          expect(text).toContain("token: <REDACTED>");
          expect((result.structuredContent as { token: string }).token).toBe("<REDACTED>");
        });
      });
    });

    it("AC-09: an extra token-shaped field the output schema does not name reaches no output form, and the call succeeds", async () => {
      await withTempHome(async (home) => {
        const marker = "not-a-secret-marker-ac09-mcp";
        const operation = syntheticOperation({
          run: (_ctx, input) => Promise.resolve({ ...echoOutput(input), secret_token: marker }),
        });
        await withLink(home.env, [operation], async (l) => {
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(result.isError).toBeFalsy();
          expect(hasKeyDeep(result.structuredContent, "secret_token")).toBe(false);
          expect(textOf(result)).not.toContain("secret_token");
          expect(JSON.stringify(result)).not.toContain(marker);
        });
      });
    });

    it("AC-09: a documented field missing from the answer is an isError result of the api kind naming the field", async () => {
      await withTempHome(async (home) => {
        const operation = syntheticOperation({
          run: (_ctx, input) => Promise.resolve(without(echoOutput(input), "epoch")),
        });
        await withLink(home.env, [operation], async (l) => {
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(result.isError).toBe(true);
          const error = (result.structuredContent as { error: { kind: string; message: string } }).error;
          expect(error.kind).toBe("api");
          expect(error.message).toContain("epoch");
        });
      });
    });

    it.each(HOSTILE)(
      "AC-10: %j in a text field renders visibly in the text block, with no raw hostile code point, and structuredContent keeps it raw",
      async (input, visible) => {
        await withTempHome(async (home) => {
          const text = `Test Person 1 ${input} Example Org 1`;
          const operation = syntheticOperation({ run: (_ctx, i) => Promise.resolve(echoOutput(i, { text })) });
          await withLink(home.env, [operation], async (l) => {
            const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
            expect(result.isError).toBeFalsy();
            const block = textOf(result);
            expect(block).toContain(`text: Test Person 1 ${visible} Example Org 1`);
            expect(rawHostile(block)).toEqual([]);
            expect((result.structuredContent as { text: string }).text).toBe(text);
          });
        });
      },
    );

    it("AC-10: newline, tab and right-to-left letters pass through the text block unchanged", async () => {
      await withTempHome(async (home) => {
        const text = "line one\nline two\tcolumn שלום";
        const operation = syntheticOperation({ run: (_ctx, i) => Promise.resolve(echoOutput(i, { text })) });
        await withLink(home.env, [operation], async (l) => {
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(textOf(result)).toContain(`text: ${text}`);
        });
      });
    });

    it("AC-11: a GripError gives isError, structuredContent.error with kind, message and hint, the same JSON in the text block, every field redacted", async () => {
      await withTempHome(async (home) => {
        const { chatToken } = fixtureSecrets();
        const operation = syntheticOperation({
          run: () =>
            Promise.reject(new GripError("throttled", `throttled with ${chatToken}`, `wait; not ${chatToken}`)),
        });
        await withLink(home.env, [operation], async (l) => {
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(result.isError).toBe(true);
          const structured = result.structuredContent as { error: { kind: string; message: string; hint: string } };
          expect(Object.keys(structured)).toEqual(["error"]);
          expect(Object.keys(structured.error)).toEqual(["kind", "message", "hint"]);
          expect(structured.error.kind).toBe("throttled");
          expect(structured.error.message).toBe("throttled with <REDACTED>");
          expect(structured.error.hint).toBe("wait; not <REDACTED>");
          expect(result.content).toHaveLength(1);
          expect(JSON.parse(textOf(result))).toEqual(structured);
          expect(JSON.stringify(result)).not.toContain(chatToken);
        });
      });
    });

    it("AC-11: an exception that is not a GripError is the api kind with a redacted message, never thrown past the SDK", async () => {
      await withTempHome(async (home) => {
        const { chatToken } = fixtureSecrets();
        const operation = syntheticOperation({ run: () => Promise.reject(new TypeError(`broke with ${chatToken}`)) });
        await withLink(home.env, [operation], async (l) => {
          const result = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(result.isError).toBe(true);
          const error = (result.structuredContent as { error: { kind: string; message: string; hint: string } }).error;
          expect(error).toEqual({ kind: "api", message: "broke with <REDACTED>", hint: "" });
        });
      });
    });

    it("AC-11: a successful call's structuredContent validates against the output schema, and the text block equals the CLI's non-TTY human rendering", async () => {
      await withTempHome(async (home) => {
        const operation = syntheticOperation({ render: { epochFields: ["epoch"] } });
        const args = { thing_id: 42, type_ids: [5956, 5957], page: 2, dry_run: true, message: "hello" };
        const result = await withLink(home.env, [operation], (l) => l.callTool("gripeventsctl_synthetic_echo", args));
        expect(result.isError).toBeFalsy();
        expect(operation.output.safeParse(result.structuredContent).success).toBe(true);
        expect(result.structuredContent).toEqual(echoOutput(args));
        const cli = await runCli(
          ["synthetic", "echo", "42", "--type", "5956,5957", "--page", "2", "--dry-run", "--message", "hello"],
          {
            terminal: fakeTerminal().terminal,
            dispatcher: agent,
            clock: fakeClock(),
            env: home.env,
            operations: [operation],
            isTTY: false,
          },
        );
        expect(cli.exitCode, cli.stderr).toBe(0);
        expect(`${textOf(result)}\n`).toBe(cli.stdout);
        expect(textOf(result)).toContain("epoch: ");
      });
    });

    it("render.note is appended to the text block on its own line, as on the CLI, and is absent from structuredContent", async () => {
      await withTempHome(async (home) => {
        const note = "This list is also your connections list.";
        const operation = syntheticOperation({ render: { note } });
        const result = await withLink(home.env, [operation], (l) =>
          l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS),
        );
        expect(result.isError).toBeFalsy();
        expect(textOf(result).endsWith(`\n${note}`)).toBe(true);
        expect(result.structuredContent).toEqual(echoOutput({ ...ECHO_ARGS, page: 1, dry_run: false }));
        expect(JSON.stringify(result.structuredContent)).not.toContain("connections list");
        const cli = await runCli(["synthetic", "echo", "42", "--type", "1"], {
          terminal: fakeTerminal().terminal,
          dispatcher: agent,
          clock: fakeClock(),
          env: home.env,
          operations: [operation],
          isTTY: false,
        });
        expect(cli.exitCode, cli.stderr).toBe(0);
        expect(`${textOf(result)}\n`).toBe(cli.stdout);
      });
    });

    it("AC-12: over a home with no config, a needsSession false tool succeeds and a needsSession true tool is isError no-session naming the sign-in command, with no request", async () => {
      await withTempHome(async (home) => {
        const before = requests();
        const open = await withLink(home.env, [syntheticOperation({ needsSession: false })], (l) =>
          l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS),
        );
        expect(open.isError).toBeFalsy();
        const closed = await withLink(home.env, [syntheticOperation({ needsSession: true })], (l) =>
          l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS),
        );
        expect(closed.isError).toBe(true);
        const error = (closed.structuredContent as { error: { kind: string; hint: string } }).error;
        expect(error.kind).toBe("no-session");
        expect(error.hint).toContain("gripeventsctl auth signin <slug>");
        expect(JSON.parse(textOf(closed))).toEqual(closed.structuredContent);
        expect(requests() - before).toBe(0);
      });
    });

    it("AC-13: a session written to the config after the server started makes the next needsSession true call succeed", async () => {
      await withTempHome(async (home) => {
        await withLink(home.env, [syntheticOperation({ needsSession: true })], async (l) => {
          const first = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(first.isError).toBe(true);
          const { sessionToken } = fixtureSecrets();
          await writeFile(
            home.configFile,
            `version: 1\nsession:\n  slug: testevent1\n  container_id: 1\n  token: ${sessionToken}\n  signed_in_at: 2026-10-12T19:09:00Z\nwrites:\n  enabled: false\n`,
            { mode: 0o600 },
          );
          const second = await l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS);
          expect(second.isError).toBeFalsy();
          expect(second.structuredContent).toEqual(
            echoOutput({ thing_id: 42, type_ids: [1], page: 1, dry_run: false }),
          );
        });
      });
    });

    it("AC-15: no input schema names password, token, config_path or config; a read tool carries the two read sentences and { readOnlyHint: true }; a write tool the two write sentences and the destructive and open-world hints", async () => {
      await withTempHome(async (home) => {
        const operations = [syntheticOperation(), syntheticOperation({ verb: "poke", kind: "write" })];
        await withLink(home.env, operations, async (l) => {
          const tools = await l.listTools();
          expect(tools.map((tool) => tool.name)).toEqual([
            "gripeventsctl_synthetic_echo",
            "gripeventsctl_synthetic_poke",
          ]);
          for (const tool of tools) {
            const properties = Object.keys(
              (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
            );
            for (const banned of ["password", "token", "config_path", "config"])
              expect(properties).not.toContain(banned);
            expect(tool.name.startsWith("gripeventsctl_auth_")).toBe(false);
          }
          const [read, write] = tools;
          expect(read?.description).toContain("Echo the inputs back.");
          expect(read?.description).toContain(READ_POSTURE);
          expect(read?.description).toContain(READ_BOUNDARY);
          expect(read?.annotations).toEqual({ readOnlyHint: true });
          expect(write?.description).toContain(WRITE_POSTURE);
          expect(write?.description).toContain(WRITE_BOUNDARY);
          expect(write?.description).not.toContain(READ_POSTURE);
          expect(write?.annotations?.destructiveHint).toBe(true);
          expect(write?.annotations?.openWorldHint).toBe(true);
          expect(write?.annotations?.readOnlyHint).toBeUndefined();
        });
      });
    });

    it("AC-16: a read tool call over the synthetic operation leaves no new file in the temporary home", async () => {
      await withTempHome(async (home) => {
        const before = (await readdir(home.dir)).sort();
        const result = await withLink(home.env, [syntheticOperation()], (l) =>
          l.callTool("gripeventsctl_synthetic_echo", ECHO_ARGS),
        );
        expect(result.isError).toBeFalsy();
        expect((await readdir(home.dir)).sort()).toEqual(before);
      });
    });

    it("S5: two calls issued together are handled one at a time, in arrival order: the second call's run starts only after the first call returned", async () => {
      await withTempHome(async (home) => {
        const entered: unknown[] = [];
        const firstEntered = deferred();
        const hold = deferred();
        const operation = syntheticOperation({
          run: async (_ctx, input) => {
            entered.push(input.thing_id);
            if (input.thing_id === 1) {
              firstEntered.resolve();
              await hold.promise;
            }
            return echoOutput(input);
          },
        });
        await withLink(home.env, [operation], async (l) => {
          const first = l.callTool("gripeventsctl_synthetic_echo", { thing_id: 1, type_ids: [1] });
          const second = l.callTool("gripeventsctl_synthetic_echo", { thing_id: 2, type_ids: [1] });
          // The first call is held inside its run; the second call's run must not have started.
          await firstEntered.promise;
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(entered).toEqual([1]);
          hold.resolve();
          const [a, b] = await Promise.all([first, second]);
          expect(entered).toEqual([1, 2]);
          expect(a.isError).toBeFalsy();
          expect(b.isError).toBeFalsy();
          expect(a.structuredContent).toEqual(echoOutput({ thing_id: 1, type_ids: [1], page: 1, dry_run: false }));
          expect(b.structuredContent).toEqual(echoOutput({ thing_id: 2, type_ids: [1], page: 1, dry_run: false }));
        });
      });
    });

    it("AC-19: buildServer() with no argument builds the server over the registry: one tool per operation, in registry order", async () => {
      const l = await linkMcp(buildServer());
      try {
        expect((await l.listTools()).map((tool) => tool.name)).toEqual(OPERATIONS.map(toolName));
      } finally {
        await l.close();
      }
    });
  });
});
