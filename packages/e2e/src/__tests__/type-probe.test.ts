// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { TYPE_PROBE_BOUND, TYPE_PROBE_PACE_MS, collectTypeIds, configuredTypeId } from "../lib/type-probe.js";

describe("[CAP-E2E] the type probe", () => {
  it("fixes the bound and the pace a reviewer reads", () => {
    expect(TYPE_PROBE_BOUND).toBe(8);
    expect(TYPE_PROBE_PACE_MS).toBe(1_500);
  });

  it("collects every id-named integer and every all-digit key, at any depth, in document order, once", () => {
    const permissions = {
      attendee: { type_id: 5, can_view: true },
      list: [{ id: 7, name: "Type 7" }, { id: 5 }, { thing_type_id: 9 }],
      "11": { id: 11, nested: { type_id: 13 } },
      noise: { id: "15", count: 1_000, zero: 0, negative: -3 },
    };
    expect(collectTypeIds(permissions)).toEqual([11, 13, 5, 7, 9]);
    expect(collectTypeIds(null)).toEqual([]);
    expect(collectTypeIds("text")).toEqual([]);
    expect(collectTypeIds({})).toEqual([]);
    expect(collectTypeIds([{ id: 2 }, { id: 2 }])).toEqual([2]);
  });

  it("reads GRIPEVENTSCTL_E2E_TYPE_ID as a positive integer, unset as undefined and anything else as null", () => {
    expect(configuredTypeId({})).toBeUndefined();
    expect(configuredTypeId({ GRIPEVENTSCTL_E2E_TYPE_ID: "" })).toBeUndefined();
    expect(configuredTypeId({ GRIPEVENTSCTL_E2E_TYPE_ID: "42" })).toBe(42);
    expect(configuredTypeId({ GRIPEVENTSCTL_E2E_TYPE_ID: "0" })).toBeNull();
    expect(configuredTypeId({ GRIPEVENTSCTL_E2E_TYPE_ID: "4x" })).toBeNull();
    expect(configuredTypeId({ GRIPEVENTSCTL_E2E_TYPE_ID: "-1" })).toBeNull();
  });
});
