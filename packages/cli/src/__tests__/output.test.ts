// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-OUTPUT and CAP-TERMINAL-ESCAPING, unit and surface: the output module (issue #9 § Output). The table and the
 * key-value forms on a TTY and on a pipe, `NO_COLOR` and the empty result (AC-06), the epoch rendering (AC-07), the
 * redaction backstop on the CLI forms (AC-08) and the hostile-input table on the human form, with `--json` kept raw
 * (AC-10), driven through the real program with the synthetic operation registered. The pure escaping function has
 * its own pre-authored oracle (`terminal-escaping.oracle.test.ts`); the unit cases here cover the rendering helpers.
 */

import { registerSecret } from "@gripeventsctl/core";
import {
  type RunCliIo,
  type TempHome,
  fakeClock,
  fakeTerminal,
  fixtureSecrets,
  mockGrip,
  runCli,
  withTempHome,
} from "@gripeventsctl/testing";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  SYNTHETIC_EPOCH,
  echoOutput,
  syntheticOperation,
} from "../../../core/src/__tests__/fixtures/synthetic-operation.js";
import { escapeForTerminal, redactOutput, renderHuman, writeOutput } from "../lib/output.js";

const agent = mockGrip();

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/;
const BOX_DRAWING = /[─-╿]/;

function io(home: TempHome, operations: unknown[], extra: Partial<RunCliIo> = {}): RunCliIo {
  return {
    terminal: fakeTerminal().terminal,
    dispatcher: agent,
    clock: fakeClock(),
    env: home.env,
    operations,
    ...extra,
  };
}

const records = [
  { id: 1, name: "Test Person 1", epoch: SYNTHETIC_EPOCH },
  { id: 2, name: "Test Person 2", epoch: SYNTHETIC_EPOCH + 60 },
];
const recordSchema = z.array(z.object({ id: z.number(), name: z.string(), epoch: z.number() }));

function listOperation(answer: unknown[] = records) {
  return syntheticOperation({
    output: recordSchema,
    render: { epochFields: ["epoch"], emptyText: "no synthetic results" },
    run: () => Promise.resolve(answer),
  });
}

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

