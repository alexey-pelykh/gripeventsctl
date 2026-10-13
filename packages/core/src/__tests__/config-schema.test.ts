// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { CONFIG_VERSION, type Config, emptyConfig, parseConfig, validateConfig } from "../config/schema.js";
import { ConfigError } from "../transport/errors.js";

const secrets = fixtureSecrets();
const SEND_LOG = join(tmpdir(), "custom-send-log.jsonl");

/** Every key of the file, as the issue documents it. */
function fullFile(): Record<string, unknown> {
  return {
    version: 1,
    auth: { credentials: "op://Vault/Item" },
    session: {
      slug: "testevent1",
      container_id: 1,
      token: secrets.sessionToken,
      signed_in_at: "2026-10-12T19:09:00Z",
      auth_failed_at: "2026-10-13T08:12:00Z",
    },
    writes: { enabled: true, send_log: SEND_LOG },
  };
}

function refusal(data: unknown): ConfigError {
  try {
    parseConfig(data);
  } catch (error: unknown) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("the shape was accepted");
}

describe("[CAP-CFG] the config file schema, version 1", () => {
  it("accepts the minimal file and defaults writes to safe mode", () => {
    const config = parseConfig({ version: 1 });
    expect(config).toEqual({ version: 1, writes: { enabled: false } });
    expect(config.session).toBeUndefined();
    expect(emptyConfig()).toEqual(config);
  });

  it("accepts the full file with every key", () => {
    const config = parseConfig(fullFile());
    expect(config).toEqual(fullFile());
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.writes.enabled).toBe(true);
  });

  it("defaults writes.enabled to false when the writes mapping omits it", () => {
    expect(parseConfig({ version: 1, writes: { send_log: SEND_LOG } }).writes).toEqual({
      enabled: false,
      send_log: SEND_LOG,
    });
  });

  it("accepts a session token held behind an op:// field reference, and credentials behind an item reference", () => {
    const file = fullFile();
    (file["session"] as Record<string, unknown>)["token"] = "op://Vault/Item/token";
    expect(parseConfig(file).session?.token).toBe("op://Vault/Item/token");
    expect(parseConfig(file).auth?.credentials).toBe("op://Vault/Item");
  });

  it("accepts timestamps with fractional seconds", () => {
    const file = fullFile();
    (file["session"] as Record<string, unknown>)["signed_in_at"] = "2026-10-12T19:09:00.000Z";
    expect(parseConfig(file).session?.signed_in_at).toBe("2026-10-12T19:09:00.000Z");
  });

  const refused: [string, () => Record<string, unknown>, string][] = [
    ["an unknown top-level key", () => ({ version: 1, sessions: {} }), 'unknown key "sessions"'],
    [
      "an unknown nested key",
      () => {
        const file = fullFile();
        (file["session"] as Record<string, unknown>)["tokens"] = "x";
        return file;
      },
      'unknown key "session.tokens"',
    ],
    ["a version other than 1", () => ({ version: 2 }), "version must be 1"],
    ["a version that is the string 1", () => ({ version: "1" }), "version must be 1"],
    ["a missing version", () => ({ writes: { enabled: false } }), "version is required"],
    ["a relative writes.send_log", () => ({ version: 1, writes: { send_log: "logs/send.jsonl" } }), "writes.send_log"],
    [
      "a writes.send_log not ending in .jsonl",
      () => ({ version: 1, writes: { send_log: join(tmpdir(), "send.txt") } }),
      "writes.send_log",
    ],
    [
      "a writes.enabled that is not a boolean",
      () => ({ version: 1, writes: { enabled: "yes" } }),
      "writes.enabled must be a boolean",
    ],
    [
      "a session.token that is not a string",
      () => {
        const file = fullFile();
        (file["session"] as Record<string, unknown>)["token"] = 5;
        return file;
      },
      "session.token must be a string",
    ],
    [
      "a session.token that is an item reference",
      () => {
        const file = fullFile();
        (file["session"] as Record<string, unknown>)["token"] = "op://Vault/Item";
        return file;
      },
      "session.token",
    ],
    [
      "a session.container_id that is not positive",
      () => {
        const file = fullFile();
        (file["session"] as Record<string, unknown>)["container_id"] = 0;
        return file;
      },
      "session.container_id",
    ],
    [
      "a session without a slug",
      () => {
        const file = fullFile();
        delete (file["session"] as Record<string, unknown>)["slug"];
        return file;
      },
      "session.slug is required",
    ],
    [
      "a session.signed_in_at that is not an ISO 8601 UTC timestamp",
      () => {
        const file = fullFile();
        (file["session"] as Record<string, unknown>)["signed_in_at"] = "yesterday";
        return file;
      },
      "session.signed_in_at",
    ],
    [
      "an auth.credentials that is a field reference",
      () => ({ version: 1, auth: { credentials: "op://V/I/f" } }),
      "auth.credentials",
    ],
  ];

  it.each(refused)("refuses %s with the config kind and the key's name", (_title, file, fragment) => {
    const error = refusal(file());
    expect(error.kind).toBe("config");
    expect(error.message).toContain(fragment);
  });

  it("refuses a document that is not a mapping", () => {
    for (const data of [null, "version: 1", 1, ["version"]]) {
      const error = refusal(data);
      expect(error.kind).toBe("config");
      expect(error.message).toContain("must be a YAML mapping");
    }
  });

  it("names the source in the message when one is given", () => {
    expect(() => parseConfig({ version: 3 }, "/x/.gripeventsctl.yaml")).toThrow(
      /^\/x\/\.gripeventsctl\.yaml: invalid config: version must be 1$/,
    );
  });

  it("validates an in-memory config by the same rules", () => {
    const config = { version: 1, writes: { enabled: false }, extra: true } as unknown as Config;
    expect(() => validateConfig(config)).toThrow(ConfigError);
    expect(validateConfig(emptyConfig())).toEqual(emptyConfig());
  });
});
