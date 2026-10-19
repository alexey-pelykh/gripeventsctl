// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-EXPORT-FILE: `openExportFile()` at the component level (issue #11 § `attendees dump`, the export file), the
 * cases the pre-authored oracle (`export-file.oracle.test.ts`) leaves to the implementer: the flags of the exclusive
 * create (`wx`, `0o600`) seen by a spy on `fs.open`; a file that appears between the `lstat` and the open, refused by
 * the `wx` flag with nothing appended; the CLI's relative path resolved against the working directory and the MCP
 * refusal of the same path; the tool-file rule holding through a symbolic-link parent (the macOS `/var` case); the
 * work-tree rule on both surfaces, for a `.git` directory and a `.git` file; the parent that is a file; and the hint
 * and message of every refusal naming the rule and the path.
 */

import { type FileHandle, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";

import { type TempHome, fakeClock, fixtureSecrets, mockGrip, stderrSink, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it, vi } from "vitest";

import {
  type Config,
  GripClient,
  type OperationContext,
  UsageError,
  derivedPaths,
  loadConfig,
  saveConfig,
} from "../index.js";
import {
  ABSOLUTE_PATH_MESSAGE,
  EXPORT_FILE_MODE,
  EXPORT_FILE_SUFFIX,
  alreadyExistsMessage,
  openExportFile,
  ownFiles,
  resolveExportPath,
  workTreeRefusal,
  workTreeWarning,
} from "../operations/attendees/export-file.js";

const POSIX = process.platform !== "win32";

/** Every call of `fs.open` the subject makes, and a switch that makes `lstat` deny the next target once. */
const spy = vi.hoisted(() => ({
  opens: [] as unknown[][],
  denyLstatOnce: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
      spy.opens.push(args);
      return actual.open(...args);
    },
    lstat: (...args: Parameters<typeof actual.lstat>): ReturnType<typeof actual.lstat> => {
      if (spy.denyLstatOnce !== undefined && args[0] === spy.denyLstatOnce) {
        spy.denyLstatOnce = undefined;
        const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        return Promise.reject(error);
      }
      return actual.lstat(...args);
    },
  };
});

const agent = mockGrip();

function sessionConfig(token: string): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T11:00:00Z" },
    writes: { enabled: false },
  };
}

async function contextOf(
  home: TempHome,
  source: "cli" | "mcp" = "cli",
): Promise<OperationContext & { stderrText(): string }> {
  const clock = fakeClock();
  const stderr = stderrSink();
  return {
    client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr: stderr.stream }),
    config: await loadConfig({ env: home.env }),
    clock,
    stderr: stderr.stream,
    source,
    stderrText: () => stderr.text(),
  };
}

async function withSession<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await saveConfig(sessionConfig(fixtureSecrets().sessionToken), { env: home.env });
    return fn(home);
  });
}

async function refusal(out: string, ctx: OperationContext): Promise<UsageError> {
  let handle: FileHandle | undefined;
  try {
    handle = await openExportFile(out, ctx);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  } finally {
    await handle?.close();
  }
  throw new Error(`openExportFile(${out}) did not refuse`);
}

async function missing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

