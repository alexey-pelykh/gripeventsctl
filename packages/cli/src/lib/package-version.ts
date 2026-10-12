// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { createRequire } from "node:module";

/**
 * The version of this package, read from its package.json at run time so `--version` reports
 * what was installed rather than what was compiled. Resolved from this module's own location
 * (`src/lib/` in development, `dist/lib/` when built), which sits two levels below the manifest.
 */
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest: unknown = require("../../package.json");
  if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
    const version = manifest.version;
    if (typeof version === "string") return version;
  }
  return "0.0.0";
}
