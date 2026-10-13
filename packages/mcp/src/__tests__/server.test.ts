// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer, describeStart, startLine } from "../index.js";

describe("buildServer", () => {
  it("returns an MCP server", () => {
    expect(buildServer("1.2.3")).toBeInstanceOf(McpServer);
  });
});

describe("[CAP-PARITY] the start line", () => {
  const path = "/home/me/.gripeventsctl.yaml";
  const config = { version: 1 as const, writes: { enabled: false } };

  it("says no config when no file exists", () => {
    expect(startLine({ config, path, exists: false, modeEnforced: true })).toBe(
      `gripeventsctl mcp: config ${path}, no config`,
    );
  });

  it("says safe mode or writes enabled in the fixed vocabulary", () => {
    expect(startLine({ config, path, exists: true, modeEnforced: true })).toBe(
      `gripeventsctl mcp: config ${path}, safe mode`,
    );
    expect(
      startLine({ config: { ...config, writes: { enabled: true } }, path, exists: true, modeEnforced: true }),
    ).toBe(`gripeventsctl mcp: config ${path}, writes enabled`);
  });

  it("names the config error", () => {
    expect(startLine({ path, error: new Error("version must be 1") })).toBe(
      `gripeventsctl mcp: config ${path}, config error: version must be 1`,
    );
  });

  describe("describeStart", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "gripeventsctl-mcp-start-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("loads the config from the given environment and never throws", async () => {
      const file = join(dir, "config.yaml");
      const env = { HOME: dir, USERPROFILE: dir, GRIPEVENTSCTL_CONFIG_FILE: file };
      await expect(describeStart(env)).resolves.toBe(`gripeventsctl mcp: config ${file}, no config`);
      await writeFile(file, "version: 1\nwrites:\n  enabled: true\n", { mode: 0o600 });
      await expect(describeStart(env)).resolves.toBe(`gripeventsctl mcp: config ${file}, writes enabled`);
      await writeFile(file, "version: 2\n", { mode: 0o600 });
      await expect(describeStart(env)).resolves.toContain(`gripeventsctl mcp: config ${file}, config error:`);
    });
  });
});
