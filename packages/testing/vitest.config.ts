// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * The helpers' own tests (`pnpm test`). The package names its own setup entry by its package name
 * (a self-reference through its `exports`), so this file has the shape every other package's has.
 * The `forks` pool is pinned so a test may change the working directory, which a worker thread
 * cannot. The live suite lives in `packages/e2e` only.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["@gripeventsctl/testing/setup"],
    pool: "forks",
    testTimeout: 15_000,
  },
});
