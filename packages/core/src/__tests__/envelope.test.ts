// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import {
  MODE_PHASE_REASON,
  SWIPE_CAP_REASON,
  UNKNOWN_SLUG_REASON,
  configLookupSchema,
  conflictDetails,
  dataText,
  envelopeOf,
  gatedThingId,
  isGatedTypeReason,
  loginAnswerSchema,
  parseJson,
  schemaFailureMessage,
} from "../transport/envelope.js";

// docs/api/containers.md § Fields of a 200 answer: the documented fields, every value synthetic.
function configData(applicationToken: string): Record<string, unknown> {
  return {
    container: { general: { display_name: "Test Event 1", name: "testevent1", active: 1 } },
    application: {
      general: { application_name: "Example Org 1", application_id: 1, token: applicationToken },
      permissions: { type_permissions: { "1": "read" } },
    },
  };
}

describe("[CAP-CLIENT] the envelope (docs/api/README.md § Response envelope)", () => {
  it("parses { success, data } and returns undefined for anything else", () => {
    expect(envelopeOf(parseJson('{"success":true,"data":[1,2]}'))).toEqual({ success: true, data: [1, 2] });
    expect(envelopeOf(parseJson('{"success":false,"data":"reason 1"}'))).toEqual({ success: false, data: "reason 1" });
    expect(envelopeOf(parseJson('{"success":true}'))).toEqual({ success: true, data: undefined });
    expect(envelopeOf(parseJson('{"error":{"data":["x"]}}'))).toBeUndefined();
    expect(envelopeOf(parseJson("<html><body>Forbidden</body></html>"))).toBeUndefined();
    expect(envelopeOf(parseJson(""))).toBeUndefined();
    expect(envelopeOf(parseJson('"a string"'))).toBeUndefined();
  });

  it("envelopeOf reads the envelope from a body already parsed and returns undefined for anything else", () => {
    expect(envelopeOf({ success: true, data: [1, 2] })).toEqual({ success: true, data: [1, 2] });
    expect(envelopeOf({ success: false })).toEqual({ success: false, data: undefined });
    const notEnvelopes: [string, unknown][] = [
      ["undefined", undefined],
      ["null", null],
      ["a string", "a string"],
      ["a number", 1],
      ["an array", [{ success: true, data: 1 }]],
      ["the 409 body", { error: { data: ["x"] } }],
    ];
    for (const [label, body] of notEnvelopes) expect(envelopeOf(body), label).toBeUndefined();
  });

  it("dataText gives a string as it is, anything else as JSON, and a placeholder for a value JSON cannot serialise", () => {
    expect(dataText("reason 1")).toBe("reason 1");
    expect(dataText(undefined)).toBe("");
    expect(dataText({ a: [1] })).toBe('{"a":[1]}');
    // The catch is reachable from an answer: on Node 22 and 24, a `data` nested millions of levels deep (a body under
    // the 16 MiB cap) makes `JSON.stringify` throw `RangeError`. A BigInt and a cycle throw on every Node version.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(dataText(10n)).toBe("[a value that cannot be serialised]");
    expect(dataText(cyclic)).toBe("[a value that cannot be serialised]");
  });

  it("parseJson returns undefined, never throws, on a body that is not JSON", () => {
    expect(parseJson("<html>")).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
    expect(parseJson("{}")).toEqual({});
  });

  it("names the documented reasons exactly as the pages record them", () => {
    // docs/api/interest.md § Errors the app matches on; docs/api/containers.md § Answers.
    expect(SWIPE_CAP_REASON).toBe("limit of swipes reached for action");
    expect(MODE_PHASE_REASON).toBe("action not allowed under current mode phase");
    expect(UNKNOWN_SLUG_REASON).toBe("No results found for this container name");
  });

  it("reads the gated-type body `thing N not authorized` and the id it names (docs/api/attendees.md § Types)", () => {
    expect(isGatedTypeReason("thing 7 not authorized")).toBe(true);
    expect(isGatedTypeReason("Thing 12 Not Authorized")).toBe(true);
    expect(isGatedTypeReason("container not found")).toBe(false);
    expect(isGatedTypeReason(7)).toBe(false);
    expect(gatedThingId("thing 7 not authorized")).toBe(7);
    expect(gatedThingId("not authorized")).toBeUndefined();
  });

  it("extracts the array of a 409 from error.data or from data, and nothing else (docs/api/interest.md § Errors the app matches on)", () => {
    // Both shapes are accepted until a live 409 is recorded (docs/api/not-verified.md § Match answers).
    expect(conflictDetails({ error: { data: ["x", "y"] } })).toEqual(["x", "y"]);
    expect(conflictDetails({ error: { data: ["x", 2, { a: 1 }] } })).toEqual(["x", "2", '{"a":1}']);
    expect(conflictDetails({ success: false, data: ["x"] })).toEqual(["x"]);
    expect(conflictDetails({ success: false, data: ["x", 2] })).toEqual(["x", "2"]);
    expect(conflictDetails({ data: [] })).toEqual([]);
    // Where both shapes are present, the app's own location wins.
    expect(conflictDetails({ error: { data: ["e"] }, data: ["d"] })).toEqual(["e"]);
    expect(conflictDetails({ error: { data: "x" } })).toBeUndefined();
    expect(conflictDetails({ error: {} })).toBeUndefined();
    expect(conflictDetails({ success: false, data: "x" })).toBeUndefined();
    expect(conflictDetails({ success: false, data: { x: 1 } })).toBeUndefined();
    expect(conflictDetails("x")).toBeUndefined();
    expect(conflictDetails(undefined)).toBeUndefined();
  });
});

