// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The temporary-home guard: this file runs under `@gripeventsctl/testing/setup` like every other,
 * so the first cases read the state the guard set; the spawned case runs an inner Vitest over the
 * built `dist/setup.js` with a test that points `GRIPEVENTSCTL_CONFIG_FILE` outside its home, and
 * reads the failure the guard raised and the removal of the directory afterwards.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardMessage, isInside, outsideTempHome } from "../setup-guard.js";

const SETUP = fileURLToPath(new URL("../../dist/setup.js", import.meta.url));
const require = createRequire(import.meta.url);
const VITEST_CLI = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

describe("[CAP-TEST-TOOLING] the temporary-home guard", () => {
  it("points HOME, USERPROFILE and GRIPEVENTSCTL_CONFIG_FILE inside a fresh directory under os.tmpdir()", () => {
    const home = process.env["HOME"] ?? "";
    expect(isInside(home, tmpdir())).toBe(true);
    expect(home).not.toBe(tmpdir());
    expect(existsSync(home)).toBe(true);
    expect(process.env["USERPROFILE"]).toBe(home);
    expect(process.env["GRIPEVENTSCTL_CONFIG_FILE"]).toBe(join(home, ".gripeventsctl.yaml"));
  });

  it("names the variable that points outside, and the derived paths", () => {
    const root = join(tmpdir(), "gripeventsctl-guard-root");
    const inside = { HOME: root, USERPROFILE: root, GRIPEVENTSCTL_CONFIG_FILE: join(root, ".gripeventsctl.yaml") };
    expect(outsideTempHome(inside, root)).toEqual([]);

    const elsewhere = join(tmpdir(), "elsewhere", ".gripeventsctl.yaml");
    const problems = outsideTempHome({ ...inside, GRIPEVENTSCTL_CONFIG_FILE: elsewhere }, root);
    expect(problems[0]).toBe(`GRIPEVENTSCTL_CONFIG_FILE points outside the temporary home: ${elsewhere}`);
    expect(problems.some((line) => line.startsWith("the send log derived from GRIPEVENTSCTL_CONFIG_FILE"))).toBe(true);
    expect(outsideTempHome({ ...inside, HOME: undefined }, root)).toEqual(["HOME is unset"]);
    expect(outsideTempHome({ ...inside, USERPROFILE: "" }, root)).toEqual(["USERPROFILE is unset"]);
    const sendLog = join(tmpdir(), "elsewhere", "send-log.jsonl");
    expect(outsideTempHome(inside, root, sendLog)).toEqual([
      `writes.send_log of the config at GRIPEVENTSCTL_CONFIG_FILE points outside the temporary home: ${sendLog}`,
    ]);
    expect(guardMessage(root, problems)).toContain("GRIPEVENTSCTL_CONFIG_FILE points outside the temporary home");
  });
});

describe("[CAP-TEST-TOOLING] the guard under an inner Vitest run", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gripeventsctl-guard-inner-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runInner(testBody: string): { status: number | null; output: string } {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "inner.test.ts"), `import { it } from "vitest";\n${testBody}\n`, "utf8");
    writeFileSync(
      join(dir, "vitest.config.mjs"),
      `export default { test: { include: ["src/**/*.test.ts"], setupFiles: [${JSON.stringify(SETUP)}], pool: "forks" } };\n`,
      "utf8",
    );
    const run = spawnSync(
      process.execPath,
      [VITEST_CLI, "run", "--root", dir, "--config", join(dir, "vitest.config.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
        timeout: 60_000,
      },
    );
    if (run.error !== undefined) throw run.error;
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
  }

  it("fails a test that points GRIPEVENTSCTL_CONFIG_FILE outside the temporary home, naming the variable, and removes the directory after the file", () => {
    const marker = join(dir, "home-was");
    const result = runInner(
      `it("escapes", () => {\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env.HOME, "utf8");\n` +
        `  process.env.GRIPEVENTSCTL_CONFIG_FILE = require("node:path").join(${JSON.stringify(dir)}, "outside.yaml");\n` +
        `});`,
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("GRIPEVENTSCTL_CONFIG_FILE points outside the temporary home");
    const home = require("node:fs").readFileSync(marker, "utf8") as string;
    expect(isInside(home, tmpdir())).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  it("passes a test that leaves the variables alone", () => {
    const result = runInner(`it("stays", () => {});`);
    expect(result.status, result.output).toBe(0);
  });
});
