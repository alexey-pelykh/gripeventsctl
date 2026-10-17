// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { type TempHome, fixtureSecrets, withTempHome } from "@gripeventsctl/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

interface Run {
  /** Every stderr line the server wrote before the client closed it. */
  stderrLines: string[];
  /** The transport errors the client saw: a non-protocol line on stdout is one. */
  errors: Error[];
  /** The server name from the initialize handshake. */
  serverName: string | undefined;
  /** The tool names `tools/list` answered. */
  toolNames: string[];
}

/**
 * The names `tools/list` answers. A server with no tool registered advertises no `tools` capability and answers
 * `tools/list` with "Method not found" (`@modelcontextprotocol/sdk` 1.32.1): that is the empty list. The registry
 * holds the operation items' tools; the auth item asserts the list holds no `gripeventsctl_auth_` tool, and the
 * parity gate asserts the same against the full list.
 */
async function listToolNames(client: Client): Promise<string[]> {
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } catch (error: unknown) {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return [];
    throw error;
  }
}

/** Start the built binary as `gripeventsctl mcp` with `home`, run one protocol exchange, stop it. */
async function runServer(home: TempHome): Promise<Run> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: {
      ...getDefaultEnvironment(),
      HOME: home.dir,
      USERPROFILE: home.dir,
      GRIPEVENTSCTL_CONFIG_FILE: home.configFile,
    },
    stderr: "pipe",
  });
  let stderr = "";
  (transport.stderr as Readable | null)?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const errors: Error[] = [];
  const client = new Client({ name: "mcp-start-line-test", version: "0.0.0" });
  client.onerror = (error) => {
    errors.push(error);
  };
  await client.connect(transport);
  try {
    // A ping is the one round trip after the handshake that touches no tool.
    await client.ping();
    const toolNames = await listToolNames(client);
    // stderr and stdout are separate pipes: give the start line a moment to arrive after the reply.
    for (let waited = 0; !stderr.includes("\n") && waited < 5000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      stderrLines: stderr.split(/\r?\n/).filter((line) => line !== ""),
      errors,
      serverName: client.getServerVersion()?.name,
      toolNames,
    };
  } finally {
    await client.close();
  }
}

describe("[CAP-PARITY] the gripeventsctl mcp start line", () => {
  it("writes one stderr line naming the config path and `no config`, and only protocol frames to stdout", async () => {
    await withTempHome(async (home) => {
      const run = await runServer(home);
      expect(run.errors).toEqual([]);
      expect(run.serverName).toBe("gripeventsctl");
      expect(run.stderrLines).toEqual([`gripeventsctl mcp: config ${home.configFile}, no config`]);
    });
  });

  it("[CAP-AUTH] lists no tool whose name starts with gripeventsctl_auth_ when a session is stored", async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      await writeFile(
        home.configFile,
        `version: 1\nsession:\n  slug: testevent1\n  container_id: 1\n  token: ${token}\n  signed_in_at: 2026-10-12T19:09:00Z\nwrites:\n  enabled: false\n`,
        { mode: 0o600 },
      );
      const run = await runServer(home);
      expect(run.errors).toEqual([]);
      expect(run.toolNames.filter((name) => name.startsWith("gripeventsctl_auth_"))).toEqual([]);
    });
  });

  it("says `safe mode` or `writes enabled` from the config file", async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      const yaml = (enabled: boolean): string =>
        `version: 1\nsession:\n  slug: testevent1\n  container_id: 1\n  token: ${token}\n  signed_in_at: 2026-10-12T19:09:00Z\nwrites:\n  enabled: ${String(enabled)}\n`;
      await writeFile(home.configFile, yaml(false), { mode: 0o600 });
      expect((await runServer(home)).stderrLines).toEqual([`gripeventsctl mcp: config ${home.configFile}, safe mode`]);
      await writeFile(home.configFile, yaml(true), { mode: 0o600 });
      expect((await runServer(home)).stderrLines).toEqual([
        `gripeventsctl mcp: config ${home.configFile}, writes enabled`,
      ]);
    });
  });

  it("names the config error and still serves the protocol when the file is invalid", async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, "version: 1\nsessions: {}\n", { mode: 0o600 });
      const run = await runServer(home);
      expect(run.errors).toEqual([]);
      expect(run.stderrLines).toHaveLength(1);
      expect(run.stderrLines[0]).toContain(`gripeventsctl mcp: config ${home.configFile}, config error:`);
      expect(run.stderrLines[0]).toContain('unknown key "sessions"');
    });
  });
});
