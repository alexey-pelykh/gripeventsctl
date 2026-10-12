// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const SERVER_NAME = "gripeventsctl";

/**
 * Build the MCP server. Tools register here as they land, each one the twin of a CLI command
 * (see `.mcp-exempt.yaml` at the repository root for the declared exceptions).
 */
export function buildServer(version = "0.0.0"): McpServer {
  return new McpServer({ name: SERVER_NAME, version });
}

/** Run the server over stdio until the client disconnects. */
export async function runMcpStdio(version?: string): Promise<void> {
  const server = buildServer(version);
  await server.connect(new StdioServerTransport());
}
