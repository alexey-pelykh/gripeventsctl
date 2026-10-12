// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { buildServer } from "../index.js";

describe("buildServer", () => {
  it("returns an MCP server", () => {
    expect(buildServer("1.2.3")).toBeInstanceOf(McpServer);
  });
});
