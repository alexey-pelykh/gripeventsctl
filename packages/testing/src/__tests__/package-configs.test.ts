// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The shape of every package's `vitest.config.ts` and of the manifests that bind the test helpers:
 * each config names the setup entry, includes `src/**\/*.test.ts` and excludes `*.e2e.test.ts`;
 * each package that uses the helpers lists them as a `workspace:^` dev dependency; the testing
 * package stays private, takes its dependencies from the catalog and depends on no workspace
 * package; the live config keeps its `GRIPEVENTSCTL_E2E` gate and no setup file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../stdio-harness.js";

const ROOT = repositoryRoot();
const PACKAGES = ["core", "cli", "mcp", "gripeventsctl", "e2e", "testing"] as const;

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest(pkg: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8")) as Manifest;
}

function configText(pkg: string, file = "vitest.config.ts"): string {
  return readFileSync(join(ROOT, "packages", pkg, file), "utf8");
}

describe("[CAP-TEST-TOOLING] the package test configs and manifests", () => {
  for (const pkg of PACKAGES) {
    it(`packages/${pkg}/vitest.config.ts names the setup entry, includes src tests and excludes live tests`, () => {
      const text = configText(pkg);
      expect(text).toContain('setupFiles: ["@gripeventsctl/testing/setup"]');
      expect(text).toContain('include: ["src/**/*.test.ts"]');
      expect(text).toMatch(/exclude: \[[^\]]*"\*\*\/\*\.e2e\.test\.ts"[^\]]*\]/u);
      expect(text.startsWith("// SPDX-License-Identifier: AGPL-3.0-only\n// Copyright (C) 2026 Oleksii PELYKH\n")).toBe(
        true,
      );
    });
  }

  for (const pkg of PACKAGES.filter((name) => name !== "testing")) {
    it(`packages/${pkg} lists @gripeventsctl/testing as a workspace:^ dev dependency`, () => {
      expect(manifest(pkg).devDependencies?.["@gripeventsctl/testing"]).toBe("workspace:^");
      expect(manifest(pkg).dependencies?.["@gripeventsctl/testing"]).toBeUndefined();
    });
  }

  it("the testing package is private, depends on undici and the MCP SDK from the catalog, and on no workspace package", () => {
    const testing = manifest("testing");
    expect(testing.private).toBe(true);
    const all = { ...testing.dependencies, ...testing.devDependencies };
    expect(all["undici"]).toBe("catalog:");
    expect(all["@modelcontextprotocol/sdk"]).toBe("catalog:");
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toBe("catalog:");
      expect(name.startsWith("@gripeventsctl/"), name).toBe(false);
      expect(name, name).not.toBe("gripeventsctl");
    }
  });

  it("the testing package exports its setup entry from dist", () => {
    const text = readFileSync(join(ROOT, "packages", "testing", "package.json"), "utf8");
    const exports = (JSON.parse(text) as { exports: Record<string, { import: string }> }).exports;
    expect(exports["./setup"]?.import).toBe("./dist/setup.js");
  });

  it("the live config keeps its GRIPEVENTSCTL_E2E gate and no setup file", () => {
    const text = configText("e2e", "vitest.e2e.config.ts");
    expect(text).toContain('const isE2E = process.env["GRIPEVENTSCTL_E2E"] === "1";');
    expect(text).toContain('include: isE2E ? ["src/**/*.e2e.test.ts"] : [],');
    expect(text).not.toContain("setupFiles");
  });
});
