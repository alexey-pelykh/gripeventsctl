// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * Unit tests of the harness itself (`pnpm test`): no live session. The live suite is collected
 * only by the sibling `vitest.e2e.config.ts`, gated by `GRIPEVENTSCTL_E2E=1`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    testTimeout: 15_000,
  },
});
