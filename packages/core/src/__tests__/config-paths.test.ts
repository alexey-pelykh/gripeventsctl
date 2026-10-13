// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { guardedPaths } from "@gripeventsctl/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_FILE_ENV, configPath, derivedPaths, insideGitWorkTree, workTreeWarnings } from "../config/paths.js";
import { type Config, emptyConfig } from "../config/schema.js";

const HOME_NAME = process.platform === "win32" ? "USERPROFILE" : "HOME";

describe("[CAP-CFG] the config path and the paths derived from it", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gripeventsctl-paths-"));
    // The work-tree cases below need a temporary directory that is not itself inside a checkout.
    expect(insideGitWorkTree(dir), `os.tmpdir() (${tmpdir()}) must not lie inside a git work tree`).toBe(false);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns GRIPEVENTSCTL_CONFIG_FILE when it is set", () => {
    const file = join(dir, "elsewhere", "config.yaml");
    expect(configPath({ [CONFIG_FILE_ENV]: file, [HOME_NAME]: dir })).toBe(file);
  });

  it("returns <HOME>/.gripeventsctl.yaml when the variable is unset or empty", () => {
    expect(configPath({ [HOME_NAME]: dir })).toBe(join(dir, ".gripeventsctl.yaml"));
    expect(configPath({ [HOME_NAME]: dir, [CONFIG_FILE_ENV]: "" })).toBe(join(dir, ".gripeventsctl.yaml"));
  });

  it("never looks in the current working directory", () => {
    const cwd = process.cwd();
    for (const env of [{ [HOME_NAME]: dir }, { [HOME_NAME]: dir, [CONFIG_FILE_ENV]: join(dir, "c.yaml") }]) {
      const path = configPath(env);
      expect(dirname(path)).not.toBe(cwd);
      expect(path.startsWith(cwd + sep)).toBe(false);
    }
  });

  it("agrees with the path rule the test guard of @gripeventsctl/testing restates", () => {
    for (const env of [
      { [HOME_NAME]: dir },
      { [HOME_NAME]: dir, [CONFIG_FILE_ENV]: join(dir, "elsewhere", "c.yaml") },
      { [HOME_NAME]: dir, [CONFIG_FILE_ENV]: join("relative", "c.yaml") },
    ]) {
      const path = configPath(env);
      expect(guardedPaths(env)).toEqual({ config: path, ...derivedPaths(path, emptyConfig()) });
    }
  });

  it("derives the send log, the go-ahead journal and the write lock from the config path's prefix", () => {
    expect(derivedPaths("/x/.gripeventsctl.yaml", emptyConfig())).toEqual({
      sendLog: "/x/.gripeventsctl.send-log.jsonl",
      goAheads: "/x/.gripeventsctl.go-aheads.jsonl",
      writeLock: "/x/.gripeventsctl.write.lock",
    });
  });

  it("uses the whole path as the prefix where it does not end in .yaml", () => {
    expect(derivedPaths("/x/config", emptyConfig()).sendLog).toBe("/x/config.send-log.jsonl");
  });

  it("lets writes.send_log name another send log file", () => {
    const config: Config = { version: 1, writes: { enabled: false, send_log: "/y/log.jsonl" } };
    const paths = derivedPaths("/x/.gripeventsctl.yaml", config);
    expect(paths.sendLog).toBe("/y/log.jsonl");
    expect(paths.goAheads).toBe("/x/.gripeventsctl.go-aheads.jsonl");
    expect(paths.writeLock).toBe("/x/.gripeventsctl.write.lock");
  });

  it("detects a .git directory or file in any ancestor directory", async () => {
    const tree = join(dir, "tree");
    await mkdir(join(tree, "nested", "deeper"), { recursive: true });
    expect(insideGitWorkTree(join(tree, "nested", "deeper", ".gripeventsctl.yaml"))).toBe(false);
    await writeFile(join(tree, ".git"), "gitdir: ../somewhere/.git\n");
    expect(insideGitWorkTree(join(tree, "nested", "deeper", ".gripeventsctl.yaml"))).toBe(true);
    await rm(join(tree, ".git"));
    await mkdir(join(tree, "nested", ".git"));
    expect(insideGitWorkTree(join(tree, "nested", "deeper", ".gripeventsctl.yaml"))).toBe(true);
    expect(insideGitWorkTree(join(tree, ".gripeventsctl.yaml"))).toBe(false);
  });

  it("warns for the config path and the derived paths inside a work tree, and for nothing outside one", async () => {
    const tree = join(dir, "repo");
    await mkdir(join(tree, ".git"), { recursive: true });
    const inside = join(tree, ".gripeventsctl.yaml");
    const warnings = workTreeWarnings(emptyConfig(), inside);
    expect(warnings).toContain(inside);
    expect(warnings).toEqual([inside, ...Object.values(derivedPaths(inside, emptyConfig()))]);
    expect(workTreeWarnings(emptyConfig(), join(dir, ".gripeventsctl.yaml"))).toEqual([]);
  });

  it("warns for a writes.send_log inside a work tree even when the config is outside", async () => {
    const tree = join(dir, "repo");
    await mkdir(join(tree, ".git"), { recursive: true });
    const sendLog = join(tree, "send-log.jsonl");
    const config: Config = { version: 1, writes: { enabled: false, send_log: sendLog } };
    expect(workTreeWarnings(config, join(dir, ".gripeventsctl.yaml"))).toEqual([sendLog]);
  });
});
