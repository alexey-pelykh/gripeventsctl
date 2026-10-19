// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

import { PathSequencer } from "./src/lib/sequencer.js";

/**
 * Live suite (`pnpm test:e2e`). Collects `*.e2e.test.ts` only when `GRIPEVENTSCTL_E2E=1`; the
 * files run one at a time, in path order, so the run never overlaps requests against the user's own
 * session. The order comes from `PathSequencer`: Vitest's default sequencer orders files by cached
 * failures, duration and size. Otherwise it collects nothing and `--passWithNoTests` exits 0.
 */
const isE2E = process.env["GRIPEVENTSCTL_E2E"] === "1";

export default defineConfig({
  test: {
    include: isE2E ? ["src/**/*.e2e.test.ts"] : [],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
      shuffle: false,
      sequencer: PathSequencer,
    },
  },
});
