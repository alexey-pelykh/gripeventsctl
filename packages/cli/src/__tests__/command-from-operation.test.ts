// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-PARITY and CAP-OUTPUT, unit and surface: the CLI builder (issue #9 § The CLI builder, § Exit codes). The
 * command tree and its help (AC-01), the flag rule and the usage errors (AC-02), the `--json` forms (AC-04), the
 * exit-code table (AC-05), the extra and the missing field (AC-09) and the session check (AC-12), driven through the
 * real program with the synthetic operation registered, a temporary home, the mock agent, a fake clock and a fake
 * terminal. Nothing here reaches the network: the agent refuses every connection.
 */

import { GripError, type GripErrorKind, OPERATIONS, type Operation } from "@gripeventsctl/core";
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
import { describe, expect, it } from "vitest";

import {
  SYNTHETIC_EPOCH,
  type SyntheticInput,
  echoOutput,
  syntheticInput,
  syntheticOperation,
} from "../../../core/src/__tests__/fixtures/synthetic-operation.js";
import { buildProgram } from "../index.js";

const agent = mockGrip();

function requests(): number {
  return agent.getCallHistory()?.calls().length ?? 0;
}

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

/** The lines under the `Commands:` heading of a help text, trimmed, until the first blank line. */
function commandLines(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  if (start === -1) return [];
  const verbs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    verbs.push(line.trim());
  }
  return verbs;
}

