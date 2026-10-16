// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-AUTH, unit: the two 1Password calls (issue #7 § Specification, steps 4 and 6), through an
 * injected `execFile` so they run on every platform: the argument arrays, the template on stdin, the
 * secrets registered, and the `config` kind on a missing `op`, a failed call and a killed child.
 */

import type { ChildProcess, ExecException } from "node:child_process";

import { ConfigError, type ExecFileLike, redactString } from "@gripeventsctl/core";
import { fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it, vi } from "vitest";

import {
  OP_TIMEOUT_MS,
  itemReferenceOf,
  opTokenTemplate,
  readOpCredentials,
  writeOpToken,
} from "../lib/op-credentials.js";

interface Recorded {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
  stdin: string;
  ended: boolean;
}

/** An `execFile` that records the call and answers with `answer`, or fails with `error`. */
function fakeExecFile(answer: { stdout?: string; stderr?: string; error?: Partial<ExecException> } = {}) {
  const calls: Recorded[] = [];
  const execFile = vi.fn<ExecFileLike>((file, args, options, callback) => {
    const record: Recorded = { file, args, env: options.env, stdin: "", ended: false };
    calls.push(record);
    const child = {
      stdin: {
        write: (chunk: string) => {
          record.stdin += chunk;
          return true;
        },
        end: () => {
          record.ended = true;
        },
      },
    } as unknown as ChildProcess;
    queueMicrotask(() => {
      const error =
        answer.error === undefined ? null : ({ name: "Error", message: "op failed", ...answer.error } as ExecException);
      callback(error, answer.stdout ?? "", answer.stderr ?? "");
    });
    return child;
  });
  return { execFile, calls };
}

describe("[CAP-AUTH] the 1Password credential calls", () => {
  it("reads username and password with `op item get`, an argument array, the OP_* environment and a bound timeout", async () => {
    const { password } = fixtureSecrets();
    const fields = [
      { id: "username", label: "username", value: "test.person.1@example.com" },
      { id: "password", label: "password", value: password },
    ];
    const { execFile, calls } = fakeExecFile({ stdout: `${JSON.stringify(fields)}\n` });
    const credentials = await readOpCredentials("op://Vault/Item", {
      env: { OP_ACCOUNT: "x", PATH: "/bin", OTHER: "y" },
      execFile,
    });
    expect(credentials).toEqual({ email: "test.person.1@example.com", password });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("op");
    expect(calls[0]?.args).toEqual([
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
    expect(calls[0]?.env).toEqual({ OP_ACCOUNT: "x", PATH: "/bin" });
    expect(calls[0]?.stdin).toBe("");
    expect(calls[0]?.ended).toBe(true);
    expect(execFile.mock.calls[0]?.[2].timeout).toBe(OP_TIMEOUT_MS);
    expect(execFile.mock.calls[0]?.[2].killSignal).toBe("SIGKILL");
    // The password is registered as a secret the moment it is read.
    expect(redactString(`password ${password}`)).toBe("password <REDACTED>");
  });

  it("accepts a single field object and refuses an item missing either field with the config kind", async () => {
    const one = fakeExecFile({ stdout: JSON.stringify({ label: "username", value: "test.person.1@example.com" }) });
    const error = await readOpCredentials("op://Vault/Item", { execFile: one.execFile }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("does not hold both a username and a password field");
  });

  it("maps a missing op, a failed call and a killed child to the config kind, with the stderr redacted", async () => {
    const { chatToken } = fixtureSecrets();
    const missing = fakeExecFile({ error: { code: "ENOENT" } });
    await expect(readOpCredentials("op://Vault/Item", { execFile: missing.execFile })).rejects.toMatchObject({
      kind: "config",
      message: expect.stringContaining("not found on PATH") as string,
    });

    const failed = fakeExecFile({ error: { code: 1 }, stderr: `[ERROR] no item with token ${chatToken}\n` });
    const failure = await readOpCredentials("op://Vault/Item", { execFile: failed.execFile }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).message).toContain("(exit 1)");
    expect((failure as ConfigError).message).not.toContain(chatToken);

    const killed = fakeExecFile({ error: { killed: true, signal: "SIGKILL" } });
    await expect(
      writeOpToken("op://Vault/Item/token", "a-token-value-1", { execFile: killed.execFile }),
    ).rejects.toMatchObject({
      kind: "config",
      message: expect.stringContaining("did not answer within 120 s") as string,
    });
  });

  it("writes the token with `op item edit` and the template on stdin, never as an argument", async () => {
    const { sessionToken } = fixtureSecrets();
    const { execFile, calls } = fakeExecFile({ stdout: '{"id":"item1"}' });
    await writeOpToken("op://Vault/Item/Section A/token", sessionToken, { execFile });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["item", "edit", "Item", "--vault", "Vault", "--format", "json"]);
    expect(calls[0]?.args.join(" ")).not.toContain(sessionToken);
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual({
      fields: [{ label: "token", type: "CONCEALED", value: sessionToken, section: { label: "Section A" } }],
    });
    expect(calls[0]?.ended).toBe(true);
  });

  it("derives the item reference and the template from a field reference, and refuses an item reference", () => {
    expect(itemReferenceOf("op://Vault/Item/token")).toBe("op://Vault/Item");
    expect(itemReferenceOf("op://Vault/Item/Section/token")).toBe("op://Vault/Item");
    expect(JSON.parse(opTokenTemplate("op://Vault/Item/token", "value-1"))).toEqual({
      fields: [{ label: "token", type: "CONCEALED", value: "value-1" }],
    });
    expect(() => itemReferenceOf("op://Vault/Item")).toThrow(ConfigError);
  });
});
