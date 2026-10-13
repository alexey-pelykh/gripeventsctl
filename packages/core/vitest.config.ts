// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * Unit tests (`pnpm test`). The setup file of `@gripeventsctl/testing` points `HOME`,
 * `USERPROFILE` and `GRIPEVENTSCTL_CONFIG_FILE` at a temporary directory for every test file and
 * fails a test that reaches outside it. The live suite lives in `packages/e2e` only.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["@gripeventsctl/testing/setup"],
    testTimeout: 15_000,
  },
});
