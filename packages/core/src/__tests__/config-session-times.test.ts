// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFile, readdir, writeFile } from "node:fs/promises";

import { fakeClock, fixtureSecrets, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { type Config, emptyConfig } from "../config/schema.js";
import {
  type ConfigStore,
  type LoadResult,
  clearSession,
  loadConfig,
  recordAuthFailure,
  resolveSessionToken,
  saveConfig,
  saveSession,
} from "../config/store.js";
import { REDACTED, redactString } from "../lib/redact.js";
import { NoSessionError } from "../transport/errors.js";

function sessionConfig(token = fixtureSecrets().sessionToken): Config {
  return {
    version: 1,
    auth: { credentials: "op://Vault/Item" },
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T19:09:00Z" },
    writes: { enabled: true },
  };
}

describe("[CAP-CFG] the sign-in time and the first authentication failure", () => {
  it("records the first failure only, then sign-in clears it and sets signed_in_at from the clock", async () => {
    await withTempHome(async (home) => {
      await saveConfig(sessionConfig(), { env: home.env });
      const clock = fakeClock("2026-10-13T08:12:00Z");
      await recordAuthFailure({ env: home.env, clock });
      await clock.advance(60_000);
      await recordAuthFailure({ env: home.env, clock });
      let session = (await loadConfig({ env: home.env })).config.session;
      expect(session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");

      clock.set("2026-10-14T09:00:00.500Z");
      const token = fixtureSecrets().sessionToken;
      await saveSession({ slug: "testevent2", container_id: 2, token }, { env: home.env, clock });
      const loaded = await loadConfig({ env: home.env });
      session = loaded.config.session;
      expect(session).toEqual({ slug: "testevent2", container_id: 2, token, signed_in_at: "2026-10-14T09:00:00Z" });
      expect(session?.auth_failed_at).toBeUndefined();
      // The sign-in replaced the session and left the rest alone.
      expect(loaded.config.auth).toEqual({ credentials: "op://Vault/Item" });
      expect(loaded.config.writes).toEqual({ enabled: true });
    });
  });

  it("changes nothing when there is no session", async () => {
    await withTempHome(async (home) => {
      await recordAuthFailure({ env: home.env, clock: fakeClock() });
      expect(await readdir(home.dir)).toEqual([]);
      await writeFile(home.configFile, "version: 1\nwrites:\n  enabled: true\n", { mode: 0o600 });
      const before = await readFile(home.configFile);
      await recordAuthFailure({ env: home.env, clock: fakeClock() });
      expect(await readFile(home.configFile)).toEqual(before);
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });

  it("clearSession() removes the session and keeps writes and auth", async () => {
    await withTempHome(async (home) => {
      await saveConfig(sessionConfig(), { env: home.env });
      await clearSession({ env: home.env });
      const { config } = await loadConfig({ env: home.env });
      expect(config.session).toBeUndefined();
      expect(config.writes.enabled).toBe(true);
      expect(config.auth?.credentials).toBe("op://Vault/Item");
    });
  });

  it("works against an injected in-memory store", async () => {
    let state: Config = sessionConfig();
    const memory: ConfigStore = {
      path: "/memory/.gripeventsctl.yaml",
      modeEnforced: true,
      load: (): Promise<LoadResult> =>
        Promise.resolve({ config: state, path: "/memory/.gripeventsctl.yaml", exists: true, modeEnforced: true }),
      save: (config) => {
        state = config;
        return Promise.resolve();
      },
      update: async (mutate) => {
        const next = mutate(await memory.load());
        if (next !== undefined) state = next;
      },
    };
    await recordAuthFailure({ store: memory, clock: fakeClock("2026-10-13T08:12:00Z") });
    expect(state.session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");
    await clearSession({ store: memory });
    expect(state.session).toBeUndefined();
    await saveSession(
      { slug: "e", container_id: 3, token: fixtureSecrets().sessionToken },
      { store: memory, clock: fakeClock("2026-10-15T00:00:00Z") },
    );
    expect(state.session?.signed_in_at).toBe("2026-10-15T00:00:00Z");
  });
});

describe("[CAP-CFG] resolveSessionToken() with a plain token", () => {
  it("returns the token and registers it with the live-secret registry", async () => {
    const token = fixtureSecrets().sessionToken;
    await expect(resolveSessionToken(sessionConfig(token))).resolves.toBe(token);
    expect(redactString(`x ${token} y`)).toBe(`x ${REDACTED} y`);
  });

  it("refuses with the no-session kind when there is no session", async () => {
    const error: unknown = await resolveSessionToken(emptyConfig()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NoSessionError);
    const noSession = error as NoSessionError;
    expect(noSession.kind).toBe("no-session");
    expect(noSession.message).toBe("no session");
    expect(noSession.hint).toContain("gripeventsctl auth signin");
  });
});
