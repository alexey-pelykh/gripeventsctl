// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * The root run (`pnpm test:coverage`): one project per package, plus the script self-tests.
 * A package with its own `vitest.config.ts` runs under it, so core, cli, mcp and the umbrella carry
 * the temporary-home guard of `@gripeventsctl/testing` here too; testing runs on the defaults.
 * `pnpm test` runs the packages through Turborepo instead.
 */
export default defineConfig({
  test: {
    projects: ["packages/*", { test: { name: "scripts", include: ["scripts/**/*.test.ts"] } }],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    coverage: {
      provider: "v8",
      all: true,
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.e2e.test.ts",
        "**/*.d.ts",
        "**/testing/**",
        "**/tools/index.ts",
        "**/__generated__/**",
      ],
    },
  },
});
