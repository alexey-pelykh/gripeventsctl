// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The stdio harness against the built umbrella binary (`packages/gripeventsctl/dist/cli.js`, built
 * before the tests through Turborepo) in a temporary home holding no config.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { childEnvironment, repositoryRoot, spawnMcpStdio, umbrellaBinary } from "../stdio-harness.js";

const NOISY = fileURLToPath(new URL("../../dist/__tests__/workers/noisy-stdout.js", import.meta.url));

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gripeventsctl-stdio-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function waitForLine(read: () => string, timeoutMs = 5000): Promise<string> {
  for (let waited = 0; !read().includes("\n") && waited < timeoutMs; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read();
}

describe("[CAP-TEST-TOOLING] spawnMcpStdio()", () => {
  it("resolves the repository root and the umbrella binary from the harness file", () => {
    expect(repositoryRoot().endsWith("gripeventsctl") || repositoryRoot().length > 0).toBe(true);
    expect(umbrellaBinary()).toBe(join(repositoryRoot(), "packages", "gripeventsctl", "dist", "cli.js"));
  });

  it("completes the handshake, lists the tools, reads the start line from stderr and nothing from stdout", async () => {
    const link = await spawnMcpStdio({ home });
    try {
      const tools = await link.listTools();
      expect(Array.isArray(tools)).toBe(true);
      const stderr = await waitForLine(() => link.stderr());
      expect(stderr.split(/\r?\n/).filter((line) => line !== "")).toEqual([
        `gripeventsctl mcp: config ${join(home, ".gripeventsctl.yaml")}, no config`,
      ]);
    } finally {
      await link.close();
    }
  });

  it("rejects when the child writes a non-protocol line to stdout", async () => {
    await expect(spawnMcpStdio({ home, entry: NOISY })).rejects.toThrow(/handshake failed/u);
  });

  it("rejects naming the build step when the entry is missing", async () => {
    await expect(spawnMcpStdio({ home, entry: join(home, "missing.js") })).rejects.toThrow(/pnpm build/u);
  });

  it("reduces the child's environment to PATH, the home variables and the given extras", () => {
    const env = childEnvironment({ home, env: { GRIPEVENTSCTL_E2E: "0" } });
    expect(env["HOME"]).toBe(home);
    expect(env["USERPROFILE"]).toBe(home);
    expect(env["GRIPEVENTSCTL_CONFIG_FILE"]).toBe(join(home, ".gripeventsctl.yaml"));
    expect(env["GRIPEVENTSCTL_E2E"]).toBe("0");
    expect(env["PATH"]).toBe(process.env["PATH"]);
    if (process.platform !== "win32") {
      expect(Object.keys(env).sort()).toEqual([
        "GRIPEVENTSCTL_CONFIG_FILE",
        "GRIPEVENTSCTL_E2E",
        "HOME",
        "PATH",
        "USERPROFILE",
      ]);
    }
  });
});
