// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The CLI builder (issue #9 § The CLI builder): one Commander leaf per operation, by one fixed rule over the keys of
 * the operation's zod input object.
 *
 * | Input key | CLI form |
 * |---|---|
 * | a key named in `cli.positional` | a positional argument `<key>`; required unless the zod field is optional or has a default |
 * | any other key | `--<kebab-case of the key> <value>`, or the name in `cli.flags`; mandatory when the zod field is required with no default |
 * | `z.boolean()` | a flag without a value (`--dry-run`); absent means false or the zod default |
 * | `z.array(...)` | one value, comma-separated (`--type 5956,5957`), split and each element parsed by the element schema |
 * | `z.number()` | parsed with `Number()`; a non-integer or out-of-range value is a `usage` error |
 * | a union of `z.number()` and string literals | the raw argument is a literal if it equals one, else parsed as a number; anything else is `usage` |
 * | a zod default | the Commander default, shown in `--help` |
 * | a zod `.describe()` text | the help text of the argument or option, in place of the bare key (issue #11: `attendees get` names `user_id` and `me`) |
 *
 * The placeholder of a value flag follows the schema type: a number array `<ids>`, a number `<n>`, a string `<text>`,
 * any other array `<values>`, anything else `<value>`. After Commander parses, the collected object is validated by
 * `op.input.safeParse`; a failure is the `usage` kind (exit 2) whose message names the first issue's path, written
 * by Commander with the command's help on stderr, the way Commander's own usage errors are (`runProgram` in
 * `index.ts` maps the `CommanderError` to exit 2).
 *
 * The leaf action builds the `OperationContext` (`source: "cli"`): `loadConfig()`, the program's one `GripClient`,
 * the clock, the stderr and the signal of the context, armed on the process's first SIGINT for the duration of the
 * run (`CliContext.armInterrupt`); `progress` stays undefined, the CLI writing progress to stderr. When
 * `op.needsSession` and the config has no session, it raises `no-session` (exit 3, hint `gripeventsctl auth signin
 * <slug>`) before any request. It calls `op.run`, validates the result with the output schema (a failure is the `api`
 * kind naming the field), renders it through `writeOutput` and records `op.exitCode?.(output) ?? 0` as the program's
 * outcome, which `runProgram` returns (issue #11 § Additions to the `Operation` type). A thrown `GripError` is printed
 * by `lib/exit-codes.ts` in `runProgram` and mapped to its code; an unexpected exception prints a redacted message and
 * exits 1; only the umbrella's `cli.ts` sets `process.exitCode`.
 */

import {
  type LoadResult,
  type Operation,
  type OperationContext,
  NoSessionError,
  loadConfig,
} from "@gripeventsctl/core";
import { Command, Option } from "commander";
import type { z } from "zod";

import { type CliContext, printWorkTreeWarnings } from "./context.js";
import { USAGE_EXIT_CODE } from "./exit-codes.js";
import { validateOutput, writeOutput } from "./output.js";

/** The Commander error code of a zod usage failure, beside Commander's own `commander.*` codes. */
export const USAGE_ERROR_CODE = "gripeventsctl.usage";

export type FieldKind = "boolean" | "array" | "number" | "string" | "union" | "other";

/** What the fixed rule reads off one input field: its kind under the optional and default wrappers, and the wrappers. */
export interface Field {
  kind: FieldKind;
  /** True where the zod field is required with no default. */
  required: boolean;
  hasDefault: boolean;
  /** The zod default, where `hasDefault`. */
  defaultValue: unknown;
  /** The element field of an array. */
  element?: Field;
  /** The string literals of a union of a number and string literals. */
  literals: readonly string[];
}

/** The parts of a zod 4 definition the rule reads. */
interface SchemaDefinition {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  options?: readonly z.ZodType[];
  values?: readonly unknown[];
  defaultValue?: unknown;
}

function definitionOf(schema: z.ZodType): SchemaDefinition {
  return schema._zod.def;
}

/** The field a zod schema describes, with the optional and default wrappers unwrapped. */
export function describeField(schema: z.ZodType): Field {
  let current = schema;
  let required = true;
  let hasDefault = false;
  let defaultValue: unknown;
  for (;;) {
    const definition = definitionOf(current);
    if (definition.type === "optional" || definition.type === "nullable") {
      required = false;
    } else if (definition.type === "default") {
      required = false;
      hasDefault = true;
      defaultValue = definition.defaultValue;
    } else {
      break;
    }
    if (definition.innerType === undefined) break;
    current = definition.innerType;
  }
  const definition = definitionOf(current);
  const literals: string[] = [];
  let kind: FieldKind = "other";
  let element: Field | undefined;
  switch (definition.type) {
    case "boolean":
      kind = "boolean";
      break;
    case "number":
      kind = "number";
      break;
    case "string":
      kind = "string";
      break;
    case "array":
      kind = "array";
      element = definition.element === undefined ? undefined : describeField(definition.element);
      break;
    case "union":
      kind = "union";
      for (const option of definition.options ?? []) {
        const optionDefinition = definitionOf(option);
        if (optionDefinition.type !== "literal") continue;
        for (const value of optionDefinition.values ?? []) {
          if (typeof value === "string") literals.push(value);
        }
      }
      break;
    default:
      break;
  }
  return { kind, required, hasDefault, defaultValue, literals, ...(element === undefined ? {} : { element }) };
}

/** The placeholder of a value flag: `<ids>` for a number array, `<n>` for a number, `<text>` for a string. */
export function placeholderOf(field: Field): string {
  switch (field.kind) {
    case "number":
      return "n";
    case "string":
      return "text";
    case "array":
      return field.element?.kind === "number" ? "ids" : "values";
    default:
      return "value";
  }
}

/** `type_ids` as `type-ids`: the default flag name of an input key. */
export function kebabCase(key: string): string {
  return key.replace(/_/g, "-");
}

/** `type-ids` as `typeIds`: the attribute name Commander stores an option under, by Commander's own rule. */
function camelCase(flag: string): string {
  return flag.split("-").reduce((name, word) => name + word.charAt(0).toUpperCase() + word.slice(1));
}

/** One raw argument parsed by the field's rule; what the rule cannot parse stays for zod to refuse. */
export function convertArgument(raw: string, field: Field): unknown {
  switch (field.kind) {
    case "number":
      return Number(raw);
    case "union":
      return field.literals.includes(raw) ? raw : Number(raw);
    case "array":
      return raw.split(",").map((item) => (field.element === undefined ? item : convertArgument(item, field.element)));
    default:
      return raw;
  }
}

/** True when `NO_COLOR` is present and not empty in `env`, the convention's reading. */
export function noColor(env: NodeJS.ProcessEnv): boolean {
  const value = env["NO_COLOR"];
  return value !== undefined && value !== "";
}

function noSessionMessage(loaded: LoadResult): string {
  return loaded.exists ? `no session in ${loaded.path}` : `no session: no config file at ${loaded.path}`;
}

/** The help text of an argument or an option: the zod `.describe()` text where the field carries one, else the key. */
function helpTextOf(schema: z.ZodType, key: string): string {
  return schema.description ?? key;
}

/**
 * The leaf's action once the arguments are typed: the context, the session check, the run under the armed signal, the
 * projection, the output and the operation's exit code.
 */
async function runOperation(
  op: Operation,
  context: CliContext,
  input: z.output<Operation["input"]>,
  json: boolean,
): Promise<void> {
  const loaded = await loadConfig({ env: context.env, platform: context.platform });
  printWorkTreeWarnings(context, loaded);
  if (op.needsSession && loaded.config.session === undefined) throw new NoSessionError(noSessionMessage(loaded));
  const ctx: OperationContext = {
    client: context.client(),
    config: loaded,
    clock: context.clock,
    stderr: context.stderr,
    source: "cli",
    signal: context.signal,
  };
  const disarm = context.armInterrupt();
  let result: unknown;
  try {
    result = await op.run(ctx, input);
  } finally {
    disarm();
  }
  const output = validateOutput(op, result);
  context.outcome.exitCode = op.exitCode?.(output) ?? 0;
  writeOutput(output, {
    schema: op.output,
    render: op.render,
    json,
    tty: context.isTTY,
    colour: context.isTTY && !noColor(context.env),
    stdout: {
      write: (text) => {
        context.terminal.write(context.stdout, text);
      },
    },
  });
}

/**
 * The leaf command `<verb>` of `op`, to be added under its group command: its positional arguments and options by
 * the fixed rule, and the action above. The caller copies the program's inherited settings onto it
 * (`copyInheritedSettings`) before adding it, so Commander's output and exit handling reach the leaf.
 */
export function commandFromOperation(op: Operation, context: CliContext): Command {
  // Typed explicitly, so a `leaf.error(...)` call, which returns `never`, narrows the control flow after it.
  const leaf: Command = new Command(op.verb).description(op.description);
  const positional = op.cli?.positional ?? [];
  const flags = op.cli?.flags ?? {};
  const shape = op.input._zod.def.shape as Record<string, z.ZodType>;
  const fields = new Map<string, Field>();
  /** Input key to the attribute name Commander stores the option under. */
  const attributes = new Map<string, string>();

  for (const key of positional) {
    const schema = shape[key];
    if (schema === undefined) {
      throw new TypeError(
        `${op.group} ${op.verb}: cli.positional names "${key}", which the input schema does not hold`,
      );
    }
    const field = describeField(schema);
    fields.set(key, field);
    leaf.argument(field.required ? `<${key}>` : `[${key}]`, helpTextOf(schema, key));
  }
  for (const [key, schema] of Object.entries(shape)) {
    if (positional.includes(key)) continue;
    const field = describeField(schema);
    fields.set(key, field);
    const flag = flags[key] ?? kebabCase(key);
    attributes.set(key, camelCase(flag));
    if (field.kind === "boolean") {
      leaf.option(`--${flag}`, helpTextOf(schema, key));
      continue;
    }
    const option = new Option(`--${flag} <${placeholderOf(field)}>`, helpTextOf(schema, key));
    if (field.required) option.makeOptionMandatory();
    else if (field.hasDefault) option.default(field.defaultValue);
    leaf.addOption(option);
  }

  leaf.action(async (...args: unknown[]) => {
    const collected: Record<string, unknown> = {};
    positional.forEach((key, index) => {
      const raw = args[index];
      const field = fields.get(key);
      if (typeof raw === "string" && field !== undefined) collected[key] = convertArgument(raw, field);
    });
    for (const [key, attribute] of attributes) {
      const field = fields.get(key);
      if (field === undefined) continue;
      if (leaf.getOptionValueSource(attribute) !== "cli") {
        // An absent boolean flag means false; where the zod field carries a default, zod applies it instead.
        if (field.kind === "boolean" && !field.hasDefault) collected[key] = false;
        continue;
      }
      const raw: unknown = leaf.getOptionValue(attribute);
      collected[key] = field.kind === "boolean" ? raw === true : convertArgument(String(raw), field);
    }
    const parsed = op.input.safeParse(collected);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue === undefined ? "" : issue.path.map(String).join(".");
      const message = issue === undefined ? "invalid arguments" : `${path === "" ? "input" : path}: ${issue.message}`;
      leaf.error(`error: ${message}`, { exitCode: USAGE_EXIT_CODE, code: USAGE_ERROR_CODE });
    }
    const json = leaf.optsWithGlobals<{ json?: boolean }>().json === true;
    await runOperation(op, context, parsed.data, json);
  });
  return leaf;
}
