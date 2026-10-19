// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The isolated probe config (issue #18 § Acceptance Criteria, the `inMemoryStore` criterion, met through the
 * config-path seam): a client built over the probe's environment that handles a 401 raises `auth-failed`, records
 * the failure in the probe's own file, and changes nothing under the temporary home that stands for the maintainer's.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { GripClient, type GripError, loadConfig, saveSession } from "@gripeventsctl/core";
import { fixtureSecrets, gripPool, mockGrip, stderrSink, unauthorized401 } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { probeStore } from "../lib/probe-store.js";
import { recordingDispatcher } from "../lib/recorder.js";

const agent = mockGrip();

/** Every entry of `dir` with its bytes, so a changed file or a new one is seen. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    try {
      entries.set(name, (await readFile(path)).toString("base64"));
    } catch {
      entries.set(name, "<not a file>");
    }
  }
  return entries;
}

describe("[CAP-E2E] probeStore()", () => {
  it("lets a client handle a 401 without touching the files under the temporary home", async () => {
    const home = process.env["HOME"] ?? "";
    const stored = fixtureSecrets().sessionToken;
    await saveSession({ slug: "testevent1", container_id: 1, token: stored });
    const before = await snapshot(home);
    expect(before.has(".gripeventsctl.yaml")).toBe(true);

    const wrong = fixtureSecrets().sessionToken;
    const probe = await probeStore({ slug: "testevent1", container_id: 1 }, wrong);
    try {
      expect(dirname(probe.path)).not.toBe(home);
      expect(probe.path.startsWith(home)).toBe(false);
      expect(probe.env["GRIPEVENTSCTL_CONFIG_FILE"]).toBe(probe.path);
      expect(probe.env["HOME"]).toBe(dirname(probe.path));
      const loaded = await probe.store.load();
      expect(loaded.config.session?.token).toBe(wrong);
      expect(loaded.config.session?.container_id).toBe(1);
      expect(loaded.config.writes).toEqual({ enabled: false });

      const recorder = recordingDispatcher(agent);
      const stderr = stderrSink();
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => unauthorized401());
      const client = new GripClient({ dispatcher: recorder.dispatcher, env: probe.env, stderr: stderr.stream });
      const error = (await client.get("container").catch((caught: unknown) => caught)) as GripError;
      expect(error.kind).toBe("auth-failed");
      expect(error.status).toBe(401);
      expect(recorder.calls).toEqual([{ method: "GET", path: "/1/container", status: 401 }]);

      // The 401 was recorded beside the probe's session, not beside the maintainer's.
      expect(typeof (await probe.store.load()).config.session?.auth_failed_at).toBe("string");
      expect((await loadConfig()).config.session?.auth_failed_at).toBeUndefined();
      expect(await snapshot(home)).toEqual(before);
      expect(stderr.text()).not.toContain(wrong);
      expect(stderr.text()).not.toContain(stored);
    } finally {
      const dir = dirname(probe.path);
      await probe.remove();
      expect(existsSync(dir)).toBe(false);
    }
  });
});
