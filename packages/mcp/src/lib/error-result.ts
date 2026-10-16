// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `isError` result of a tool call (issue #9 § The MCP builder): `{ isError: true, content: [{ type: "text",
 * text: JSON.stringify({ error: { kind, message, hint } }) }], structuredContent: { error: { kind, message, hint } } }`,
 * every field redacted. A `GripError` keeps its kind; an unexpected exception is the `api` kind with a redacted
 * message and no hint. The handler never throws past the SDK, so the server never dies on one bad call.
 */

import { GripError, redactString } from "@gripeventsctl/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The three fields of the error object. */
export interface ErrorReport {
  kind: string;
  message: string;
  hint: string;
}

/** The kind an exception that is not a `GripError` takes on this path (the CLI `--json` form says `unexpected`). */
export const UNEXPECTED_KIND = "api";

/** The `kind`, `message` and `hint` of `error`, each redacted. */
export function describeError(error: unknown): ErrorReport {
  if (error instanceof GripError) {
    return { kind: error.kind, message: redactString(error.message), hint: redactString(error.hint) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: UNEXPECTED_KIND, message: redactString(message), hint: "" };
}

/** The error result for `error`: the text block holds the same JSON the structured content carries. */
export function errorResult(error: unknown): CallToolResult {
  const report = { error: describeError(error) };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(report) }],
    structuredContent: report,
  };
}
