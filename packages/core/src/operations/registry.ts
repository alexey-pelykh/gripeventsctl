// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The operation registry (issue #9 § The `Operation` type): the one description every CLI leaf command and every MCP
 * tool is derived from, so the two surfaces cannot drift. `OPERATIONS` is the ordered list the two builders read
 * (events, attendees, match, chat, schedule, interest, writes, as the operation items land); it ships empty here.
 *
 * Rules: `group` and `verb` are lowercase ASCII words; `requests` lists every request shape the operation can send,
 * each with its `docs/api/` page file name and the section heading, as data (a later gate checks the anchors exist
 * and the live suite prints the templates); `cli.positional` names the input keys that become positional arguments,
 * in order; `cli.flags` maps an input key to an explicit flag name where the default rule (the kebab-case of the key)
 * does not apply, for example `type_ids` to `type`; `render.epochFields` names the output keys that hold epoch
 * seconds; `render.emptyText` is the sentence printed for an empty array result, for example `no active events`. An
 * operation never inspects an HTTP status: the transport classifies every answer and raises the typed error; an
 * operation catches a typed error only to turn it into an outcome its output schema names.
 */

import type { z } from "zod";

import type { Config } from "../config/schema.js";
import type { Clock } from "../lib/clock.js";
import type { GripClient } from "../transport/client.js";

export type OperationKind = "read" | "write";

export interface OperationContext {
  /** One per process; the request queue is process-wide. */
  client: GripClient;
  /** The `loadConfig()` result. */
  config: { config: Config; path: string; exists: boolean };
  clock: Clock;
  /** Diagnostics only; the caller redacts what it writes. */
  stderr: NodeJS.WritableStream;
  source: "cli" | "mcp";
  // The write gate item adds `gate` here.
}

/** One documented request shape an operation sends, with its `docs/api/` page and section anchor. */
export interface RequestShape {
  method: "GET" | "POST";
  pathTemplate: string;
  /** The `docs/api/` page file name, for example `attendees.md`. */
  page: string;
  /** The section heading on that page, for example `Directory search`. */
  section: string;
}

export interface Operation<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  /** `events`, `attendees`, `match`, `chat`, `schedule`, `interest`, `writes`. */
  group: string;
  /** `check`, `list`, ... */
  verb: string;
  kind: OperationKind;
  /** One sentence: the CLI help line and the MCP description's first sentence. */
  description: string;
  needsSession: boolean;
  /** A zod object; keys in snake_case. */
  input: I;
  /** A zod schema: an object, or an array of flat records. */
  output: O;
  /** The documented request shapes this operation sends, with page and section anchor. */
  requests: readonly RequestShape[];
  cli?: { positional?: readonly string[]; flags?: Readonly<Record<string, string>> };
  render?: { epochFields?: readonly string[]; emptyText?: string };
  run(ctx: OperationContext, input: z.infer<I>): Promise<z.infer<O>>;
}

/** The registry, ordered: events, attendees, match, chat, schedule, interest, writes. Empty until the operation items land. */
export const OPERATIONS: readonly Operation[] = Object.freeze([]);

/** Identity with type inference: an operation item writes `defineOperation({ ... })` and keeps its input and output types. */
export function defineOperation<I extends z.ZodObject, O extends z.ZodType>(op: Operation<I, O>): Operation<I, O> {
  return op;
}
