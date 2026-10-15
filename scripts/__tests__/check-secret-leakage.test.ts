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
  /** The `grip_cdp_token` of a config answer, a credential under `application.general`. */
  cdpToken: string;
  /** The shape of the platform's public bootstrap bearer (32 letters and digits), never its value. */
  bootstrapBearer: string;
}

const BEARER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * The shortest run of a fixture value a printed prefix must not hold. A prefix of the raw match held five characters
 * of the application token after `Bearer `, six of the Basic value after `Basic ` and the first twelve of the chat
 * token; a run this long of a value generated per run is not expected in the fixed text of a redacted prefix.
 */
const RUN = 5;

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
    cdpToken: segment(24),
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
    "grip-cdp-token-json.txt": `{"application": {"general": {"grip_cdp_token": "${secrets.cdpToken}"}}}\n`,
    // A pretty-printed config answer: the `"general"` key sits two lines above the token, so only a match over the
    // whole file catches it.
    "general-token-pretty.json": `${prettyConfigAnswer(secrets.applicationToken)}\n`,
    // A JSON string holding the answer as JSON text: every quote is escaped (`\"user_token\": \"…\"`).
    "user-token-escaped.json": `${JSON.stringify(JSON.stringify({ user_token: secrets.sessionToken }))}\n`,
    // The header recorded as a name/value pair, as a HAR capture records it, in either order.
    "x-authorization-name-value.har": `${JSON.stringify({ headers: [{ name: "X-Authorization", value: secrets.sessionToken }] }, null, 2)}\n`,
    "x-authorization-value-name.json": `${JSON.stringify({ headers: [{ value: secrets.sessionToken, name: "X-Authorization" }] })}\n`,
    // The same pair pretty-printed, then held as a JSON string: the line break between its members is escaped.
    "x-authorization-name-value-escaped-pretty.json": `${JSON.stringify(JSON.stringify({ headers: [{ name: "X-Authorization", value: secrets.sessionToken }] }, null, 2))}\n`,
    "x-authorization-value-name-escaped-pretty.json": `${JSON.stringify(JSON.stringify({ headers: [{ value: secrets.sessionToken, name: "X-Authorization" }] }, null, 2))}\n`,
  };
}

