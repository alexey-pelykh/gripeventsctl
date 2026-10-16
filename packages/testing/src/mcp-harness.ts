// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `linkMcp(server)`: connect a real `McpServer` to an SDK `Client` over an in-memory transport pair
 * (`InMemoryTransport.createLinkedPair()`), so a test drives the server through the protocol it
 * speaks to an assistant: `tools/list` and `tools/call`, with the raw `CallToolResult` read back.
 * What a handler writes to `process.stderr` or `console.error` while a call is in flight is captured
 * and read through `stderr()`; the link holds one capture open while any of its calls is in flight,
 * so two calls issued together share it and a line is recorded once. A write made after the last
 * call returned is not covered.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { openOutputCapture } from "./capture-output.js";

export interface McpLink {
  client: Client;
  /** The `tools` array of one `tools/list` call; empty when the server registers no tool. */
  listTools(): Promise<Tool[]>;
  /** The raw result of one `tools/call`, so a test reads `isError`, `content` and `structuredContent`. */
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** What the server wrote to `process.stderr` or `console.error` during the calls so far. */
  stderr(): string;
  /** What the server wrote to `process.stdout` or `console.log` during the calls so far (nothing, for a well-behaved server). */
  stdout(): string;
  /** Close the client and the server; both transports close with them. */
  close(): Promise<void>;
}

/** The name the test client announces in the handshake. */
export const MCP_TEST_CLIENT = { name: "gripeventsctl-test", version: "0.0.0" } as const;

/**
 * `tools/list` on a server with no tool registered answers "Method not found" (SDK 1.32.1: the
 * `tools` capability is advertised only once a tool is registered); that is the empty list.
 */
/** `ErrorCode.MethodNotFound` as the plain number `McpError.code` carries. */
const METHOD_NOT_FOUND: number = ErrorCode.MethodNotFound;

async function listToolsOf(client: Client): Promise<Tool[]> {
  try {
    return (await client.listTools()).tools;
  } catch (error: unknown) {
    if (error instanceof McpError && error.code === METHOD_NOT_FOUND) return [];
    throw error;
  }
}

/** Connect `server` and a fresh client over a linked in-memory transport pair. */
export async function linkMcp(server: McpServer): Promise<McpLink> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(MCP_TEST_CLIENT);
  let stderr = "";
  let stdout = "";
  let inFlight = 0;
  let close: (() => void) | undefined;
  const captured = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight === 0) {
      close = openOutputCapture({
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      });
    }
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      if (inFlight === 0) {
        close?.();
        close = undefined;
      }
    }
  };

  await server.connect(serverTransport);
  await captured(() => client.connect(clientTransport));

  return {
    client,
    listTools: () => captured(() => listToolsOf(client)),
    callTool: (name, args = {}) =>
      captured(async () => (await client.callTool({ name, arguments: args })) as CallToolResult),
    stderr: () => stderr,
    stdout: () => stdout,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
