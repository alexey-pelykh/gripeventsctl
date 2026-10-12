// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** Env var that opts a run into the live suite. Unset: `pnpm test:e2e` collects nothing. */
export const E2E_ENV_VAR = "GRIPEVENTSCTL_E2E";

export function isE2EEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[E2E_ENV_VAR] === "1";
}
