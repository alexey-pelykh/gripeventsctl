// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { REDACTED } from "@gripeventsctl/core";
import { fixtureSecrets } from "@gripeventsctl/testing";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  type Concluder,
  classify,
  conclude,
  drift,
  elementMismatches,
  errorKind,
  fieldAt,
  inconclusive,
  typeMismatches,
} from "../lib/outcome.js";

function ok(structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: "" }], structuredContent };
}

function failed(kind: string): CallToolResult {
  const report = { error: { kind, message: `synthetic ${kind}`, hint: "" } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report };
}

class Skipped extends Error {}

/** A test context whose `skip` throws, as Vitest's does. */
const ctx: Concluder = {
  skip(note?: string): never {
    throw new Skipped(note);
  },
};

describe("[CAP-E2E] classify()", () => {
  it("is verified for a non-error result carrying every named field, at any depth", () => {
    const result = ok({ slug_found: true, display_name: "Test Event 1", plan: { request: { method: "POST" } } });
    expect(classify(result, ["slug_found", "display_name", "plan.request.method"])).toEqual({ outcome: "verified" });
    expect(classify(ok({ items: [] }), ["items"])).toEqual({ outcome: "verified" });
  });

  it("is contract drift naming the missing field, and only its name", () => {
    const secrets = fixtureSecrets();
    const result = ok({ name: "Test Person 1", user_token: secrets.sessionToken, status: null });
    const classification = classify(result, ["name", "status.value", "message_id"]);
    expect(classification.outcome).toBe("contract-drift");
    expect(classification.fields).toEqual(["status.value", "message_id"]);
    expect(classification.reason).toBe("missing field: status.value, message_id");
    expect(classification.reason).not.toContain("Test Person");
    expect(classification.reason).not.toContain(secrets.sessionToken);
  });

  it("is contract drift for a result with no structured content", () => {
    expect(classify({ content: [{ type: "text", text: "" }] }, ["x"]).outcome).toBe("contract-drift");
  });

  it("is inconclusive for no-session, network, auth-failed and throttled", () => {
    for (const kind of ["no-session", "network", "auth-failed", "throttled"]) {
      expect(classify(failed(kind), []), kind).toEqual({
        outcome: "inconclusive",
        reason: `the tool answered ${kind}`,
      });
    }
  });

  it("is contract drift naming the kind for api, gated-type, load-balancer-rejected and any other kind", () => {
    for (const kind of ["api", "gated-type", "load-balancer-rejected", "usage", "config"]) {
      expect(classify(failed(kind), []), kind).toEqual({
        outcome: "contract-drift",
        reason: `the tool answered the error kind ${kind}`,
      });
    }
    expect(classify({ isError: true, content: [] }, []).reason).toBe("the tool answered the error kind <no kind>");
  });
});

describe("[CAP-E2E] conclude()", () => {
  it("skips an inconclusive check with the reason, never passing it", () => {
    expect(() => {
      conclude(ctx, "inconclusive", "no thread");
    }).toThrow(Skipped);
    expect(() => {
      conclude(ctx, "inconclusive", "no thread");
    }).toThrow("inconclusive: no thread");
    expect(() => inconclusive(ctx, "no type")).toThrow("inconclusive: no type");
  });

  it("fails a contract drift with the message", () => {
    expect(() => {
      conclude(ctx, "contract-drift", "missing field: id");
    }).toThrow("contract drift: missing field: id");
    expect(() => drift("missing field: id")).toThrow("contract drift: missing field: id");
  });

  it("returns for verified", () => {
    expect(conclude(ctx, "verified")).toBeUndefined();
  });

  it("redacts a secret-shaped value in a reason on both paths", () => {
    const token = fixtureSecrets().sessionToken;
    const reason = `x user_token: ${token}`;
    expect(() => inconclusive(ctx, reason)).toThrow(REDACTED);
    expect(() => inconclusive(ctx, reason)).not.toThrow(token);
    expect(() => drift(reason)).toThrow(REDACTED);
    expect(() => drift(reason)).not.toThrow(token);
  });
});

describe("[CAP-E2E] the field helpers", () => {
  it("read a dotted path and the error kind", () => {
    expect(fieldAt({ a: { b: [1] } }, "a.b")).toEqual([1]);
    expect(fieldAt({ a: null }, "a.b")).toBeUndefined();
    expect(errorKind(failed("network"))).toBe("network");
    expect(errorKind(ok({}))).toBeUndefined();
  });

  it("name the fields whose type differs from the documented one, and the elements by index", () => {
    const content = { id: 1, name: null, active: true, items: [], plan: { x: 1.5 } };
    expect(
      typeMismatches(content, {
        id: "integer",
        name: "string",
        active: "boolean",
        items: "array",
        "plan.x": "integer",
      }),
    ).toEqual(["name", "plan.x"]);
    expect(typeMismatches(content, { plan: "object", name: "present", missing: "present" })).toEqual([
      "name",
      "missing",
    ]);
    expect(elementMismatches([{ id: 1 }, { id: "2" }, { message: "m" }], { id: "integer" })).toEqual([
      "[1].id",
      "[2].id",
    ]);
    expect(elementMismatches([], { id: "integer" })).toEqual([]);
  });
});