/** `record` without `key`: the answer that lacks one documented field. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function mustFind<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

describe("[CAP-PARITY] [CAP-OUTPUT] the CLI builder: one leaf per operation by the fixed flag rule", () => {
  describe("unit", () => {
    it("AC-01: the tree holds `synthetic echo <thing_id>` with --type <ids> (required), --page <n> (default 1), --dry-run and --message <text>, at depth two", () => {
      const program = buildProgram({ operations: [syntheticOperation()] });
      expect(program.description()).toContain("Unofficial");
      const synthetic = mustFind(
        program.commands.find((command) => command.name() === "synthetic"),
        "the synthetic group",
      );
      expect(synthetic.description()).toBe("synthetic commands");
      const echo = mustFind(
        synthetic.commands.find((command) => command.name() === "echo"),
        "the echo leaf",
      );
      expect(echo.commands).toEqual([]);
      expect(echo.description()).toBe("Echo the inputs back");
      expect(echo.registeredArguments.map((argument) => [argument.name(), argument.required])).toEqual([
        ["thing_id", true],
      ]);
      const flags = echo.options.map((option) => option.flags);
      expect(flags).toEqual(expect.arrayContaining(["--type <ids>", "--page <n>", "--dry-run", "--message <text>"]));
      expect(flags.some((flag) => flag.includes("--type-ids"))).toBe(false);
      expect(flags.some((flag) => flag.includes("--json"))).toBe(false);
      const type = mustFind(
        echo.options.find((option) => option.long === "--type"),
        "--type",
      );
      expect(type.mandatory).toBe(true);
      const page = mustFind(
        echo.options.find((option) => option.long === "--page"),
        "--page",
      );
      expect(page.mandatory).toBe(false);
      expect(page.defaultValue).toBe(1);
      const message = mustFind(
        echo.options.find((option) => option.long === "--message"),
        "--message",
      );
      expect(message.mandatory).toBe(false);
    });

    it("AC-01: an operation group is created once, so two verbs of one group sit under one command", () => {
      const program = buildProgram({
        operations: [syntheticOperation(), syntheticOperation({ verb: "poke", kind: "write" })],
      });
      const groups = program.commands.filter((command) => command.name() === "synthetic");
      expect(groups).toHaveLength(1);
      expect(mustFind(groups[0], "the group").commands.map((command) => command.name())).toEqual(["echo", "poke"]);
    });

    it("AC-19: buildProgram() with no argument builds the program over the registry: auth, then one group per distinct registry group in registry order", () => {
      const program = buildProgram();
      const groups = [...new Set(OPERATIONS.map((op) => op.group))];
      expect(program.commands.map((command) => command.name())).toEqual(["auth", ...groups]);
      for (const op of OPERATIONS) {
        const group = program.commands.find((command) => command.name() === op.group);
        expect(
          group?.commands.map((command) => command.name()),
          op.group,
        ).toContain(op.verb);
      }
    });
  });

  describe("surface", () => {
    it("AC-01: --help on the program, on `synthetic` and on `echo` lists one line per verb, and the program keeps Unofficial", async () => {
      await withTempHome(async (home) => {
        const operations = [syntheticOperation()];
        const program = await runCli(["--help"], io(home, operations));
        expect(program.exitCode).toBe(0);
        expect(program.stdout).toContain("Unofficial");
        expect(program.stdout).toContain("--json");
        const groups = commandLines(program.stdout).map((line) => line.split(/\s+/)[0]);
        expect(groups).toEqual(["auth", "synthetic", "help"]);

        const group = await runCli(["synthetic", "--help"], io(home, operations));
        expect(group.exitCode).toBe(0);
        expect(commandLines(group.stdout).map((line) => line.split(/\s+/)[0])).toEqual(["echo", "help"]);
        expect(group.stdout).toContain("Echo the inputs back");

        const leaf = await runCli(["synthetic", "echo", "--help"], io(home, operations));
        expect(leaf.exitCode).toBe(0);
        expect(commandLines(leaf.stdout)).toEqual([]);
        expect(leaf.stdout).toContain("<thing_id>");
        expect(leaf.stdout).toContain("--type <ids>");
        expect(leaf.stdout).toContain("--page <n>");
        expect(leaf.stdout).toContain("(default: 1)");
        expect(leaf.stdout).toContain("--dry-run");
        expect(leaf.stdout).toContain("--message <text>");
        expect(leaf.stdout).not.toContain("--type-ids");
        expect(leaf.stdout).not.toContain("--json");
      });
    });

    it("AC-02: `42 --type 5956,5957 --page 2 --dry-run` reaches run as the typed object, and `me` stays the literal", async () => {
      await withTempHome(async (home) => {
        const seen: SyntheticInput[] = [];
        const operation = syntheticOperation({
          run: (_ctx, input) => {
            seen.push(input);
            return Promise.resolve(echoOutput(input));
          },
        });
        const first = await runCli(
          ["synthetic", "echo", "42", "--type", "5956,5957", "--page", "2", "--dry-run"],
          io(home, [operation]),
        );
        expect(first.exitCode, first.stderr).toBe(0);
        const second = await runCli(["synthetic", "echo", "me", "--type", "1"], io(home, [operation]));
        expect(second.exitCode, second.stderr).toBe(0);
        expect(seen).toEqual([
          { thing_id: 42, type_ids: [5956, 5957], page: 2, dry_run: true },
          { thing_id: "me", type_ids: [1], page: 1, dry_run: false },
        ]);
        expect(requests()).toBe(0);
      });
    });

    it.each([
      ["a positional that is neither a number nor a literal", ["abc", "--type", "1"], "thing_id"],
      ["a page below the minimum", ["42", "--type", "1", "--page", "0"], "page"],
      ["a type list that is not numbers", ["42", "--type", "x"], "type_ids"],
    ])(
      "AC-02: %s exits 2 with a usage message naming the key and the help on stderr, and sends no request",
      async (_label, args, key) => {
        await withTempHome(async (home) => {
          let runs = 0;
          const operation = syntheticOperation({
            run: (_ctx, input) => {
              runs += 1;
              return Promise.resolve(echoOutput(input));
            },
          });
          const before = requests();
          const result = await runCli(["synthetic", "echo", ...args], io(home, [operation]));
          expect(result.exitCode).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(key);
          expect(result.stderr).toContain("Usage:");
          expect(result.stderr).toContain("gripeventsctl synthetic echo");
          expect(runs).toBe(0);
          expect(requests() - before).toBe(0);
        });
      },
    );

    it("AC-02: a missing --type is a usage error naming the option, exit 2, with the help on stderr", async () => {
      await withTempHome(async (home) => {
        const result = await runCli(["synthetic", "echo", "42"], io(home, [syntheticOperation()]));
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("--type");
        expect(result.stderr).toContain("Usage:");
        expect(result.stdout).toBe("");
      });
    });

    /** `dry_run` schemas without a `false` default: what an absent `--dry-run` must reach `run` as, then the schema. */
    const BOOLEAN_FLAGS: [string, boolean, z.ZodType][] = [
      ["a plain z.boolean()", false, z.boolean()],
      ["an optional z.boolean()", false, z.boolean().optional()],
      ["a z.boolean() with the zod default true", true, z.boolean().default(true)],
    ];

    it.each(BOOLEAN_FLAGS)(
      "AC-02: over %s as dry_run, an absent --dry-run reaches run as %s with exit 0, and a present one as true",
      async (_label, absentValue, dryRun) => {
        await withTempHome(async (home) => {
          const seen: unknown[] = [];
          const operation: Operation = {
            ...syntheticOperation({
              run: (_ctx, input) => {
                seen.push(input.dry_run);
                return Promise.resolve(echoOutput(input));
              },
            }),
            input: syntheticInput.extend({ dry_run: dryRun }),
          };
          const absent = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
          expect(absent.exitCode, absent.stderr).toBe(0);
          const present = await runCli(["synthetic", "echo", "42", "--type", "1", "--dry-run"], io(home, [operation]));
          expect(present.exitCode, present.stderr).toBe(0);
          expect(seen).toEqual([absentValue, true]);
          expect(requests()).toBe(0);
        });
      },
    );

    it("AC-04: --json prints exactly the output object, with an empty stderr; an array stays bare and an epoch stays a number", async () => {
      await withTempHome(async (home) => {
        const object = await runCli(
          ["--json", "synthetic", "echo", "42", "--type", "1", "--message", "hello"],
          io(home, [syntheticOperation()]),
        );
        expect(object.exitCode, object.stderr).toBe(0);
        expect(object.stderr).toBe("");
        const expected = echoOutput({ thing_id: 42, type_ids: [1], page: 1, dry_run: false, message: "hello" });
        expect(object.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);

        const records = [
          { id: 1, name: "Test Person 1", epoch: SYNTHETIC_EPOCH },
          { id: 2, name: "Test Person 2", epoch: SYNTHETIC_EPOCH + 60 },
        ];
        const list = syntheticOperation({
          output: z.array(z.object({ id: z.number(), name: z.string(), epoch: z.number() })),
          render: { epochFields: ["epoch"] },
          run: () => Promise.resolve(records),
        });
        const array = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [list]));
        expect(array.exitCode, array.stderr).toBe(0);
        expect(array.stderr).toBe("");
        expect(array.stdout).toBe(`${JSON.stringify(records, null, 2)}\n`);
        expect(JSON.parse(array.stdout)).toEqual(records);
      });
    });

    it("AC-04: a thrown GripError with --json gives one { error: { kind, message, hint } } object on stderr, nothing on stdout, and the table's code", async () => {
      await withTempHome(async (home) => {
        const operation = syntheticOperation({
          run: () => Promise.reject(new GripError("throttled", "the platform is throttling", "wait and retry later")),
        });
        const result = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(result.exitCode).toBe(5);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(result.stderr)).toEqual({
          error: { kind: "throttled", message: "the platform is throttling", hint: "wait and retry later" },
        });
      });
    });

    const TABLE: [GripErrorKind, number][] = [
      ["usage", 2],
      ["no-session", 3],
      ["auth-failed", 3],
      ["write-refused", 4],
      ["throttled", 5],
      ["swipe-cap", 5],
      ["gated-type", 6],
      ["load-balancer-rejected", 6],
      ["network", 7],
      ["config", 8],
      ["unknown-slug", 1],
      ["mode-phase", 1],
      ["conflict", 1],
      ["api", 1],
    ];

    it.each(TABLE)(
      "AC-05: a %s error thrown by the operation exits %i, with one redacted stderr line holding the hint, and the harness read the code",
      async (kind, code) => {
        await withTempHome(async (home) => {
          const { chatToken } = fixtureSecrets();
          const operation = syntheticOperation({
            run: () =>
              Promise.reject(new GripError(kind, `the ${kind} failure with ${chatToken}`, `next step for ${kind}`)),
          });
          const result = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
          expect(result.exitCode).toBe(code);
          expect(result.stdout).toBe("");
          expect(result.stderr.endsWith("\n")).toBe(true);
          expect(result.stderr.slice(0, -1)).not.toContain("\n");
          expect(result.stderr).toContain(`the ${kind} failure`);
          expect(result.stderr).toContain(`; hint: next step for ${kind}`);
          expect(result.stderr).not.toContain(chatToken);
          expect(result.stderr).toContain("<REDACTED>");
        });
      },
    );

    it("AC-05: an exception that is not a GripError prints a redacted message and exits 1", async () => {
      await withTempHome(async (home) => {
        const { chatToken } = fixtureSecrets();
        const operation = syntheticOperation({ run: () => Promise.reject(new TypeError(`broke with ${chatToken}`)) });
        const result = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("broke with <REDACTED>");
        expect(result.stderr).not.toContain(chatToken);
      });
    });

    it("AC-09: an extra token-shaped field the output schema does not name reaches neither output form, and the run succeeds", async () => {
      await withTempHome(async (home) => {
        const marker = "not-a-secret-marker-ac09-cli";
        const operation = syntheticOperation({
          run: (_ctx, input) => Promise.resolve({ ...echoOutput(input), secret_token: marker }),
        });
        const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(human.exitCode, human.stderr).toBe(0);
        expect(human.stdout).not.toContain("secret_token");
        expect(human.stdout).not.toContain(marker);
        const machine = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(machine.exitCode, machine.stderr).toBe(0);
        expect(Object.keys(JSON.parse(machine.stdout) as Record<string, unknown>)).not.toContain("secret_token");
        expect(machine.stdout).not.toContain(marker);
      });
    });

    it("AC-09: a documented field missing from the answer is the api kind naming the field, exit 1", async () => {
      await withTempHome(async (home) => {
        const operation = syntheticOperation({
          run: (_ctx, input) => Promise.resolve(without(echoOutput(input), "epoch")),
        });
        const human = await runCli(["synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(human.exitCode).toBe(1);
        expect(human.stdout).toBe("");
        expect(human.stderr).toContain("epoch");
        const machine = await runCli(["--json", "synthetic", "echo", "42", "--type", "1"], io(home, [operation]));
        expect(machine.exitCode).toBe(1);
        const parsed = JSON.parse(machine.stderr) as { error: { kind: string; message: string } };
        expect(parsed.error.kind).toBe("api");
        expect(parsed.error.message).toContain("epoch");
      });
    });

    it("AC-12: with no session, a needsSession false run exits 0 and a needsSession true run exits 3 naming the sign-in command, with no request", async () => {
      await withTempHome(async (home) => {
        const before = requests();
        const open = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [syntheticOperation({ needsSession: false })]),
        );
        expect(open.exitCode, open.stderr).toBe(0);
        const closed = await runCli(
          ["synthetic", "echo", "42", "--type", "1"],
          io(home, [syntheticOperation({ needsSession: true })]),
        );
        expect(closed.exitCode).toBe(3);
        expect(closed.stdout).toBe("");
        expect(closed.stderr).toContain("no session");
        expect(closed.stderr).toContain("hint: gripeventsctl auth signin <slug>");
        expect(requests() - before).toBe(0);
      });
    });
  });
});
