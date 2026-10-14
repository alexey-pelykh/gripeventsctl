// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { type ChildProcess, type ExecException, execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STUB_OP_SUPPORTED, fixtureSecrets, stubOp, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it, vi } from "vitest";

import {
  type ExecFileLike,
  OP_TIMEOUT_MS,
  isFieldReference,
  isItemReference,
  opEnvironment,
  opItemEditArgs,
  opItemGetArgs,
  opRead,
  opReadArgs,
  parseOpReference,
  validateOpReference,
} from "../config/op.js";
import type { Config } from "../config/schema.js";
import { resolveSessionToken } from "../config/store.js";
import { REDACTED, redactString, registerSecret } from "../lib/redact.js";
import { ConfigError } from "../transport/errors.js";

const POSIX_ONLY = " (POSIX only: the stub op is a shell script)";

function sessionWith(token: string): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T19:09:00Z" },
    writes: { enabled: false },
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

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("[CAP-CFG] 1Password references and arguments", () => {
  it.each([
    ["op://V/I/f", { vault: "V", item: "I", field: "f" }],
    ["op://V/I/s/f", { vault: "V", item: "I", section: "s", field: "f" }],
    ["op://My Vault/my-item/my.field", { vault: "My Vault", item: "my-item", field: "my.field" }],
  ])("accepts %s as a field reference", (reference, parts) => {
    expect(isFieldReference(reference)).toBe(true);
    expect(isItemReference(reference)).toBe(false);
    expect(parseOpReference(reference)).toEqual({ reference, kind: "field", ...parts });
    expect(validateOpReference(reference, "field").kind).toBe("field");
    expect(() => validateOpReference(reference, "item")).toThrow(ConfigError);
  });

  it("accepts op://V/I as an item reference", () => {
    expect(isItemReference("op://V/I")).toBe(true);
    expect(isFieldReference("op://V/I")).toBe(false);
    expect(parseOpReference("op://V/I")).toEqual({ reference: "op://V/I", kind: "item", vault: "V", item: "I" });
    expect(() => validateOpReference("op://V/I", "field")).toThrow(ConfigError);
  });

  it.each([
    ["op://V/I;rm"],
    ["op://V/$(x)/f"],
    ["op://V/I/f\n"],
    ["op://V//f"],
    ["op://V"],
    ["op://V/I/s/f/g"],
    ["op:/V/I"],
    [""],
  ])("rejects %j before any process is spawned", async (reference) => {
    expect(parseOpReference(reference)).toBeUndefined();
    expect(isFieldReference(reference)).toBe(false);
    expect(isItemReference(reference)).toBe(false);
    expect(() => validateOpReference(reference, "field")).toThrow(ConfigError);
    const execFile = vi.fn<ExecFileLike>();
    const error = await expectConfigError(opRead(reference, {}, { execFile }));
    expect(error.kind).toBe("config");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("builds the op read, op item get and op item edit argument arrays", () => {
    expect(opReadArgs("op://Vault/Item/token")).toEqual(["read", "op://Vault/Item/token"]);
    expect(opItemGetArgs("op://Vault/Item")).toEqual(["item", "get", "Item", "--vault", "Vault", "--format", "json"]);
    expect(opItemGetArgs("op://Vault/Item", { fields: ["username", "password"] })).toEqual([
      "item",
      "get",
      "Item",
      "--vault",
      "Vault",
      "--format",
      "json",
      "--fields",
      "label=username,label=password",
    ]);
    expect(opItemEditArgs("op://Vault/Item", { token: "value-1", "section.field": "value-2" })).toEqual([
      "item",
      "edit",
      "Item",
      "--vault",
      "Vault",
      "token=value-1",
      "section.field=value-2",
    ]);
    expect(() => opItemGetArgs("op://Vault/Item", { fields: ["user;name"] })).toThrow(ConfigError);
    expect(() => opItemEditArgs("op://Vault/Item", { "$(x)": "v" })).toThrow(ConfigError);
    expect(() => opItemGetArgs("op://Vault/Item/field")).toThrow(ConfigError);
  });

  it("refuses an item, a vault or a label that op would read as a flag", () => {
    expect(() => opItemGetArgs("op://Vault/--help")).toThrow(/must not start with "-"/);
    expect(() => opItemGetArgs("op://-v/Item")).toThrow(ConfigError);
    expect(() => opItemEditArgs("op://Vault/Item", { "-x": "v" })).toThrow(ConfigError);
    expect(() => opItemGetArgs("op://Vault/Item", { fields: ["--all"] })).toThrow(ConfigError);
    // A leading dash in a value is harmless: the argv element starts with the label.
    expect(opItemEditArgs("op://Vault/Item", { token: "-starts-with-dash" })).toContain("token=-starts-with-dash");
  });

  it("passes only OP_*, PATH and the platform minimum to the child", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "service-account",
      OP_CONNECT_HOST: "http://localhost:8080",
      PATH: "/usr/bin",
      HOME: "/home/test",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      SystemRoot: "C:\\Windows",
      op_lowercase: "must not pass",
      GRIPEVENTSCTL_PROBE: "must not pass",
      AWS_SECRET_ACCESS_KEY: "must not pass",
      SSH_AUTH_SOCK: "must not pass",
    };
    expect(opEnvironment(env)).toEqual({
      OP_SERVICE_ACCOUNT_TOKEN: "service-account",
      OP_CONNECT_HOST: "http://localhost:8080",
      PATH: "/usr/bin",
      HOME: "/home/test",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      SystemRoot: "C:\\Windows",
    });
  });

  it("calls op with an argument array and no shell, through the injected execFile", async () => {
    const execFile = vi.fn<ExecFileLike>((_file, _args, _options, callback) => {
      callback(null, "value-from-op\n", "");
      return { stdin: null } as unknown as ChildProcess;
    });
    await expect(opRead("op://Vault/Item/token", { OP_ACCOUNT: "x", OTHER: "y" }, { execFile })).resolves.toBe(
      "value-from-op",
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0] ?? [];
    expect(file).toBe("op");
    expect(args).toEqual(["read", "op://Vault/Item/token"]);
    expect(options?.env).toEqual({ OP_ACCOUNT: "x" });
    expect(options?.shell).toBeUndefined();
  });

  it("bounds every op call at 120 s, and reports a child the timeout killed as the config kind naming op", async () => {
    const execFile = vi.fn<ExecFileLike>((_file, _args, _options, callback) => {
      // What `child_process.execFile` hands the callback when its own timeout kills the child (Node 26.11.1):
      // `killed` true, the signal it sent, no exit code. A non-zero exit has `killed` false and a numeric code.
      const timedOut = Object.assign(new Error("Command failed: op read op://Vault/Item/token"), {
        killed: true,
        signal: "SIGKILL",
        code: null,
        cmd: "op read op://Vault/Item/token",
      }) as unknown as ExecException;
      callback(timedOut, "", "");
      return { stdin: null } as unknown as ChildProcess;
    });
    const error = await expectConfigError(opRead("op://Vault/Item/token", {}, { execFile }));
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[2].timeout).toBe(OP_TIMEOUT_MS);
    expect(execFile.mock.calls[0]?.[2].killSignal).toBe("SIGKILL");
    expect(OP_TIMEOUT_MS).toBe(120_000);
    expect(error.kind).toBe("config");
    expect(error.message).toBe("1Password CLI (`op`) did not answer within 120 s while reading op://Vault/Item/token");
    expect(error.hint).toContain("`op signin`");
  });

  it.skipIf(!STUB_OP_SUPPORTED)(
    `ends a child that ignores SIGTERM at the timeout, so a hung op never holds the call past the bound${POSIX_ONLY}`,
    async () => {
      // With execFile's default SIGTERM, a child that ignores it keeps the call waiting until it exits on its own,
      // and an exit 0 then reads as an answer: this stub would answer the empty string after 8 s, and opRead would
      // return it. The real execFile runs here with every option opRead passes, the timeout alone shortened. The stub
      // writes its marker once its trap is set: a run whose timeout fired before that tells nothing, so it runs again
      // with a longer timeout. No assertion reads the clock.
      const markerDir = await mkdtemp(join(tmpdir(), "gripeventsctl-op-trap-"));
      const marker = join(markerDir, "trapped");
      const stub = await stubOp(`trap '' TERM\n: > "$OP_TEST_TRAPPED_FILE"\nexec sleep 8`);
      try {
        for (const timeout of [2_000, 5_000, 10_000]) {
          const shortened: ExecFileLike = (file, args, options, callback) =>
            nodeExecFile(file, args, { ...options, timeout }, (error, stdout, stderr) => {
              callback(error as ExecException | null, stdout, stderr);
            });
          const env = { ...process.env, OP_TEST_TRAPPED_FILE: marker };
          const error = await expectConfigError(opRead("op://Vault/Item/token", env, { execFile: shortened }));
          expect(error.message).toBe(
            "1Password CLI (`op`) did not answer within 120 s while reading op://Vault/Item/token",
          );
          if ((await readdir(markerDir)).includes("trapped")) return;
        }
        throw new Error("the stub set no trap before the timeout, even at 10 s: the run tells nothing");
      } finally {
        await stub.remove();
        await rm(markerDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("[CAP-CFG] resolveSessionToken() through the 1Password CLI", () => {
  it.skipIf(!STUB_OP_SUPPORTED)(`runs op read with OP_* passed through and stores nothing${POSIX_ONLY}`, async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      const stub = await stubOp(`printf '%s\\n' '${token}'`);
      try {
        const env = {
          ...process.env,
          OP_SERVICE_ACCOUNT_TOKEN: "service-account-1",
          OP_ACCOUNT: "account-1",
          GRIPEVENTSCTL_PROBE: "must not reach the child",
        };
        const resolved = await resolveSessionToken(sessionWith("op://Vault/Item/token"), { env });
        expect(resolved).toBe(token);
        const calls = await stub.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.argv).toEqual(["read", "op://Vault/Item/token"]);
        expect(calls[0]?.stdin).toBe("");
        expect(calls[0]?.env["OP_SERVICE_ACCOUNT_TOKEN"]).toBe("service-account-1");
        expect(calls[0]?.env["OP_ACCOUNT"]).toBe("account-1");
        expect(calls[0]?.env["GRIPEVENTSCTL_PROBE"]).toBeUndefined();
        expect(await readdir(home.dir)).toEqual([]);
        expect(redactString(`token ${token}`)).toBe(`token ${REDACTED}`);
      } finally {
        await stub.remove();
      }
    });
  });

  it.skipIf(!STUB_OP_SUPPORTED)(
    `refuses with the config kind naming the missing CLI when op is not on PATH${POSIX_ONLY}`,
    async () => {
      const emptyBin = await mkdtemp(join(tmpdir(), "gripeventsctl-empty-bin-"));
      try {
        const env = { ...process.env, PATH: emptyBin, OP_ACCOUNT: "account-1" };
        const error = await expectConfigError(resolveSessionToken(sessionWith("op://Vault/Item/token"), { env }));
        expect(error.kind).toBe("config");
        expect(error.message).toContain("1Password CLI");
        expect(error.message).toContain("not found");
      } finally {
        await rm(emptyBin, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!STUB_OP_SUPPORTED)(`redacts op's stderr in the error when op fails${POSIX_ONLY}`, async () => {
    const secrets = fixtureSecrets();
    const other = fixtureSecrets().sessionToken;
    // A registered live value of another shape, as the auth item will register the password.
    const registered = `reg-${secrets.password}`;
    registerSecret(registered);
    const stub = await stubOp(
      `printf '%s\\n' 'failed: ${secrets.sessionToken} user_token: ${other} ${registered} ${secrets.chatToken}' >&2; exit 1`,
    );
    try {
      const error = await expectConfigError(
        resolveSessionToken(sessionWith("op://Vault/Item/token"), { env: process.env }),
      );
      expect(error.kind).toBe("config");
      expect(error.message).toContain(REDACTED);
      for (const value of [secrets.sessionToken, other, registered, secrets.chatToken]) {
        expect(occurrences(error.message, value)).toBe(0);
      }
      expect(error.message).toContain("exit 1");
      expect(error.message).toContain("failed:");
    } finally {
      await stub.remove();
    }
  });
});
