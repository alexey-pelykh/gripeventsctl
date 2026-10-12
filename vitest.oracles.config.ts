// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * The pre-authored oracle files (`*.oracle.test.ts`) in strict mode: a file whose subject module is
 * missing fails instead of skipping. `pnpm test` collects the same files in ordinary mode, where a
 * missing subject skips them. This config is run by `pnpm test:oracles` only.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.oracle.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    env: { GRIPEVENTSCTL_ORACLES: "strict" },
    testTimeout: 15_000,
    passWithNoTests: true,
  },
});