/** The config answer as a capture pretty-prints it, one key per line (docs/api/containers.md § Fields of a 200 answer). */
function prettyConfigAnswer(applicationToken: string): string {
  return JSON.stringify({ application: { general: { application_id: 1, token: applicationToken } } }, null, 2);
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
    "`grip_cdp_token` is a credential too; the answer carries it under `data.application.general`.",
    '"grip_cdp_token": "<value>"',
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
  it("R15: flags every fixture file and no placeholder file, and exits 1", () => {
    const secrets = fixtureSecrets();
    const files = shapedFiles(secrets);
    for (const [name, content] of Object.entries(files)) write(`fixtures/${name}`, content);
    write("README.md", `# Fixtures\n\n${placeholders(secrets.bootstrapBearer).join("\n")}\n`);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.includes("secret-shaped value ["));
    const flaggedFiles = new Set(findings.map((line) => line.split(":")[0]));
    expect([...flaggedFiles].sort()).toEqual(
      Object.keys(files)
        .map((name) => `fixtures/${name}`)
        .sort(),
    );
    expect(flaggedFiles.has("README.md")).toBe(false);
    expect(result.stderr).toContain("FAIL: found");
  });

  it("R16: prints at most a 12-character prefix of a match, never the value nor a run of it", () => {
    const secrets = fixtureSecrets();
    for (const [name, content] of Object.entries(shapedFiles(secrets))) write(`fixtures/${name}`, content);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.includes("secret-shaped value ["));
    expect(findings.length).toBeGreaterThanOrEqual(7);
    for (const line of findings) {
      const match = /secret-shaped value \[[^\]]+\]: (.*)… \((\d+) chars\)$/u.exec(line);
      expect(match, line).not.toBeNull();
      if (match === null) continue;
      const prefix = match[1] ?? "";
      expect(prefix.length).toBeLessThanOrEqual(12);
      expect(Number(match[2])).toBeGreaterThan(12);
      // The prefix is the redacted match: no run of five characters of any fixture value is in it.
      for (const [name, value] of Object.entries(secrets)) {
        for (let start = 0; start + RUN <= value.length; start += 1) {
          expect(prefix, `${line} holds a run of the ${name}`).not.toContain(value.slice(start, start + RUN));
        }
      }
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

  it("R20: matches over the whole file, so a pretty-printed answer whose key context sits on an earlier line than the token is flagged, at the line the match starts on", () => {
    const secrets = fixtureSecrets();
    // Line 1 `{`, line 2 `"application": {`, line 3 `"general": {`, line 4 `"application_id": 1`, line 5 the token.
    write("fixtures/config-answer.json", `${prettyConfigAnswer(secrets.applicationToken)}\n`);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.includes("secret-shaped value ["));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^fixtures\/config-answer\.json:3: secret-shaped value \[[^\]]+\]: /);
    expect(result.stderr).not.toContain(secrets.applicationToken);
  });

  it("R21: names the shape of each finding, and the FAIL message gives a remedy that fits each shape it found", () => {
    const secrets = fixtureSecrets();
    const files = shapedFiles(secrets);
    for (const name of ["user-token-key.txt", "jwt.txt", "basic-alone.txt", "general-token-json.txt"]) {
      write(`fixtures/${name}`, files[name] ?? "");
    }
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const shapeOf = (file: string): string | undefined =>
      result.stderr
        .split("\n")
        .find((line) => line.startsWith(`fixtures/${file}:`))
        ?.match(/secret-shaped value \[([^\]]+)\]: /u)?.[1];
    expect(shapeOf("user-token-key.txt")).toBe("a session token after user_token or X-Authorization");
    expect(shapeOf("jwt.txt")).toBe("a JWT, such as the chat token");
    expect(shapeOf("basic-alone.txt")).toBe("a Basic value");
    expect(shapeOf("general-token-json.txt")).toBe("the application token after general.token or a general key");
    const footer = result.stderr.slice(result.stderr.indexOf("FAIL: "));
    expect(footer).toMatch(/^FAIL: found 4 secret-shaped value\(s\) in tracked source/u);
    // One remedy line per remedy, naming every shape found that it fits; the password for a Basic value.
    expect(footer).toContain("  - a Basic value: the base64 holds an email and a password: change that password.\n");
    // A sign-in replaces the stored session; whether the platform then refuses the committed token is not verified.
    expect(footer).toContain(
      "  - a session token after user_token or X-Authorization: sign in again (`gripeventsctl auth signin <slug>`) to replace the stored session; the committed token may stay valid until it expires.\n",
    );
    expect(footer).toContain(
      "  - a JWT, such as the chat token; the application token after general.token or a general key: no command of this tool replaces it: rewrite the commit before it is pushed.\n",
    );
    expect(footer).not.toContain("revoke");
  });

  it("R22: scans a tracked file of any size: a secret at the end of a file over 1 MiB is flagged", () => {
    const secrets = fixtureSecrets();
    const filler = `${"synthetic filler line of a large capture\n".repeat(40_000)}`;
    expect(filler.length).toBeGreaterThan(1024 * 1024);
    write("fixtures/large-capture.txt", `${filler}X-Authorization: ${secrets.sessionToken}\n`);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixtures/large-capture.txt:40001: secret-shaped value [");
    expect(result.stderr).not.toContain(secrets.sessionToken);
  });

  it("R23: names a tracked file it cannot read and fails, since it cannot vouch for it", () => {
    write("fixtures/clean.txt", "nothing secret here\n");
    write("fixtures/deleted.txt", "nothing secret here either\n");
    commitAll();
    // Tracked, but no longer in the working tree: the read fails.
    rmSync(join(repo, "fixtures", "deleted.txt"));

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^fixtures\/deleted\.txt: not scanned: .*ENOENT/mu);
    expect(result.stderr).not.toContain("fixtures/clean.txt");
    expect(result.stderr).toContain("FAIL: 1 tracked file(s) could not be read, so the check cannot vouch for them.");
  });

  it("R24: flags a login Authorization value that only the login shape knows as one finding, the whole `Bearer …, Basic …` value", () => {
    // A Bearer value under 16 characters and a Basic value of letters only: the standalone Basic shape leaves such a
    // run to prose, and the bare Bearer shape is not a lint shape, so only the login shape can flag this line.
    const bearer = randomBytes(6).toString("hex");
    const basic = Array.from(randomBytes(24), (byte) => BEARER_ALPHABET.charAt(byte % 52)).join("");
    const value = `Bearer ${bearer}, Basic ${basic}`;
    write("fixtures/login-letters.txt", `Authorization: ${value}\n`);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    const findings = result.stderr.split("\n").filter((line) => line.includes("secret-shaped value ["));
    expect(findings).toEqual([
      `fixtures/login-letters.txt:1: secret-shaped value [the login Authorization value]: Bearer <REDA… (${String(value.length)} chars)`,
    ]);
    expect(result.stderr).not.toContain(bearer);
    expect(result.stderr).not.toContain(basic);
  });

  it("R25: prints the prefix of a value-first name/value pair as its key up to the token and then `<REDACTED>`, with no character of the token", () => {
    // The value-first shape's match runs on to the header name after the token, so the match redacted alone hides the
    // token. A match that stopped at the token would leave it to no shape, and the prefix would hold its first
    // characters after the key: two or three, under the five-character run R16 looks for.
    const { sessionToken } = fixtureSecrets();
    const pair = { headers: [{ value: sessionToken, name: "X-Authorization" }] };
    const forms: [string, string, string][] = [
      ["value-name-compact.json", JSON.stringify(pair), '"value":"<RE'],
      ["value-name-pretty.json", JSON.stringify(pair, null, 2), '"value": "<R'],
      ["value-name-escaped.json", JSON.stringify(JSON.stringify(pair)), String.raw`"value\":\"<`],
    ];
    for (const [name, content] of forms) write(`fixtures/${name}`, `${content}\n`);
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    for (const [name, , expected] of forms) {
      const line = result.stderr.split("\n").find((candidate) => candidate.startsWith(`fixtures/${name}:`));
      const prefix =
        /secret-shaped value \[a session token in an X-Authorization name\/value pair\]: (.*)… \(\d+ chars\)$/u.exec(
          line ?? "",
        )?.[1];
      expect(prefix, line).toBe(expected);
    }
    expect(result.stderr).not.toContain(sessionToken);
  });

  it("R26: scans a tracked file whose path holds a non-ASCII character, under its own name", () => {
    // Line by line, `git ls-files` quotes such a path and escapes its bytes (`"fixtures/caf\303\251-capture.txt"`), and
    // no file has that name.
    const secrets = fixtureSecrets();
    write("fixtures/café-capture.txt", `X-Authorization: ${secrets.sessionToken}\n`);
    write("docs/données.md", "nothing secret here\n");
    commitAll();

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^fixtures\/café-capture\.txt:1: secret-shaped value \[/mu);
    expect(result.stderr).not.toContain("not scanned");
    expect(result.stderr).not.toContain("could not be read");
    expect(result.stderr).not.toContain(secrets.sessionToken);
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
