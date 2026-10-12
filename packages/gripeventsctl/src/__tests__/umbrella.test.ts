// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { buildProgram, buildServer } from "../index.js";

describe("umbrella", () => {
  it("re-exports the CLI program and the MCP server builders", () => {
    expect(buildProgram().name()).toBe("gripeventsctl");
    expect(buildServer()).toBeDefined();
  });
});
