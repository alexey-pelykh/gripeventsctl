// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type TempHome, fixtureSecrets, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { loadConfig, saveConfig } from "../config/store.js";
import type { Config } from "../config/schema.js";

const WORKER = fileURLToPath(new URL("./workers/save-config.worker.ts", import.meta.url));

function configFor(slug: string, token: string): Config {
  return {
    version: 1,
    session: { slug, container_id: 1, token, signed_in_at: "2026-10-12T12:00:00Z" },
    writes: { enabled: false },
  };
}

async function expectWholeConfig(home: TempHome, candidates: Config[]): Promise<void> {
  const text = await readFile(home.configFile, "utf8");
  const parsed: unknown = parse(text);
  expect(candidates).toContainEqual(parsed);
  expect((await loadConfig({ env: home.env })).config).toEqual(parsed);
  expect((await readdir(home.dir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
}

function runWorker(home: TempHome, slug: string, token: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, slug, token], {
      env: { ...home.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stderr });
    });
  });
}

describe("[CAP-CFG] concurrent saves leave one whole config", () => {
  it("component: two concurrent saveConfig() calls in one process", async () => {
    await withTempHome(async (home) => {
      const a = configFor("event-a", fixtureSecrets().sessionToken);
      const b = configFor("event-b", fixtureSecrets().sessionToken);
      await Promise.all([saveConfig(a, { env: home.env }), saveConfig(b, { env: home.env })]);
      await expectWholeConfig(home, [a, b]);
    });
  });

  it("process: two child processes saving through the built core", async () => {
    await withTempHome(async (home) => {
      const a = configFor("event-a", fixtureSecrets().sessionToken);
      const b = configFor("event-b", fixtureSecrets().sessionToken);
      const [first, second] = await Promise.all([
        runWorker(home, "event-a", a.session?.token ?? ""),
        runWorker(home, "event-b", b.session?.token ?? ""),
      ]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      await expectWholeConfig(home, [a, b]);
    });
  });
});
