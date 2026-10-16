// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { linkMcp } from "../mcp-harness.js";

function oneToolServer(): McpServer {
  const server = new McpServer({ name: "one-tool", version: "0.0.0" });
  server.registerTool("echo_state", { description: "answers a fixed state" }, () => {
    console.error("handler console line");
    process.stderr.write("handler stderr line\n");
    return Promise.resolve({
      content: [{ type: "text", text: "state: synthetic" }],
      structuredContent: { state: "synthetic", count: 1 },
    });
  });
  return server;
}

describe("[CAP-TEST-TOOLING] linkMcp()", () => {
  it("lists the registered tool and returns the raw CallToolResult of a call", async () => {
    const link = await linkMcp(oneToolServer());
    try {
      const tools = await link.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo_state"]);
      const result = await link.callTool("echo_state");
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: "state: synthetic" }]);
      expect(result.structuredContent).toEqual({ state: "synthetic", count: 1 });
    } finally {
      await link.close();
    }
  });

  it("answers an empty list for a server with no tool", async () => {
    const link = await linkMcp(new McpServer({ name: "no-tool", version: "0.0.0" }));
    try {
      expect(await link.listTools()).toEqual([]);
    } finally {
      await link.close();
    }
  });

  it("captures what a handler writes through console.error or process.stderr during the call", async () => {
    const link = await linkMcp(oneToolServer());
    try {
      expect(link.stderr()).toBe("");
      await link.callTool("echo_state");
      expect(link.stderr()).toBe("handler console line\nhandler stderr line\n");
      expect(link.stdout()).toBe("");
    } finally {
      await link.close();
    }
  });

  it("closes both transports: a call after close() rejects", async () => {
    const server = oneToolServer();
    const link = await linkMcp(server);
    await link.close();
    expect(link.client.transport).toBeUndefined();
    expect(server.isConnected()).toBe(false);
    await expect(link.callTool("echo_state")).rejects.toThrow();
  });
});
