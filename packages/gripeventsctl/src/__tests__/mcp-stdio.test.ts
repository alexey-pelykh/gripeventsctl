// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-PARITY, process: the stdio smoke test over the built binary (issue #9 § The stdio smoke test, AC-17).
 * `spawnMcpStdio({ home })` starts `dist/cli.js mcp` in a temporary home: the handshake completes, `tools/list`
 * answers the same names as the in-memory server, and stderr holds exactly one start line naming the config path
 * under the home and `no config` or `safe mode`. The client transport parses stdout as protocol frames, so a
 * non-protocol byte there would have failed the handshake. It runs under `pnpm test`, which builds first.
 */

import { linkMcp, spawnMcpStdio, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { buildServer } from "../index.js";

/** Stderr is a separate pipe: give the start line a moment to arrive after the reply. */
async function waitForLine(read: () => string): Promise<void> {
  for (let waited = 0; !read().includes("\n") && waited < 5000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("[CAP-PARITY] gripeventsctl mcp over stdio lists the registered tools and writes one start line", () => {
  it("AC-17: the handshake completes, tools/list equals the in-memory list, and stderr holds exactly one start line naming the config path under home", async () => {
    await withTempHome(async (home) => {
      const inMemory = await linkMcp(buildServer());
      let expected: string[];
      try {
        expected = (await inMemory.listTools()).map((tool) => tool.name);
      } finally {
        await inMemory.close();
      }

      const link = await spawnMcpStdio({ home: home.dir });
      try {
        const names = (await link.listTools()).map((tool) => tool.name);
        expect(names).toEqual(expected);
        expect(names.filter((name) => name.startsWith("gripeventsctl_auth_"))).toEqual([]);
        await waitForLine(() => link.stderr());
        const lines = link
          .stderr()
          .split(/\r?\n/)
          .filter((line) => line !== "");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`gripeventsctl mcp: config ${home.configFile}, `);
        expect(lines[0]).toMatch(/no config|safe mode/);
      } finally {
        await link.close();
      }
    });
  });
});