/** One hostile row per code point: the label, the character and the visible form the specification fixes. */
function codePointRows(codePoints: readonly number[]): [string, string, string][] {
  return codePoints.map((codePoint) => [
    `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
    String.fromCodePoint(codePoint),
    `\\u{${codePoint.toString(16)}}`,
  ]);
}

const HOSTILE: [string, string, string][] = [
  ["an OSC title sequence", "\x1b]0;x\x07", "\\x1b]0;x\\x07"],
  ["a CSI clear-screen sequence", "\x1b[2J", "\\x1b[2J"],
  ["a BEL", "\x07", "\\x07"],
  ["the C1 control U+0085", String.fromCodePoint(0x85), "\\x85"],
  // The bidirectional embeddings, overrides and isolates, then the zero-width characters.
  ...codePointRows([
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0xfeff,
  ]),
];

class Capture {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe("[CAP-OUTPUT] [CAP-TERMINAL-ESCAPING] the output module: every form is projected, escaped and redacted at the last step", () => {
  const savedTz = process.env["TZ"];

  afterEach(() => {
    if (savedTz === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env["TZ"] = savedTz;
  });

  describe("unit", () => {
    it("renders an array of flat records as box-drawing rows on a TTY and as |-separated rows on a pipe, one column per key in schema order", () => {
      const tty = renderHuman(records, { schema: recordSchema, tty: true, colour: false });
      expect(tty).toMatch(BOX_DRAWING);
      expect(tty).toContain("Test Person 1");
      const pipe = renderHuman(records, { schema: recordSchema, tty: false, colour: false });
      expect(pipe).not.toMatch(BOX_DRAWING);
      expect(pipe).not.toMatch(ANSI);
      const lines = pipe.split("\n");
      expect(lines[0]).toBe("id | name | epoch");
      expect(lines[1]).toBe(`1 | Test Person 1 | ${String(SYNTHETIC_EPOCH)}`);
      expect(lines).toHaveLength(3);
    });

    it("renders an object as key-value lines in schema order, with a nested value as compact JSON", () => {
      const schema = z.object({
        b: z.string(),
        a: z.number(),
        nested: z.object({ x: z.number() }),
        list: z.array(z.number()),
      });
      const text = renderHuman(
        { a: 1, b: "two", nested: { x: 1 }, list: [1, 2] },
        { schema, tty: false, colour: false },
      );
      expect(text.split("\n")).toEqual(["b: two", "a: 1", 'nested: {"x":1}', "list: [1,2]"]);
    });

    it("renders an empty array as the emptyText sentence, `no results` by default", () => {
      expect(renderHuman([], { schema: recordSchema, tty: false, colour: false })).toBe("no results");
      expect(
        renderHuman([], { schema: recordSchema, render: { emptyText: "no active events" }, tty: true, colour: true }),
      ).toBe("no active events");
    });

    it("renders an epoch field as local ISO 8601 with the offset, and leaves the number in other fields", () => {
      process.env["TZ"] = "Europe/Amsterdam";
      const text = renderHuman(
        { when: SYNTHETIC_EPOCH, count: SYNTHETIC_EPOCH },
        {
          schema: z.object({ when: z.number(), count: z.number() }),
          render: { epochFields: ["when"] },
          tty: false,
          colour: false,
        },
      );
      expect(text).toBe(`when: 2026-10-12T19:09:00+02:00\ncount: ${String(SYNTHETIC_EPOCH)}`);
      process.env["TZ"] = "UTC";
      expect(
        renderHuman(
          { when: SYNTHETIC_EPOCH },
          { schema: z.object({ when: z.number() }), render: { epochFields: ["when"] } },
        ),
      ).toBe("when: 2026-10-12T17:09:00+00:00");
    });

    it("escapes every value of the human form in place and keeps newline, tab and right-to-left letters", () => {
      const text = renderHuman({ text: "a\x1b[2Jb\nc\td שלום" }, { schema: z.object({ text: z.string() }) });
      expect(text).toBe("text: a\\x1b[2Jb\nc\td שלום");
      expect(escapeForTerminal(String.fromCodePoint(0x202e))).toBe("\\u{202e}");
    });

    it("render.human replaces the generic form with the operation's own, escaped in place, and --json never uses it", () => {
      const { sessionToken } = fixtureSecrets();
      registerSecret(sessionToken);
      const human = (output: unknown): string => `own form of ${JSON.stringify(output)}\x1b[2J\u202e`;
      const output = { found: false, text: sessionToken };
      expect(renderHuman(output, { render: { human }, tty: true, colour: true })).toBe(
        `own form of ${JSON.stringify(output)}\\x1b[2J\\u{202e}`,
      );
      const written = new Capture();
      writeOutput(output, { json: false, stdout: written, render: { human } });
      expect(written.text).toBe(`own form of ${JSON.stringify({ ...output, text: "<REDACTED>" })}\\x1b[2J\\u{202e}\n`);
      const json = new Capture();
      writeOutput(output, { json: true, stdout: json, render: { human } });
      expect(json.text).toBe(`${JSON.stringify({ ...output, text: "<REDACTED>" }, null, 2)}\n`);
    });

    it("redactOutput passes every string value through redactString, at any depth, and leaves other values", () => {
      const { sessionToken } = fixtureSecrets();
      registerSecret(sessionToken);
      expect(
        redactOutput({ a: sessionToken, n: 1, list: [sessionToken, { deep: sessionToken }], ok: true, none: null }),
      ).toEqual({
        a: "<REDACTED>",
        n: 1,
        list: ["<REDACTED>", { deep: "<REDACTED>" }],
        ok: true,
        none: null,
      });
    });

    it("writeOutput writes the --json form as JSON.stringify(output, null, 2) and the human form, each redacted, each ending in one newline", () => {
      const { sessionToken } = fixtureSecrets();
      registerSecret(sessionToken);
      const json = new Capture();
      writeOutput(
        { token: sessionToken, n: 1 },
        { json: true, stdout: json, schema: z.object({ token: z.string(), n: z.number() }) },
      );
      expect(json.text).toBe(`${JSON.stringify({ token: "<REDACTED>", n: 1 }, null, 2)}\n`);
      const human = new Capture();
      writeOutput(
        { token: sessionToken, n: 1 },
        { json: false, stdout: human, schema: z.object({ token: z.string(), n: z.number() }) },
      );
      expect(human.text).toBe("token: <REDACTED>\nn: 1\n");
    });
  });

  describe("surface", () => {
    it("AC-06: a TTY gives a cli-table3 table with box-drawing characters and a pipe gives plain |-separated rows", async () => {
      await withTempHome(async (home) => {
        const tty = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [listOperation()], { isTTY: true }),
        );
        expect(tty.exitCode, tty.stderr).toBe(0);
        expect(tty.stdout).toMatch(BOX_DRAWING);
        expect(tty.stdout).toContain("Test Person 2");

        const pipe = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [listOperation()], { isTTY: false }),
        );
        expect(pipe.exitCode, pipe.stderr).toBe(0);
        expect(pipe.stdout).not.toMatch(BOX_DRAWING);
        expect(pipe.stdout.split("\n")[0]).toBe("id | name | epoch");

        // Without the seam, the terminal's own TTY flag decides.
        const viaTerminal = await runCli(["synthetic", "echo", "42", "--type", "1"], {
          ...io(home, [listOperation()]),
          terminal: fakeTerminal({ stdoutTTY: true }).terminal,
        });
        expect(viaTerminal.stdout).toMatch(BOX_DRAWING);
      });
    });

    it("AC-06: an object renders as key-value lines in schema order", async () => {
      await withTempHome(async (home) => {
        const result = await runCli(
          ["synthetic", "echo", "42", "--type", "5956,5957", "--message", "hello"],
          io(home, [syntheticOperation()]),
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toBe(
          [
            "thing_id: 42",
            "type_ids: [5956,5957]",
            "page: 1",
            "dry_run: false",
            "message: hello",
            "token: not-a-secret",
            "text: plain text",
            `epoch: ${String(SYNTHETIC_EPOCH)}`,
            "",
          ].join("\n"),
        );
      });
    });

    it("AC-06: with NO_COLOR=1 the pipe text equals the text without it and a TTY carries no colour code", async () => {
      await withTempHome(async (home) => {
        const plain = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [listOperation()], { env: { ...home.env, NO_COLOR: undefined } }),
        );
        const noColor = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [listOperation()], { env: { ...home.env, NO_COLOR: "1" } }),
        );
        expect(plain.stdout).not.toMatch(ANSI);
        expect(noColor.stdout).toBe(plain.stdout);

        const ttyNoColor = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [listOperation()], { env: { ...home.env, NO_COLOR: "1" }, isTTY: true }),
        );
        expect(ttyNoColor.stdout).toMatch(BOX_DRAWING);
        expect(ttyNoColor.stdout).not.toMatch(ANSI);
      });
    });

    it("AC-06: an empty array prints the emptyText sentence with exit 0, and --json prints []", async () => {
      await withTempHome(async (home) => {
        const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [listOperation([])]));
        expect(human.exitCode, human.stderr).toBe(0);
        expect(human.stdout).toBe("no synthetic results\n");
        expect(human.stderr).toBe("");
        const machine = await runCli(
          ["--json", "synthetic", "echo", "42", "--type", "1"],
          io(home, [listOperation([])]),
        );
        expect(machine.exitCode).toBe(0);
        expect(machine.stdout).toBe("[]\n");
      });
    });

    it("AC-07: with TZ=Europe/Amsterdam an epoch field renders as 2026-10-12T19:09:00+02:00 in the human form and stays the number in --json", async () => {
      await withTempHome(async (home) => {
        process.env["TZ"] = "Europe/Amsterdam";
        const operation = syntheticOperation({ render: { epochFields: ["epoch"] } });
        const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(human.exitCode, human.stderr).toBe(0);
        expect(human.stdout).toContain("epoch: 2026-10-12T19:09:00+02:00");
        const machine = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect((JSON.parse(machine.stdout) as { epoch: number }).epoch).toBe(SYNTHETIC_EPOCH);

        const table = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [listOperation()]));
        expect(table.stdout).toContain("2026-10-12T19:09:00+02:00");
        expect(table.stdout).toContain("2026-10-12T19:10:00+02:00");
      });
    });

    it("AC-08: a registered fixture secret in a record reaches neither the human form nor --json; each holds <REDACTED>", async () => {
      await withTempHome(async (home) => {
        const { sessionToken } = fixtureSecrets();
        registerSecret(sessionToken);
        const operation = syntheticOperation({
          run: (_ctx, input) => Promise.resolve(echoOutput(input, { token: sessionToken })),
        });
        const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(human.exitCode, human.stderr).toBe(0);
        expect(human.stdout).toContain("token: <REDACTED>");
        expect(human.stdout.split(sessionToken).length - 1).toBe(0);
        const machine = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(machine.stdout).toContain("<REDACTED>");
        expect(machine.stdout.split(sessionToken).length - 1).toBe(0);
        expect((JSON.parse(machine.stdout) as { token: string }).token).toBe("<REDACTED>");
      });
    });

    it.each(HOSTILE)(
      "AC-10: %s in a text field renders visibly in the human form, with no raw hostile code point, and --json keeps it byte for byte",
      async (_label, input, visible) => {
        await withTempHome(async (home) => {
          const text = `Test Person 1 ${input} Example Org 1`;
          const operation = syntheticOperation({ run: (_ctx, i) => Promise.resolve(echoOutput(i, { text })) });
          const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
          expect(human.exitCode, human.stderr).toBe(0);
          expect(human.stdout).toContain(`text: Test Person 1 ${visible} Example Org 1`);
          expect(rawHostile(human.stdout)).toEqual([]);
          const machine = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
          expect((JSON.parse(machine.stdout) as { text: string }).text).toBe(text);
        });
      },
    );

    it("AC-10: newline, tab and right-to-left letters pass through the human form unchanged", async () => {
      await withTempHome(async (home) => {
        const text = "line one\nline two\tcolumn שלום مرحبا";
        const operation = syntheticOperation({ run: (_ctx, i) => Promise.resolve(echoOutput(i, { text })) });
        const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(human.stdout).toContain(`text: ${text}\n`);
      });
    });
  });
});
