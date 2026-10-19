// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The synthetic write operation of the write gate item (issue #16 § Acceptance Criteria), for the core, CLI, MCP and
 * umbrella tests: group `synthetic`, verb `write`, `kind: "write"`, input `{ thing_id, message?, dry_run? }`, calling
 * `ctx.gate.execute()` with a `readStatus` stub and a `send` that POSTs `synthetic/<thing id>` through the client.
 * The status read is a stub the test observes (`statusReads`), answering `has_match_none` unless the test sets
 * another value; `allowedStatus` is `has_match_none`. The writes item replaces it with the real operations. Test code
 * only: every `tsconfig.build.json` keeps `__tests__` out of `dist`, and the parity test checks no `synthetic` file
 * reaches a `dist`.
 *
 * Like `synthetic-operation.ts`, the file imports types only from the package, so the one built core the builders
 * load is the one the operation's `ctx.gate` comes from; the caller passes `writeResultSchema` from the core it
 * tests, the source in core's own tests and the built entry elsewhere.
 */

import type { z as zod } from "zod";
import { z } from "zod";

import type { Operation, OperationContext, WriteKind } from "../../index.js";

export const SYNTHETIC_WRITE_KIND = "synthetic.write" as WriteKind;

export const syntheticWriteInput = z.object({
  thing_id: z.number().int().positive(),
  message: z.string().optional(),
  dry_run: z.boolean().default(false),
});

export type SyntheticWriteInput = z.infer<typeof syntheticWriteInput>;

export interface SyntheticWriteOptions {
  /** What the status stub answers; `has_match_none` by default. A function answers per call. */
  status?: string | (() => Promise<string>);
  /** Whether the spec carries a status read at all; true by default. */
  readStatus?: boolean;
  /** The sentence appended to the status-not-none hint. */
  statusHint?: string;
  /** Counted on every status read, so a test asserts the read was or was not made. */
  statusReads?: { count: number };
  /** Overrides `send`; the client POST by default. */
  send?: (ctx: OperationContext, input: SyntheticWriteInput) => Promise<unknown>;
}

/** The request path of the synthetic POST, as the mock sees it under `/1/`. */
export function syntheticPostPath(thingId: number): string {
  return `synthetic/${String(thingId)}`;
}

/** The synthetic write operation over the given `writeResultSchema`, with the parts a test varies. */
export function syntheticWrite(writeResultSchema: zod.ZodType, options: SyntheticWriteOptions = {}): Operation {
  const counter = options.statusReads ?? { count: 0 };
  const operation: Operation<typeof syntheticWriteInput> = {
    group: "synthetic",
    verb: "write",
    kind: "write",
    description: "Run one synthetic write through the gate",
    needsSession: true,
    input: syntheticWriteInput,
    output: writeResultSchema,
    requests: [],
    cli: { positional: ["thing_id"] },
    exitCode: (output) => ((output as { outcome?: string }).outcome === "refused" ? 4 : 0),
    run: async (ctx, input) => {
      const containerId = ctx.config.config.session?.container_id ?? 0;
      const path = syntheticPostPath(input.thing_id);
      const body = { message: input.message ?? null, container_id: containerId };
      const readStatus = async (): Promise<string> => {
        counter.count += 1;
        const status = options.status ?? "has_match_none";
        return typeof status === "function" ? status() : status;
      };
      return ctx.gate.execute({
        kind: SYNTHETIC_WRITE_KIND,
        targetThingId: input.thing_id,
        message: input.message ?? null,
        dryRun: input.dry_run,
        request: { method: "POST", path, body },
        ...(options.readStatus === false ? {} : { readStatus, allowedStatus: "has_match_none" }),
        ...(options.statusHint === undefined ? {} : { statusHint: options.statusHint }),
        send: () => (options.send === undefined ? ctx.client.post(path, body) : options.send(ctx, input)),
        resultFields: (result: unknown) => {
          const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
          return {
            ...(typeof record["connection"] === "number" ? { connection: record["connection"] } : {}),
            ...(typeof record["message_id"] === "number" ? { message_id: record["message_id"] } : {}),
          };
        },
      });
    },
  };
  return operation;
}
