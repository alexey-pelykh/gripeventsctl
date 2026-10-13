// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Repository-gate cases for `scripts/check-secret-leakage.ts` (CAP-REDACT R15 to R19). The script
 * runs `main()` at import and scans the tracked files of the current working directory, so every
 * case spawns it as a process with `cwd` set to a temporary git repository holding committed
 * fixture secrets. The secret values are generated per run; none is a literal in this file.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../check-secret-leakage.ts", import.meta.url));
const require = createRequire(import.meta.url);
const TSX_CLI = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

interface Secrets {
  sessionToken: string;
  chatToken: string;
  applicationToken: string;
  basic: string;
  /** The shape of the platform's public bootstrap bearer (32 letters and digits), never its value. */
  bootstrapBearer: string;
}

const BEARER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A per-run 32-character value of letters and digits: the shape of the public bootstrap bearer
 * `docs/api/containers.md` prints, so the case keeps proving that a bare `Bearer <value>` line is
 * unflagged by the lint, without committing the platform's real value. Never JWT-shaped.
 */
function syntheticBearer(): string {
  const value = Array.from(randomBytes(32), (byte) => BEARER_ALPHABET.charAt(byte % BEARER_ALPHABET.length)).join("");
  return value.startsWith("eyJ") ? `A${value.slice(1)}` : value;
}

function fixtureSecrets(): Secrets {
  const segment = (bytes: number): string => randomBytes(bytes).toString("base64url");
  return {
    sessionToken: randomUUID(),
    chatToken: `eyJ${segment(24)}.${segment(60)}.${segment(32)}`,
    applicationToken: randomBytes(16).toString("hex"),
    basic: Buffer.from(`test.person.1@example.com:${segment(18)}`, "utf8").toString("base64"),
    bootstrapBearer: syntheticBearer(),
  };
}

/** Every secret shape the lint patterns cover, one file each, named after the shape. */
function shapedFiles(secrets: Secrets): Record<string, string> {
  return {
    "user-token-key.txt": `{"user_token": "${secrets.sessionToken}"}\n`,
    "x-authorization-header.txt": `X-Authorization: ${secrets.sessionToken}\n`,
    "jwt.txt": `token=${secrets.chatToken}\n`,
    "login-authorization.txt": `Authorization: Bearer ${secrets.applicationToken}, Basic ${secrets.basic}\n`,
    "basic-alone.txt": `Authorization: Basic ${secrets.basic}\n`,
    "general-token-json.txt": `{"application": {"general": {"application_id": 1, "token": "${secrets.applicationToken}"}}}\n`,
    "general-token-dotted.txt": `general.token: ${secrets.applicationToken}\n`,
  };
}

/**
 * The forms the `docs/api/` pages print, none a secret: the lint leaves each alone. The bare `Bearer`
 * line stands for the public bootstrap bearer `docs/api/containers.md` prints (a runtime-only shape);
 * its value here is the per-run synthetic one.
 */
function placeholders(bootstrapBearer: string): string[] {
  return [
    "X-Authorization: <user_token>",
    '-H "X-Authorization: $GRIPEVENTSCTL_TOKEN"',
    '"user_token": "<session token: a 36-character UUID>"',
    '"Token": "<AWS Cognito token: a JWT about 1,000 characters long>"',
    "Authorization: Bearer <application_token>, Basic <base64(email:password)>",
    'Authorization: Bearer $GRIPEVENTSCTL_APP_TOKEN, Basic $BASIC"',
    `Authorization: Bearer ${bootstrapBearer}`,
    "`data.application.general.token` is the per-event application token.",
  ];
}

let repo: string;

function git(...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test Person 1",
      "-c",
      "user.email=test.person.1@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, stdio: "ignore" },
  );
}

function write(relativePath: string, content: string): void {
  const absolute = join(repo, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function commitAll(): void {
  git("add", "-A", "--force", ".");
  git("commit", "-q", "-m", "fixtures");
}

function runCheck(): { status: number | null; stderr: string; stdout: string } {
  const run = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 60_000,
  });
  if (run.error !== undefined) throw run.error;
  return { status: run.status, stderr: run.stderr, stdout: run.stdout };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gripeventsctl-leakage-"));
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("[CAP-REDACT] the secret-leakage gate over a temporary repository", () => {
  it("R15: finds a committed fixture secret of each shape, one finding per file, and exits 1", () => {
    const secrets = fixtureSecrets();
    const files = shapedFiles(secrets);
    for (const [name, content] of Object.entries(files)) write(`fixtures/${name}`, content);
    write("README.md", `# Fixtures\n\n${placeholders(secrets.bootstrapBearer).join("\n")}\n`);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.includes("secret-shaped value:"));
    const flaggedFiles = new Set(findings.map((line) => line.split(":")[0]));
    expect([...flaggedFiles].sort()).toEqual(
      Object.keys(files)
        .map((name) => `fixtures/${name}`)
        .sort(),
    );
    expect(flaggedFiles.has("README.md")).toBe(false);
    expect(result.stderr).toContain("FAIL: found");
  });

  it("R16: prints at most a 12-character prefix of a match, never the value", () => {
    const secrets = fixtureSecrets();
    for (const [name, content] of Object.entries(shapedFiles(secrets))) write(`fixtures/${name}`, content);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.includes("secret-shaped value:"));
    expect(findings.length).toBeGreaterThanOrEqual(7);
    for (const line of findings) {
      const match = /secret-shaped value: (.*)… \((\d+) chars\)$/u.exec(line);
      expect(match, line).not.toBeNull();
      if (match === null) continue;
      expect(match[1]?.length ?? 0).toBeLessThanOrEqual(12);
      expect(Number(match[2])).toBeGreaterThan(12);
    }
    for (const value of Object.values(secrets)) {
      expect(result.stderr).not.toContain(value);
      expect(result.stdout).not.toContain(value);
    }
  });

  it("R17: a clean repository holding only the docs placeholders exits 0 with nothing on stderr", () => {
    const { bootstrapBearer } = fixtureSecrets();
    expect(bootstrapBearer).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(bootstrapBearer.startsWith("eyJ")).toBe(false);
    write("docs/api/README.md", `# Placeholders\n\n${placeholders(bootstrapBearer).join("\n")}\n`);
    write("src/index.ts", 'export const userToken = "<user_token>";\n');
    commitAll();

    const result = runCheck();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("R18: skips .tmp/, untracked files, lockfiles and the excluded source-of-truth paths", () => {
    const secrets = fixtureSecrets();
    write(".tmp/captured.txt", `X-Authorization: ${secrets.sessionToken}\n`);
    write("pnpm-lock.yaml", `token=${secrets.chatToken}\n`);
    write("packages/core/src/lib/redact.ts", `// Authorization: Basic ${secrets.basic}\n`);
    write("clean.txt", "nothing secret here\n");
    commitAll();
    write("untracked.txt", `user_token: ${secrets.sessionToken}\n`);

    const result = runCheck();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("R19: ordinary prose after `Basic ` in a committed file is not flagged: a word never holds a digit, `+`, `/` or `=`", () => {
    write(
      "docs/prose.md",
      [
        "# Prose",
        "",
        "Basic Interoperability Guidelines apply here.",
        "The Basic Responsibilities of a maintainer.",
        "Basic Authentication is the scheme.",
        "",
      ].join("\n"),
    );
    commitAll();

    const result = runCheck();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
