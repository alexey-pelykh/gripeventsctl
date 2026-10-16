// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `spawnMcpStdio(opts)`: start the built umbrella binary as `gripeventsctl mcp` in a child process
 * and connect an SDK `Client` to it over stdio, in a temporary home. The client transport parses
 * the child's stdout as protocol frames, so any non-protocol byte there breaks the handshake and
 * the harness rejects: that is the point of this harness. The child's stderr is collected and read
 * through `stderr()`; stderr is a separate pipe, so a test that reads the start line waits for it.
 *
 * The harness sets `PATH`, `HOME`, `USERPROFILE` and `GRIPEVENTSCTL_CONFIG_FILE` pointing at
 * `opts.home`, plus `opts.env`. `StdioClientTransport` (SDK 1.32.1, `client/stdio.js`) merges its
 * default inherited set underneath on every platform (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and
 * `USER` on POSIX; the variables a process needs to start on Windows), with the harness's values on
 * top, so the child sees no other variable of the test process and never the real home.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type CallToolResult, ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { CONFIG_FILE_NAME } from "./guarded-paths.js";
import { MCP_TEST_CLIENT } from "./mcp-harness.js";

export interface SpawnMcpStdioOptions {
  /** The temporary home directory the child sees as `HOME` and `USERPROFILE`. */
  home: string;
  /** Further variables for the child, on top of the reduced set. */
  env?: NodeJS.ProcessEnv;
  /** The script to start instead of the umbrella binary: an absolute path, for a test-only child. */
  entry?: string;
}

export interface StdioLink {
  client: Client;
  /** The `tools` array of one `tools/list` call; empty when the server registers no tool. */
  listTools(): Promise<Tool[]>;
  /** The raw result of one `tools/call`. */
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Everything the child wrote to stderr so far. */
  stderr(): string;
  /** Close the client; the child process ends with the transport. A transport error seen so far is thrown. */
  close(): Promise<void>;
}

/** The repository root: the directory holding `pnpm-workspace.yaml`, found by walking up from this file. */
export function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("spawnMcpStdio: no pnpm-workspace.yaml above the harness file");
    dir = parent;
  }
}

/** The built umbrella binary. */
export function umbrellaBinary(): string {
  return join(repositoryRoot(), "packages", "gripeventsctl", "dist", "cli.js");
}

/** The variables the harness sets on the child; the transport adds its default inherited set underneath. */
export function childEnvironment(opts: SpawnMcpStdioOptions): Record<string, string> {
  const base: Record<string, string> = {};
  const path = process.env["PATH"];
  if (path !== undefined) base["PATH"] = path;
  base["HOME"] = opts.home;
  base["USERPROFILE"] = opts.home;
  base["GRIPEVENTSCTL_CONFIG_FILE"] = join(opts.home, CONFIG_FILE_NAME);
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined) base[name] = value;
  }
  return base;
}

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

/** Start the server child and complete the handshake; rejects on any transport error during it. */
export async function spawnMcpStdio(opts: SpawnMcpStdioOptions): Promise<StdioLink> {
  const entry = opts.entry ?? umbrellaBinary();
  if (!existsSync(entry)) {
    throw new Error(`spawnMcpStdio: ${entry} is missing; build the packages first (pnpm build)`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: childEnvironment(opts),
    stderr: "pipe",
  });
  let stderr = "";
  (transport.stderr as Readable | null)?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const errors: Error[] = [];
  let failHandshake: ((error: Error) => void) | undefined;
  const client = new Client(MCP_TEST_CLIENT);
  client.onerror = (error) => {
    errors.push(error);
    failHandshake?.(error);
  };

  const handshakeError = new Promise<never>((_resolve, reject) => {
    failHandshake = (error) => {
      reject(
        new Error(`spawnMcpStdio: the handshake failed: ${error.message}; stderr so far: ${JSON.stringify(stderr)}`),
      );
    };
  });
  try {
    await Promise.race([client.connect(transport), handshakeError]);
  } catch (error: unknown) {
    await transport.close().catch(() => undefined);
    throw error;
  } finally {
    failHandshake = undefined;
  }

  const checked = async <T>(fn: () => Promise<T>): Promise<T> => {
    const seen = errors.length;
    const result = await fn();
    const first = errors[seen];
    if (first !== undefined) throw first;
    return result;
  };

  return {
    client,
    listTools: () => checked(() => listToolsOf(client)),
    callTool: (name, args = {}) =>
      checked(async () => (await client.callTool({ name, arguments: args })) as CallToolResult),
    stderr: () => stderr,
    close: async () => {
      await client.close();
      const first = errors[0];
      if (first !== undefined) throw first;
    },
  };
}
