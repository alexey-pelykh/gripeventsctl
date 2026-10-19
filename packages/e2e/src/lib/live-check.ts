// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * What the nine live files share (issue #18 § The nine files, the common shape): `openLive()` for the
 * `beforeAll`, which turns a missing session into `inconclusive` for every test of the file;
 * `callLive()` for one tool call with the requests it sent; `report()` for the summary lines of that
 * call, one per request, matched to the operation's documented shapes; and `checkedCall()`, the three
 * in sequence with the classification concluded. No file names a container id, a slug, a type id or a
 * thing id as a literal; every value comes from the session or from an earlier answer in the file.
 */

import { OPERATIONS, type RequestShape, redactString } from "@gripeventsctl/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type Classification,
  type Concluder,
  type Outcome,
  classify,
  drift,
  inconclusive,
  isRecord,
} from "./outcome.js";
import type { RecordedCall } from "./recorder.js";
import { type LiveServer, liveServer } from "./server.js";
import { type LiveSession, NO_SESSION_MESSAGE, liveSession } from "./session.js";
import { runDate, summaryLine, templatePath } from "./summary.js";

export interface Live {
  session: LiveSession;
  server: LiveServer;
}

export interface LiveFixture {
  /** The session and the server, or the skip of the calling test with the reason neither could be opened. */
  ready(ctx: Concluder): Live;
  close(): Promise<void>;
}

/** For a `beforeAll`: never throws; what went wrong becomes the reason every test of the file skips with. */
export async function openLive(): Promise<LiveFixture> {
  let live: Live | undefined;
  let problem: string | undefined;
  try {
    const session = await liveSession();
    const server = await liveServer();
    live = { session, server };
  } catch (error: unknown) {
    problem = redactString(error instanceof Error ? error.message : String(error));
  }
  return {
    ready(ctx) {
      if (live === undefined) return inconclusive(ctx, problem ?? NO_SESSION_MESSAGE);
      return live;
    },
    close: async () => {
      await live?.server.close();
    },
  };
}

export interface ToolCall {
  tool: string;
  result: CallToolResult;
  /** The requests the call sent, in order. */
  calls: RecordedCall[];
  /** `structuredContent` where it is an object. */
  content: Record<string, unknown> | undefined;
}

/** One tool call through the live server, with the requests it sent. */
export async function callLive(
  server: LiveServer,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const mark = server.recorder.calls.length;
  const result = await server.link.callTool(tool, args);
  const calls = server.recorder.calls.slice(mark);
  return { tool, result, calls, content: isRecord(result.structuredContent) ? result.structuredContent : undefined };
}

/** The documented request shapes of the operation behind `tool`. */
export function requestShapes(tool: string): readonly RequestShape[] {
  const op = OPERATIONS.find((candidate) => `gripeventsctl_${candidate.group}_${candidate.verb}` === tool);
  if (op === undefined) throw new Error(`no operation registers the tool ${tool}`);
  return op.requests;
}

/** The template printed for a request no documented shape of the operation matches. */
export const UNMATCHED_TEMPLATE = "<unmatched>";

/**
 * The summary lines of one call: one per request sent, each matched to a documented shape of the
 * operation; one with `-` for every shape that sent nothing; one with the tool's name for an operation
 * that sends nothing. Returns the lines, and `unmatched` where a request matched no shape (`report()`'s
 * caller fails that as drift naming the templates).
 */
export function summaryLines(
  file: string,
  call: ToolCall,
  outcome: Outcome,
  date: string = runDate(),
): { lines: string[]; unmatched: boolean } {
  const shapes = requestShapes(call.tool);
  const lines: string[] = [];
  let unmatched = false;
  if (shapes.length === 0) lines.push(summaryLine(file, outcome, "-", call.tool, "-", date));
  const covered = new Set<RequestShape>();
  for (const sent of call.calls) {
    const shape = shapes.find(
      (candidate) => candidate.method === sent.method && templatePath(sent.path, candidate.pathTemplate),
    );
    if (shape === undefined) {
      unmatched = true;
      lines.push(summaryLine(file, "contract-drift", sent.method, UNMATCHED_TEMPLATE, sent.status, date));
      continue;
    }
    covered.add(shape);
    lines.push(summaryLine(file, outcome, shape.method, shape.pathTemplate, sent.status, date));
  }
  for (const shape of shapes) {
    if (!covered.has(shape)) lines.push(summaryLine(file, outcome, shape.method, shape.pathTemplate, "-", date));
  }
  return { lines, unmatched };
}

/** Write the summary lines of `call` to stderr; a request no documented shape matches is drift naming the templates. */
export function report(file: string, call: ToolCall, outcome: Outcome): void {
  const { lines, unmatched } = summaryLines(file, call, outcome);
  for (const line of lines) process.stderr.write(`${line}\n`);
  if (unmatched) {
    const templates = requestShapes(call.tool)
      .map((shape) => `${shape.method} ${shape.pathTemplate}`)
      .join(", ");
    drift(`${call.tool} sent a request that matches none of its documented shapes: ${templates}`);
  }
}

/**
 * One call, classified against `needs` (dotted paths of `structuredContent`), reported, and concluded:
 * the test skips or fails here unless the outcome is `verified`, in which case the content is returned.
 */
export async function checkedCall(
  ctx: Concluder,
  file: string,
  server: LiveServer,
  tool: string,
  args: Record<string, unknown>,
  needs: readonly string[],
): Promise<{ call: ToolCall; content: Record<string, unknown> }> {
  const call = await callLive(server, tool, args);
  const classification: Classification = classify(call.result, needs);
  report(file, call, classification.outcome);
  if (classification.outcome === "inconclusive") return inconclusive(ctx, classification.reason ?? "");
  if (classification.outcome === "contract-drift" || call.content === undefined) {
    return drift(classification.reason ?? "the result carries no structuredContent");
  }
  return { call, content: call.content };
}