describe("[CAP-CLIENT] the config lookup answer (docs/api/containers.md § Fields of a 200 answer)", () => {
  it("types the documented fields and drops unknown keys at every level, default_container_id included", () => {
    const { applicationToken } = fixtureSecrets();
    const data = configData(applicationToken);
    const withExtras = {
      ...data,
      default_container_id: 2,
      container: {
        ...(data["container"] as object),
        extra: true,
        general: { display_name: "Test Event 1", name: "testevent1", active: 1, colour: "x" },
      },
    };
    const parsed = configLookupSchema.parse(withExtras);
    expect(parsed).toEqual(configData(applicationToken));
    expect("default_container_id" in parsed).toBe(false);
  });

  it("keeps type_permissions as sent and lets permissions be absent", () => {
    const { applicationToken } = fixtureSecrets();
    const data = configData(applicationToken);
    const application = data["application"] as { general: unknown; permissions: unknown };
    const withoutPermissions = { ...data, application: { general: application.general } };
    const parsed = configLookupSchema.parse(withoutPermissions);
    expect(parsed.application.permissions).toBeUndefined();
    const nested = configLookupSchema.parse({
      ...data,
      application: {
        general: application.general,
        permissions: { type_permissions: [{ type_id: 1, name: "Type 1" }] },
      },
    });
    expect(nested.application.permissions?.type_permissions).toEqual([{ type_id: 1, name: "Type 1" }]);
  });

  it("names the missing documented field", () => {
    const { applicationToken } = fixtureSecrets();
    const data = configData(applicationToken);
    const withoutDisplayName = {
      ...data,
      container: { general: { name: "testevent1", active: 1 } },
    };
    const result = configLookupSchema.safeParse(withoutDisplayName);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(schemaFailureMessage(result.error)).toContain("container.general.display_name");
    const withoutToken = {
      ...data,
      application: { general: { application_name: "Example Org 1", application_id: 1 } },
    };
    const tokenResult = configLookupSchema.safeParse(withoutToken);
    if (tokenResult.success) throw new Error("unreachable");
    expect(schemaFailureMessage(tokenResult.error)).toContain("application.general.token");
  });
});

describe("[CAP-CLIENT] the login answer (docs/api/login.md § Response)", () => {
  it("requires user_token and takes chat_token as the documented object, a string, or absent", () => {
    const { sessionToken, chatToken } = fixtureSecrets();
    const documented = loginAnswerSchema.parse({
      first_login: false,
      user_token: sessionToken,
      chat_token: {
        IdentityId: "eu-west-1:test-identity-1",
        Token: chatToken,
        $metadata: { httpStatusCode: 200, requestId: "test-request-1", attempts: 1, totalRetryDelay: 0 },
      },
    });
    expect(documented.user_token).toBe(sessionToken);
    expect(documented.chat_token).toEqual({ IdentityId: "eu-west-1:test-identity-1", Token: chatToken });
    expect(loginAnswerSchema.parse({ user_token: sessionToken }).chat_token).toBeUndefined();
    expect(loginAnswerSchema.parse({ user_token: sessionToken, chat_token: chatToken }).chat_token).toBe(chatToken);
    const missing = loginAnswerSchema.safeParse({ first_login: false, chat_token: { Token: chatToken } });
    expect(missing.success).toBe(false);
    if (missing.success) throw new Error("unreachable");
    expect(schemaFailureMessage(missing.error)).toContain("user_token");
  });
});
