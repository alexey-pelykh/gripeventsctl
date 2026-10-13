// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import * as fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type TempHome, fixtureSecrets, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it, vi } from "vitest";

import { type Config, emptyConfig } from "../config/schema.js";
import { CONFIG_FILE_MODE, type StoreFs, loadConfig, saveConfig } from "../config/store.js";
import { ConfigError } from "../transport/errors.js";

const POSIX = process.platform !== "win32";
const POSIX_ONLY = " (POSIX only: file modes)";

function sessionConfig(token = fixtureSecrets().sessionToken): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T19:09:00Z" },
    writes: { enabled: false },
  };
}

const CONFIG_YAML = (token: string): string =>
  [
    "version: 1",
    "session:",
    "  slug: testevent1",
    "  container_id: 1",
    `  token: ${token}`,
    "  signed_in_at: 2026-10-12T19:09:00Z",
    "",
  ].join("\n");

/** The real file system behind recording spies, so a test sees every call the store makes. */
function spiedFs(): StoreFs & { calls: string[] } {
  const calls: string[] = [];
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push(name);
      return fn(...args);
    };
  return {
    calls,
    lstat: record("lstat", (path: string) => fs.lstat(path)),
    readFile: record("readFile", (path: string, encoding: "utf8") => fs.readFile(path, encoding)),
    mkdir: record("mkdir", (path: string, options: { recursive: true }) => fs.mkdir(path, options)),
    open: record("open", (path: string, flags: "wx", mode: number) => fs.open(path, flags, mode)),
    rename: record("rename", (from: string, to: string) => fs.rename(from, to)),
    unlink: record("unlink", (path: string) => fs.unlink(path)),
  };
}

async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

describe("[CAP-CFG] loadConfig()", () => {
  it("returns the empty config with exists: false when no file is at the path", async () => {
    await withTempHome(async (home) => {
      const result = await loadConfig({ env: home.env });
      expect(result).toEqual({ config: emptyConfig(), path: home.configFile, exists: false, modeEnforced: POSIX });
      expect(result.config.session).toBeUndefined();
    });
  });

  it("ignores a config file in the current working directory", async () => {
    await withTempHome(async (home) => {
      const cwd = await mkdtemp(join(tmpdir(), "gripeventsctl-cwd-"));
      const previous = process.cwd();
      try {
        // Invalid YAML: reading it would fail loudly.
        await writeFile(join(cwd, ".gripeventsctl.yaml"), "version: [1\n", { mode: 0o600 });
        process.chdir(cwd);
        const env = { ...home.env };
        delete env["GRIPEVENTSCTL_CONFIG_FILE"];
        const spy = spiedFs();
        const result = await loadConfig({ env, fs: spy });
        expect(result.exists).toBe(false);
        expect(result.config.session).toBeUndefined();
        expect(result.path).toBe(join(home.dir, ".gripeventsctl.yaml"));
        expect(spy.calls).toEqual(["lstat"]);
      } finally {
        process.chdir(previous);
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it.skipIf(!POSIX)(`refuses a file other users can read, before the token is read${POSIX_ONLY}`, async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, CONFIG_YAML(fixtureSecrets().sessionToken), { mode: 0o644 });
      const spy = spiedFs();
      const error = await expectConfigError(loadConfig({ env: home.env, fs: spy }));
      expect(error.kind).toBe("config");
      expect(error.hint).toBe(`chmod 600 ${home.configFile}`);
      expect(error.message).toContain(home.configFile);
      expect(error.message).toContain("0644");
      expect(spy.calls).toEqual(["lstat"]);
    });
  });

  it.skipIf(!POSIX)(`refuses group-readable and accepts owner-only modes${POSIX_ONLY}`, async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, CONFIG_YAML(fixtureSecrets().sessionToken), { mode: 0o640 });
      await expectConfigError(loadConfig({ env: home.env }));
      await fs.chmod(home.configFile, 0o600);
      expect((await loadConfig({ env: home.env })).exists).toBe(true);
      await fs.chmod(home.configFile, 0o400);
      expect((await loadConfig({ env: home.env })).exists).toBe(true);
    });
  });

  it("does not check the mode on Windows and reports modeEnforced: false", async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      await writeFile(home.configFile, CONFIG_YAML(token), { mode: 0o644 });
      const result = await loadConfig({ env: home.env, platform: "win32" });
      expect(result.modeEnforced).toBe(false);
      expect(result.exists).toBe(true);
      expect(result.config.session?.token).toBe(token);
    });
  });

  it("refuses a file that is not valid YAML with the config kind, naming the path", async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, "version: [1\n", { mode: 0o600 });
      const error = await expectConfigError(loadConfig({ env: home.env }));
      expect(error.kind).toBe("config");
      expect(error.message).toContain(`cannot parse config file ${home.configFile}`);
    });
  });

  it("refuses a file that fails the schema, naming the path and the key", async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, "version: 1\nsessions: {}\n", { mode: 0o600 });
      const error = await expectConfigError(loadConfig({ env: home.env }));
      expect(error.kind).toBe("config");
      expect(error.message).toContain(home.configFile);
      expect(error.message).toContain('unknown key "sessions"');
    });
  });

  it("returns the parsed config, the resolved path and exists: true, and never resolves an op:// reference", async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, CONFIG_YAML("op://Vault/Item/token"), { mode: 0o600 });
      const result = await loadConfig({ env: home.env });
      expect(result.exists).toBe(true);
      expect(result.path).toBe(home.configFile);
      expect(result.config.session?.token).toBe("op://Vault/Item/token");
    });
  });
});

