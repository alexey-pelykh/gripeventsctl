// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type TempHome, fixtureSecrets, withTempHome } from "@gripeventsctl/testing";
import { lock as lockFile } from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import type { Config } from "../config/schema.js";
import { LOCK_OPTIONS, createConfigStore, loadConfig, saveConfig } from "../config/store.js";

// The worker runs the built core; `pnpm test` builds first (turbo: test depends on build).
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

function runWorker(home: TempHome, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
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
  it("component: two concurrent saveConfig() calls in one process, each under the cross-process lock", async () => {
    await withTempHome(async (home) => {
      const lock = vi.fn(lockFile);
      const a = configFor("event-a", fixtureSecrets().sessionToken);
      const b = configFor("event-b", fixtureSecrets().sessionToken);
      await Promise.all([saveConfig(a, { env: home.env, lock }), saveConfig(b, { env: home.env, lock })]);
      await expectWholeConfig(home, [a, b]);
      expect(lock).toHaveBeenCalledTimes(2);
      expect(lock).toHaveBeenCalledWith(home.configFile, LOCK_OPTIONS);
      expect(LOCK_OPTIONS).toMatchObject({
        realpath: false,
        retries: { retries: 5, minTimeout: 200, maxTimeout: 1000 },
      });
    });
  });

  it("component: the in-process queue runs two read-modify-write updates one after the other, keeping both changes", async () => {
    await withTempHome(async (home) => {
      const store = createConfigStore({ env: home.env });
      await store.save({ version: 1, writes: { enabled: false } });
      await Promise.all([
        store.update(({ config }) => ({ ...config, writes: { ...config.writes, enabled: true } })),
        store.update(({ config }) => ({ ...config, auth: { credentials: "op://Vault/Item" } })),
      ]);
      const { config } = await store.load();
      expect(config.writes.enabled).toBe(true);
      expect(config.auth?.credentials).toBe("op://Vault/Item");
    });
  });

  it("process: two child processes saving through the built core", async () => {
    await withTempHome(async (home) => {
      const a = configFor("event-a", fixtureSecrets().sessionToken);
      const b = configFor("event-b", fixtureSecrets().sessionToken);
      const [first, second] = await Promise.all([
        runWorker(home, ["save", "event-a", a.session?.token ?? ""]),
        runWorker(home, ["save", "event-b", b.session?.token ?? ""]),
      ]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      await expectWholeConfig(home, [a, b]);
    });
  });

  it("process: two child processes updating the same file keep both changes, because each reloads under the lock", async () => {
    await withTempHome(async (home) => {
      await saveConfig({ version: 1, writes: { enabled: false } }, { env: home.env });
      // Each child holds the lock for 400 ms inside its mutator; without the lock both would read
      // the seed and the second write would drop the first change.
      const [first, second] = await Promise.all([
        runWorker(home, ["merge", "writes", "400"]),
        runWorker(home, ["merge", "auth", "400"]),
      ]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      const { config } = await loadConfig({ env: home.env });
      expect(config.writes.enabled).toBe(true);
      expect(config.auth?.credentials).toBe("op://Vault/Item");
      expect((await readdir(home.dir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
    });
  });
});
