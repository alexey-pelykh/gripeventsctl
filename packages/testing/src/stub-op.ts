// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * A stub 1Password CLI for the tests: a POSIX shell script named `op`, on a temporary directory
 * prepended to `PATH`, that records each call (argv, stdin, environment) and answers from the
 * fragment the test supplies.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** One recorded invocation of the stub `op`. */
export interface OpCall {
  /** The arguments after the program name. */
  argv: string[];
  /** Everything the caller wrote to stdin. */
  stdin: string;
  /** The environment the child saw. */
  env: Record<string, string>;
}

export interface OpStub {
  /** The temporary directory holding `bin/op` and the recordings. */
  dir: string;
  /** The directory prepended to `PATH`. */
  binDir: string;
  /** The `PATH` value with `binDir` in front, as `process.env.PATH` now holds it. */
  path: string;
  /** The recorded calls, in order. */
  calls(): Promise<OpCall[]>;
  /** Put `PATH` back and remove the directory. */
  remove(): Promise<void>;
}

/** True where a POSIX shell script on `PATH` is a reliable stub: not on Windows. */
export const STUB_OP_SUPPORTED = process.platform !== "win32";

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

/**
 * Write a POSIX shell script named `op` into a temporary directory prepended to `PATH`. Each call
 * records its argv, its stdin and its environment, then runs `script` (a shell fragment with the
 * original arguments in `$@`) to answer. POSIX only: the `.cmd` spawn rules make a stub
 * unreliable on Windows, so a test skips there with the reason in its name.
 */
export async function stubOp(script: string): Promise<OpStub> {
  if (!STUB_OP_SUPPORTED) throw new Error("stubOp() needs a POSIX shell; skip the test on Windows");
  const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-stub-op-"));
  const binDir = join(dir, "bin");
  const recordDir = join(dir, "calls");
  await mkdir(binDir);
  await mkdir(recordDir);
  const program = join(binDir, "op");
  const body = [
    "#!/bin/sh",
    "# Stub 1Password CLI written by @gripeventsctl/testing stubOp(): records the call, then answers.",
    `record='${recordDir.replaceAll("'", "'\\''")}'`,
    "i=0",
    'while [ -e "$record/$i.argv" ]; do i=$((i + 1)); done',
    'for arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$record/$i.argv"',
    'cat > "$record/$i.stdin"',
    'env > "$record/$i.env"',
    "# --- the test's answer ---",
    script,
    "",
  ].join("\n");
  await writeFile(program, body, "utf8");
  await chmod(program, 0o755);

  const previousPath = process.env["PATH"];
  const path = previousPath === undefined || previousPath === "" ? binDir : `${binDir}${delimiter}${previousPath}`;
  process.env["PATH"] = path;

  return {
    dir,
    binDir,
    path,
    async calls() {
      const indexes = (await readdir(recordDir))
        .filter((name) => name.endsWith(".argv"))
        .map((name) => Number(name.slice(0, -".argv".length)))
        .sort((a, b) => a - b);
      const calls: OpCall[] = [];
      for (const index of indexes) {
        const argvText = await readFile(join(recordDir, `${String(index)}.argv`), "utf8");
        const argv = argvText === "" ? [] : argvText.split("\0").slice(0, -1);
        const stdin = await readFile(join(recordDir, `${String(index)}.stdin`), "utf8");
        const env = parseEnv(await readFile(join(recordDir, `${String(index)}.env`), "utf8"));
        calls.push({ argv, stdin, env });
      }
      return calls;
    },
    async remove() {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env["PATH"] = previousPath;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
