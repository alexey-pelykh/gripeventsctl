// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { PROGRAM_NAME, buildProgram } from "../index.js";

describe("[CAP-OUTPUT] buildProgram", () => {
  it("names the program after the binary", () => {
    expect(buildProgram().name()).toBe(PROGRAM_NAME);
  });

  it("reports the package version", () => {
    const manifest = createRequire(import.meta.url)("../../package.json") as { version: string };
    expect(buildProgram().version()).toBe(manifest.version);
  });
});
