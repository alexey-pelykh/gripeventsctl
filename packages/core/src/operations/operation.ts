// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `Operation` type (issue #9 § The `Operation` type): the one description every CLI leaf command and every MCP
 * tool is derived from, so the two surfaces cannot drift. The ordered list the two builders read is `OPERATIONS` in
 * `registry.ts`; the type and `defineOperation()` sit here so an operation module imports them without importing the
 * list that imports the module.
 *
 * Rules: `group` and `verb` are lowercase ASCII words; `requests` lists every request shape the operation can send,
 * each with its `docs/api/` page file name and the section heading, as data (a later gate checks the anchors exist
 * and the live suite prints the templates); `cli.positional` names the input keys that become positional arguments,
 * in order; `cli.flags` maps an input key to an explicit flag name where the default rule (the kebab-case of the key)
 * does not apply, for example `type_ids` to `type`; `render.epochFields` names the output keys that hold epoch
 * seconds; `render.emptyText` is the sentence printed for an empty array result, for example `no active events`;
 * `render.tableField` names, for an object output, the key whose array of flat records renders as the table, the
 * other keys following as key-value lines (issue #11 § Additions to the `Operation` type); `render.note` is one
 * sentence printed on its own line after the human rendering and appended to the MCP text block, never in `--json`
 * or `structuredContent` (issue #13); `render.human` is the
 * operation's own human form of its validated output, for an operation whose item fixes a human form the generic
 * table and key-value renderings cannot give (the output module escapes and redacts it like every other human form,
 * and `--json` and `structuredContent` never use it); `exitCode(output)` is the CLI exit code of a completed run
 * whose output names an outcome that is not success, `attendees dump` stopped by a transport error for one (absent
 * means 0; the MCP builder ignores it, a completed run being a normal result); `mcp.descriptionSuffix` is what the
 * MCP tool description carries after the posture and boundary sentences, where an operation's item fixes a notice
 * for the assistant that the CLI help line does not carry; `mcp.descriptionPosture` replaces the posture sentence of
 * the kind, for an operation that reads local state only (issue #16). An operation never inspects an HTTP status: the transport
 * classifies every answer and raises the typed error; an operation catches a typed error only to turn it into an
 * outcome its output schema names.
 */

import type { z } from "zod";

import type { Config } from "../config/schema.js";
import type { WriteGate } from "../gate/gate.js";
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
  /**
   * Aborts when the caller cancels the run: the first SIGINT on the CLI, the host's `notifications/cancelled` on MCP.
   * An operation that sends more than one request passes it to the client and sends no request after it aborted.
   */
  signal?: AbortSignal;
  /**
   * Present on MCP only, when the call carried a progress token: sends one `notifications/progress` with `done` as the
   * progress so far (pages, for a dump) and `message` as its text. Absent on the CLI, which writes progress to stderr.
   */
  progress?: (done: number, message: string) => Promise<void>;
  /**
   * The write gate (issue #16), built once per call by each surface's `lib/context.ts`: the one path a write runs
   * through. A read operation ignores it; a write passes its spec to `gate.execute()` and never calls the repeat
   * guard, the journal or the lock itself.
   */
  gate: WriteGate;
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
  mcp?: {
    /** Sentences the MCP tool description carries after the posture and boundary sentences; never in the CLI help. */
    descriptionSuffix?: string;
    /**
     * The one posture sentence of the MCP tool description, in place of the one the operation's kind fixes (issue
     * #16: the two `writes` reads read the tool's own local state and make no platform call).
     */
    descriptionPosture?: string;
  };
  render?: {
    epochFields?: readonly string[];
    emptyText?: string;
    /**
     * For an object output, the key whose array of flat records renders as the table; the remaining keys render as
     * key-value lines after the table, and `emptyText` replaces an empty table.
     */
    tableField?: string;
    /**
     * One sentence printed on its own line after the human rendering (the table, the key-value block or `emptyText`)
     * and appended to the MCP text block; never part of `--json` or `structuredContent` (issue #13 § Addition to
     * the `Operation` type: `chat list` notes that the thread list is also the connections list).
     */
    note?: string;
    /**
     * The human form of the validated output, where the operation's item fixes one the generic renderings cannot
     * give. A method, so an operation types it over its own output; the builders call it with the validated output.
     */
    human?(output: z.infer<O>): string;
  };
  /** The CLI exit code of a completed run, from its validated output; absent means 0. */
  exitCode?(output: z.infer<O>): number;
  run(ctx: OperationContext, input: z.infer<I>): Promise<z.infer<O>>;
}

/** Identity with type inference: an operation item writes `defineOperation({ ... })` and keeps its input and output types. */
export function defineOperation<I extends z.ZodObject, O extends z.ZodType>(op: Operation<I, O>): Operation<I, O> {
  return op;
}