describe("[CAP-EXPORT-FILE] openExportFile: the exclusive create at 0600, the path rules on both surfaces, and the work-tree rule", () => {
  it("creates the file with fs.open(out, 'wx', 0o600) and nothing else, and returns a writable handle", async () => {
    await withSession(async (home) => {
      const out = path.join(home.dir, "export.jsonl");
      spy.opens.length = 0;
      const handle = await openExportFile(out, await contextOf(home));
      try {
        expect(spy.opens).toEqual([[out, "wx", 0o600]]);
        expect(EXPORT_FILE_MODE).toBe(0o600);
        expect(EXPORT_FILE_SUFFIX).toBe(".jsonl");
        await handle.write('{"id":1}\n');
      } finally {
        await handle.close();
      }
      expect(await readFile(out, "utf8")).toBe('{"id":1}\n');
      if (POSIX) expect((await stat(out)).mode & 0o777).toBe(0o600);
    });
  });

  it("a file that appears between the check and the open is refused by the wx flag with the usage kind, and keeps its bytes", async () => {
    await withSession(async (home) => {
      const out = path.join(home.dir, "export.jsonl");
      await writeFile(out, "keep me\n");
      // The check sees nothing at the path (the file lands after it), so the exclusive create is what refuses.
      spy.denyLstatOnce = out;
      spy.opens.length = 0;
      const error = await refusal(out, await contextOf(home));
      expect(spy.denyLstatOnce).toBeUndefined();
      expect(spy.opens).toEqual([[out, "wx", 0o600]]);
      expect(error.message).toBe(alreadyExistsMessage(out));
      expect(error.message).toContain("already exists");
      expect(await readFile(out, "utf8")).toBe("keep me\n");
    });
  });

  it("on the CLI a relative out resolves against the working directory and the file is created there; on MCP the same path is refused as not absolute", async () => {
    await withSession(async (home) => {
      const cwd = process.cwd();
      process.chdir(home.dir);
      try {
        await mkdir(path.join(home.dir, "relative"));
        const out = path.join("relative", "export.jsonl");
        // `process.cwd()` after the change is the real path of the home (macOS resolves `/var` to `/private/var`).
        const resolved = path.join(process.cwd(), "relative", "export.jsonl");
        expect(resolveExportPath(out, { source: "cli" })).toBe(resolved);
        expect(path.isAbsolute(resolved)).toBe(true);
        expect(resolveExportPath(out, { source: "mcp" })).toBe(out);
        const handle = await openExportFile(out, await contextOf(home, "cli"));
        await handle.close();
        expect(await missing(path.join(home.dir, "relative", "export.jsonl"))).toBe(false);

        const error = await refusal(out, await contextOf(home, "mcp"));
        expect(error.message).toBe(`${ABSOLUTE_PATH_MESSAGE}: ${out}`);
        expect(error.message).toContain("must be an absolute path");
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it("a path not ending in .jsonl is refused naming the suffix rule and the path, before any file-system check", async () => {
    await withSession(async (home) => {
      const out = path.join(home.dir, "absent", "export.json");
      const error = await refusal(out, await contextOf(home));
      expect(error.message).toBe(`out must end in .jsonl: ${out}`);
      expect(error.hint).toBe("name a .jsonl file");
    });
  });

  it("the tool's own files are refused naming the rule and the path, each of the four, and the list is the config path plus derivedPaths()", async () => {
    await withSession(async (home) => {
      const ctx = await contextOf(home);
      const derived = derivedPaths(home.configFile, ctx.config.config);
      expect(ownFiles(ctx)).toEqual([home.configFile, derived.sendLog, derived.goAheads, derived.writeLock]);
      for (const own of [derived.sendLog, derived.goAheads]) {
        const error = await refusal(own, ctx);
        expect(error.message, own).toContain(own);
        expect(error.message, own).toContain("tool's own files");
        expect(error.hint, own).toContain("send log");
      }
      // The config file and the write lock do not end in .jsonl, so the suffix rule refuses them first, naming the
      // path all the same.
      for (const own of [home.configFile, derived.writeLock]) {
        const error = await refusal(own, ctx);
        expect(error.message, own).toBe(`out must end in .jsonl: ${own}`);
      }
    });
  });

  it.skipIf(!POSIX)(
    "the tool-file rule holds when the config path is reached through a symbolic-link parent: the same file under another spelling is refused (POSIX only: symlinks)",
    async () => {
      await withTempHome(async (home) => {
        const real = path.join(home.dir, "real");
        await mkdir(real);
        const link = path.join(home.dir, "link");
        await symlink(real, link);
        const configFile = path.join(real, ".gripeventsctl.yaml");
        const env = { ...home.env, GRIPEVENTSCTL_CONFIG_FILE: configFile };
        await saveConfig(sessionConfig(fixtureSecrets().sessionToken), { env });
        const ctx = await contextOf({ ...home, env, configFile });
        expect(ctx.config.path).toBe(configFile);
        const derived = derivedPaths(configFile, ctx.config.config);
        expect(derived.sendLog).toBe(path.join(real, ".gripeventsctl.send-log.jsonl"));
        // The send log and the go-ahead journal, spelled through the link, are the same files as the derived paths.
        for (const name of [".gripeventsctl.send-log.jsonl", ".gripeventsctl.go-aheads.jsonl"]) {
          const spelled = path.join(link, name);
          const error = await refusal(spelled, ctx);
          expect(error.message, spelled).toContain("tool's own files");
          expect(error.message, spelled).toContain(spelled);
          expect(await missing(path.join(real, name)), spelled).toBe(true);
        }
        // A sibling spelled through the link passes the tool-file rule and meets the next one: its parent is a link.
        const sibling = await refusal(path.join(link, "export.jsonl"), ctx);
        expect(sibling.message).toBe(
          `the parent directory of out is a symbolic link: ${path.join(link, "export.jsonl")}`,
        );
        const handle = await openExportFile(path.join(real, "export.jsonl"), ctx);
        await handle.close();
        expect(await missing(path.join(real, "export.jsonl"))).toBe(false);
      });
    },
  );

  it("a parent that is a file, and a parent that does not exist, are refused naming the parent rule and the path", async () => {
    await withSession(async (home) => {
      const ctx = await contextOf(home);
      const file = path.join(home.dir, "a-file");
      await writeFile(file, "");
      const under = path.join(file, "export.jsonl");
      expect((await refusal(under, ctx)).message).toBe(`the parent of out is not a directory: ${under}`);
      const absent = path.join(home.dir, "absent", "export.jsonl");
      const error = await refusal(absent, ctx);
      expect(error.message).toBe(`the parent directory of out does not exist (ENOENT): ${absent}`);
      expect(error.hint).toBe("create the directory first");
      expect(await missing(path.dirname(absent))).toBe(true);
    });
  });

  it.each([["directory"], ["file"]] as const)(
    "an out whose parent is inside a git work tree (.git %s): the CLI warns once on stderr and creates the file; MCP refuses with the usage kind and creates nothing",
    async (marker) => {
      await withSession(async (home) => {
        const repo = path.join(home.dir, "repo");
        await mkdir(repo);
        if (marker === "directory") await mkdir(path.join(repo, ".git"));
        else await writeFile(path.join(repo, ".git"), "gitdir: ../elsewhere/.git\n");
        const out = path.join(repo, "export.jsonl");

        const mcp = await contextOf(home, "mcp");
        const error = await refusal(out, mcp);
        expect(error.message).toBe(workTreeRefusal(out));
        expect(error.message).toContain("inside a git work tree; choose a path outside any repository");
        expect(await missing(out)).toBe(true);
        expect(mcp.stderrText()).toBe("");

        const cli = await contextOf(home, "cli");
        const handle = await openExportFile(out, cli);
        await handle.close();
        expect(cli.stderrText()).toBe(`${workTreeWarning(out)}\n`);
        expect(workTreeWarning(out)).toBe(`${out} is inside a git work tree; do not commit it`);
        expect(await missing(out)).toBe(false);
        expect(await readdir(repo)).toEqual([".git", "export.jsonl"]);
      });
    },
  );

  it("an out outside any work tree writes no warning on either surface", async () => {
    await withSession(async (home) => {
      const cli = await contextOf(home, "cli");
      const handle = await openExportFile(path.join(home.dir, "export.jsonl"), cli);
      await handle.close();
      expect(cli.stderrText()).toBe("");
    });
  });

  it("every refusal is the usage kind with a non-empty hint, and none creates the file", async () => {
    await withSession(async (home) => {
      const ctx = await contextOf(home);
      await writeFile(path.join(home.dir, "existing.jsonl"), "");
      const cases = [
        path.join(home.dir, "existing.jsonl"),
        path.join(home.dir, "export.txt"),
        home.configFile,
        path.join(home.dir, "absent", "export.jsonl"),
      ];
      for (const out of cases) {
        const error = await refusal(out, ctx);
        expect(error.kind, out).toBe("usage");
        expect(error.hint, out).not.toBe("");
        expect(error.message, out).toContain(out);
      }
      expect((await readdir(home.dir)).sort()).toEqual([".gripeventsctl.yaml", "existing.jsonl"]);
    });
  });

  it("the stderr seam is the context's stream: the warning goes nowhere else", async () => {
    await withSession(async (home) => {
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      });
      const repo = path.join(home.dir, "repo");
      await mkdir(path.join(repo, ".git"), { recursive: true });
      const ctx: OperationContext = { ...(await contextOf(home)), stderr: stream };
      const out = path.join(repo, "export.jsonl");
      const handle = await openExportFile(out, ctx);
      await handle.close();
      expect(chunks).toEqual([`${out} is inside a git work tree; do not commit it\n`]);
    });
  });
});
