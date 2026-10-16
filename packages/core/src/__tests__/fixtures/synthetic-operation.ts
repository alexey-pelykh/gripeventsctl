// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The synthetic operation of the registry item (issue #9 § The `Operation` type), for the CLI, MCP and umbrella
 * tests: group `synthetic`, verb `echo`, one positional `thing_id` (`number | "user_id" | "me"`), one `--type` array
 * (`type_ids`), one `--page` integer with default 1, one boolean `--dry-run` (`dry_run`), an optional `message`, and
 * an output object with a `token`-named field a test fills with a registered fixture secret, a `text` field for the
 * escaping tests and an `epoch` field. Test code only: every `tsconfig.build.json` keeps `__tests__` out of `dist`.
 *
 * The file imports types only, erased at run time: it loads no second copy of the core module, so the builders
 * compare the error classes and the secret registry of the one built `@gripeventsctl/core` the tests and the
 * builders share. `defineOperation` is an identity function with type inference; the annotation below does the same.
 */

import { z } from "zod";

import type { Operation, OperationContext, OperationKind } from "../../index.js";

export const syntheticInput = z.object({
  thing_id: z.union([z.number().int().positive(), z.literal("user_id"), z.literal("me")]),
  type_ids: z.array(z.number().int().positive()).min(1),
  page: z.number().int().min(1).default(1),
  dry_run: z.boolean().default(false),
  message: z.string().optional(),
});

export type SyntheticInput = z.infer<typeof syntheticInput>;

export const syntheticOutput = z.object({
  thing_id: z.union([z.number(), z.string()]),
  type_ids: z.array(z.number()),
  page: z.number(),
  dry_run: z.boolean(),
  message: z.string().optional(),
  token: z.string(),
  text: z.string(),
  epoch: z.number(),
});

export type SyntheticOutput = z.infer<typeof syntheticOutput>;

/** The epoch of the issue's example, `2026-10-12T19:09:00+02:00`. */
export const SYNTHETIC_EPOCH = 1791824940;

/** The default answer of `run`: the input echoed back, with placeholder values in the three extra fields. */
export function echoOutput(input: SyntheticInput, overrides: Partial<SyntheticOutput> = {}): SyntheticOutput {
  return {
    thing_id: input.thing_id,
    type_ids: input.type_ids,
    page: input.page,
    dry_run: input.dry_run,
    ...(input.message === undefined ? {} : { message: input.message }),
    token: "not-a-secret",
    text: "plain text",
    epoch: SYNTHETIC_EPOCH,
    ...overrides,
  };
}

export interface SyntheticOptions {
  /** The verb; `echo` by default. */
  verb?: string;
  /** `read` by default. */
  kind?: OperationKind;
  /** `false` by default. */
  needsSession?: boolean;
  description?: string;
  /** The output schema; the object `syntheticOutput` by default. An array schema exercises the table and `{ items }`. */
  output?: z.ZodType;
  render?: Operation["render"];
  /** What the operation answers; `echoOutput(input)` by default. */
  run?: (ctx: OperationContext, input: SyntheticInput) => Promise<unknown>;
}

/** The synthetic operation, with the parts a test varies. */
export function syntheticOperation(options: SyntheticOptions = {}): Operation {
  const run = options.run ?? ((_ctx: OperationContext, input: SyntheticInput) => Promise.resolve(echoOutput(input)));
  const operation: Operation<typeof syntheticInput> = {
    group: "synthetic",
    verb: options.verb ?? "echo",
    kind: options.kind ?? "read",
    description: options.description ?? "Echo the inputs back",
    needsSession: options.needsSession ?? false,
    input: syntheticInput,
    output: options.output ?? syntheticOutput,
    requests: [],
    cli: { positional: ["thing_id"], flags: { type_ids: "type" } },
    ...(options.render === undefined ? {} : { render: options.render }),
    run,
  };
  return operation;
}
