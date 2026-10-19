// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { type LoadResult, OPERATIONS, configPath, loadConfig, redactString } from "@gripeventsctl/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { type ServerDeps, toolDeps } from "./lib/context.js";
import { toolFromOperation } from "./lib/tool-from-operation.js";

export const SERVER_NAME = "gripeventsctl";

export { type CallExtras, type ServerDeps, type ToolDeps } from "./lib/context.js";
export { type ErrorReport, errorResult } from "./lib/error-result.js";
export { toolFromOperation } from "./lib/tool-from-operation.js";

/**
 * Build the MCP server: one tool per entry of `deps.operations` (the registry `OPERATIONS` by default), each the
 * twin of a CLI leaf command (see `.mcp-exempt.yaml` at the repository root for the declared exceptions), over the
 * environment, clock, dispatcher and stderr `deps` names, the process's own by default. Never a tool whose name
 * starts with `gripeventsctl_auth_`: the server consumes the stored session and never signs in.
 */
export function buildServer(version = "0.0.0", deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });
  const shared = toolDeps(deps);
  for (const op of deps.operations ?? OPERATIONS) toolFromOperation(server, op, shared);
  return server;
}

/** What the start line reports: the loaded config, or the error loading it raised. */
export type StartState = LoadResult | { path: string; error: unknown };

/**
 * The one line `gripeventsctl mcp` writes to stderr at start: the resolved config path and the
 * write state in the fixed vocabulary (`safe mode` or `writes enabled`), `no config` when no file
 * exists, or the `config` error when the file cannot be loaded.
 */
export function startLine(state: StartState): string {
  if ("error" in state) {
    const message = state.error instanceof Error ? state.error.message : String(state.error);
    return `${SERVER_NAME} mcp: config ${state.path}, config error: ${message}`;
  }
  if (!state.exists) return `${SERVER_NAME} mcp: config ${state.path}, no config`;
  return `${SERVER_NAME} mcp: config ${state.path}, ${state.config.writes.enabled ? "writes enabled" : "safe mode"}`;
}

/** Load the config for the start line; a missing or invalid config never stops the server. */
export async function describeStart(env?: NodeJS.ProcessEnv): Promise<string> {
  const options = env === undefined ? {} : { env };
  try {
    return startLine(await loadConfig(options));
  } catch (error: unknown) {
    let path = "<unresolved>";
    try {
      path = configPath(env);
    } catch {
      // The home directory itself cannot be resolved; the line still names the error.
    }
    return startLine({ path, error });
  }
}

export interface RunOptions {
  /** The environment the config path is resolved from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the start line goes; default `process.stderr`. Stdout stays the transport. */
  stderr?: NodeJS.WritableStream;
}

/** Run the server over stdio until the client disconnects. */
export async function runMcpStdio(version?: string, options: RunOptions = {}): Promise<void> {
  const stderr = options.stderr ?? process.stderr;
  stderr.write(`${redactString(await describeStart(options.env))}\n`);
  const server = buildServer(version, { ...(options.env === undefined ? {} : { env: options.env }), stderr });
  await server.connect(new StdioServerTransport());
}
