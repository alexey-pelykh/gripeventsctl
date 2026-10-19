// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The three outcomes of a live check (issue #18 § Outcomes) and how a test resolves to one:
 *
 * - `verified`: the service was reached, the server validated `structuredContent` against the tool's
 *   output schema, and every field the check names is present. The test passes.
 * - `contract-drift`: the service was reached and disagrees: an `isError` result of a kind not named
 *   under `inconclusive`, a named field absent, or a value of another type than documented. The test
 *   fails, naming field names and kinds only, never a value.
 * - `inconclusive`: the service could not confirm: no session; `no-session`, `network`, `auth-failed`
 *   or `throttled`; an empty list where the check needs an element; a field the next step needs that
 *   the platform did not send. The test skips with the reason.
 *
 * A test never reports green when it could not check, and never prints a field value. Every reason
 * passes through `redactString` before it reaches Vitest.
 */

import { redactString } from "@gripeventsctl/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";

export type Outcome = "verified" | "contract-drift" | "inconclusive";

/** The `error.kind` values that mean the service could not confirm. */
export const INCONCLUSIVE_KINDS: readonly string[] = Object.freeze([
  "no-session",
  "network",
  "auth-failed",
  "throttled",
]);

export interface Classification {
  outcome: Outcome;
  /** Field names and kinds only. */
  reason?: string;
  /** The named fields found absent, on `contract-drift`. */
  fields?: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `structuredContent.error.kind` of an `isError` result. */
export function errorKind(result: CallToolResult): string | undefined {
  if (!isRecord(result.structuredContent)) return undefined;
  const error = result.structuredContent["error"];
  if (!isRecord(error)) return undefined;
  const kind = error["kind"];
  return typeof kind === "string" ? kind : undefined;
}

/** The value at a dotted `path` of `content`, or `undefined` where a step is missing. */
export function fieldAt(content: unknown, path: string): unknown {
  let current: unknown = content;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The outcome table applied to one tool result; `needs` are dotted field paths of `structuredContent`. */
export function classify(result: CallToolResult, needs: readonly string[]): Classification {
  if (result.isError === true) {
    const kind = errorKind(result) ?? "<no kind>";
    if (INCONCLUSIVE_KINDS.includes(kind)) return { outcome: "inconclusive", reason: `the tool answered ${kind}` };
    return { outcome: "contract-drift", reason: `the tool answered the error kind ${kind}` };
  }
  if (!isRecord(result.structuredContent)) {
    return { outcome: "contract-drift", reason: "the result carries no structuredContent", fields: [] };
  }
  const missing = needs.filter((path) => fieldAt(result.structuredContent, path) === undefined);
  if (missing.length > 0) {
    return { outcome: "contract-drift", reason: `missing field: ${missing.join(", ")}`, fields: missing };
  }
  return { outcome: "verified" };
}

export type FieldType = "string" | "string?" | "boolean" | "integer" | "number" | "array" | "object" | "present";

/** True where `value` has the documented `type`; `string?` a string or null, `integer` a safe integer, `present` anything but `undefined` and `null`. */
export function hasType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
    case "boolean":
    case "number":
      return typeof value === type;
    case "string?":
      return value === null || typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "present":
      return value !== undefined && value !== null;
  }
}

/** The dotted paths of `content` whose value has another type than `expected` documents, in the order given. */
export function typeMismatches(content: unknown, expected: Readonly<Record<string, FieldType>>): string[] {
  return Object.entries(expected)
    .filter(([path, type]) => !hasType(fieldAt(content, path), type))
    .map(([path]) => path);
}

/** The classification of `elements`: every one must have the fields of `expected`, by index. */
export function elementMismatches(
  elements: readonly unknown[],
  expected: Readonly<Record<string, FieldType>>,
): string[] {
  const names = new Set<string>();
  elements.forEach((element, index) => {
    for (const path of typeMismatches(element, expected)) names.add(`[${String(index)}].${path}`);
  });
  return [...names];
}

/** What `conclude()` needs of Vitest's test context. */
export interface Concluder {
  skip(note?: string): never;
}

/** Skip the test: the service could not confirm. */
export function inconclusive(ctx: Concluder, reason: string): never {
  return ctx.skip(`inconclusive: ${redactString(reason)}`);
}

/** Fail the test: the service disagrees with the documented shape. */
export function drift(reason: string): never {
  return expect.fail(`contract drift: ${redactString(reason)}`);
}

/** `ctx.skip(reason)` for `inconclusive`, `expect.fail(message)` for `contract-drift`, nothing for `verified`. */
export function conclude(ctx: Concluder, outcome: Outcome, reason?: string): void {
  if (outcome === "inconclusive") inconclusive(ctx, reason ?? "the service could not confirm");
  if (outcome === "contract-drift") drift(reason ?? "the service disagrees with the documented shape");
}

/** True for a positive safe integer: a thing id, a container id, a message id. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The array at `path` of `content`; anything else is drift naming the path. */
export function requireArray(content: unknown, path: string): unknown[] {
  const value = fieldAt(content, path);
  if (!Array.isArray(value)) return drift(`${path} is not an array`);
  return value as unknown[];
}

/** The object at `path` of `content`; anything else is drift naming the path. */
export function requireRecord(content: unknown, path: string): Record<string, unknown> {
  const value = fieldAt(content, path);
  if (!isRecord(value)) return drift(`${path} is not an object`);
  return value;
}