describe("[CAP-CFG] saveConfig()", () => {
  async function temporaryFiles(home: TempHome): Promise<string[]> {
    return (await readdir(home.dir)).filter((name) => name.endsWith(".tmp"));
  }

  it("writes a file that loads back as the same config", async () => {
    await withTempHome(async (home) => {
      const config = sessionConfig();
      await saveConfig(config, { env: home.env });
      expect((await loadConfig({ env: home.env })).config).toEqual(config);
      expect(await temporaryFiles(home)).toEqual([]);
      expect(await readFile(home.configFile, "utf8")).toContain("version: 1\n");
    });
  });

  it.skipIf(!POSIX)(
    `leaves the file at mode 0600, created exclusively at that mode before any write${POSIX_ONLY}`,
    async () => {
      await withTempHome(async (home) => {
        const spy = spiedFs();
        const open = vi.fn(spy.open);
        await saveConfig(sessionConfig(), { env: home.env, fs: { ...spy, open } });
        expect((await stat(home.configFile)).mode & 0o777).toBe(CONFIG_FILE_MODE);
        expect(open).toHaveBeenCalledTimes(1);
        const [temporary, flags, mode] = open.mock.calls[0] ?? [];
        expect(temporary).toMatch(
          new RegExp(`^${home.configFile.replaceAll("\\", "\\\\").replaceAll(".", "\\.")}\\.[0-9a-f]{12}\\.tmp$`),
        );
        expect(flags).toBe("wx");
        expect(mode).toBe(0o600);
        // The exclusive create comes before the rename that publishes the file; no chmod is involved.
        expect(spy.calls.indexOf("open")).toBeLessThan(spy.calls.indexOf("rename"));
        expect(spy.calls).not.toContain("chmod");
      });
    },
  );

  it("rewrites an existing file at mode 0600 whatever mode it had", async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, "version: 1\n", { mode: 0o600 });
      const config = sessionConfig();
      await saveConfig(config, { env: home.env });
      expect((await loadConfig({ env: home.env })).config).toEqual(config);
      if (POSIX) expect((await stat(home.configFile)).mode & 0o777).toBe(0o600);
    });
  });

  it("refuses an invalid config before writing anything", async () => {
    await withTempHome(async (home) => {
      const spy = spiedFs();
      const invalid = { version: 1, writes: { enabled: false }, extra: 1 } as unknown as Config;
      const error = await expectConfigError(saveConfig(invalid, { env: home.env, fs: spy }));
      expect(error.message).toContain('unknown key "extra"');
      expect(spy.calls).toEqual([]);
      expect(await readdir(home.dir)).toEqual([]);
    });
  });

  it("leaves the original byte-identical and no temporary file when the rename fails", async () => {
    await withTempHome(async (home) => {
      const original = sessionConfig();
      await saveConfig(original, { env: home.env });
      const before = await readFile(home.configFile);
      const spy = spiedFs();
      const failing: StoreFs = { ...spy, rename: () => Promise.reject(new Error("injected rename failure")) };
      const error = await expectConfigError(saveConfig(sessionConfig(), { env: home.env, fs: failing }));
      expect(error.kind).toBe("config");
      expect(error.message).toContain("injected rename failure");
      expect(await readFile(home.configFile)).toEqual(before);
      expect(await temporaryFiles(home)).toEqual([]);
    });
  });

  it("leaves the original byte-identical and no temporary file when fsync fails", async () => {
    await withTempHome(async (home) => {
      const original = sessionConfig();
      await saveConfig(original, { env: home.env });
      const before = await readFile(home.configFile);
      const spy = spiedFs();
      const failing: StoreFs = {
        ...spy,
        open: async (path, flags, mode) => {
          const handle = await spy.open(path, flags, mode);
          return {
            ...handle,
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
            sync: () => Promise.reject(new Error("injected fsync failure")),
            close: () => handle.close(),
          };
        },
      };
      await expectConfigError(saveConfig(sessionConfig(), { env: home.env, fs: failing }));
      expect(await readFile(home.configFile)).toEqual(before);
      expect(await temporaryFiles(home)).toEqual([]);
    });
  });

  it("refuses with the config kind and the lock file in the hint when the lock cannot be taken", async () => {
    await withTempHome(async (home) => {
      const locked = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
      const error = await expectConfigError(
        saveConfig(sessionConfig(), { env: home.env, lock: () => Promise.reject(locked) }),
      );
      expect(error.kind).toBe("config");
      expect(error.hint).toContain(`${home.configFile}.lock`);
      expect(await readdir(home.dir)).toEqual([]);
    });
  });

  it("creates the directory of a config path that does not exist yet", async () => {
    await withTempHome(async (home) => {
      const env = { ...home.env, GRIPEVENTSCTL_CONFIG_FILE: join(home.dir, "nested", "deeper", "config.yaml") };
      const config = sessionConfig();
      await saveConfig(config, { env });
      expect((await loadConfig({ env })).config).toEqual(config);
    });
  });
});
