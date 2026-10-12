#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Validates that all production dependency licenses are compatible with AGPL-3.0-only.
 *
 * Uses `pnpm -r licenses list --prod --json`: recursive, so every workspace package's
 * production dependencies are listed (the root has none), while the workspace packages
 * themselves are excluded. Without `-r` pnpm 12 reports an empty map at the root and the
 * check would pass blind.
 *
 * Handles SPDX compound expressions: `(A OR B)` passes if ANY operand is allowed;
 * `(A AND B)` passes only if ALL operands are allowed. Parentheses optional.
 *
 * Exit codes:
 *   0 — all licenses are on the allow-list
 *   1 — one or more licenses are not on the allow-list
 */

import { execSync } from "node:child_process";

const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "MPL-2.0",
]);

/**
 * Evaluates a flat SPDX expression against the allow-list.
 *
 * Supports the two compound forms pnpm emits in practice:
 *   - `(A OR B OR C)` — passes when ANY operand is allowed (consumer chooses)
 *   - `(A AND B)` — passes only when ALL operands are allowed (compound license)
 *
 * Nested parentheses, WITH clauses, and exception identifiers are NOT supported;
 * adding `spdx-expression-parse` is the right move once a real case appears.
 */
function isAllowed(license) {
  if (ALLOWED_LICENSES.has(license)) return true;
  const stripped = license.replace(/^\(|\)$/g, "").trim();
  if (stripped.includes(" OR ")) {
    return stripped.split(/\s+OR\s+/).some((operand) => ALLOWED_LICENSES.has(operand.trim()));
  }
  if (stripped.includes(" AND ")) {
    return stripped.split(/\s+AND\s+/).every((operand) => ALLOWED_LICENSES.has(operand.trim()));
  }
  return false;
}

const output = execSync("pnpm -r licenses list --prod --json", {
  encoding: "utf-8",
});
const licenseMap = JSON.parse(output);

const violations = [];
for (const [license, packages] of Object.entries(licenseMap)) {
  if (!isAllowed(license)) {
    for (const pkg of packages) {
      violations.push({ name: pkg.name, version: pkg.versions.join(", "), license });
    }
  }
}

if (violations.length > 0) {
  console.error("License compatibility check FAILED.\n");
  console.error("The following production dependencies have licenses not on the allow-list:\n");
  for (const v of violations) {
    console.error(`  ${v.name}@${v.version} — ${v.license}`);
  }
  console.error(`\nAllowed licenses: ${[...ALLOWED_LICENSES].join(", ")}`);
  console.error(
    "\nIf a license is compatible with AGPL-3.0-only, add it to ALLOWED_LICENSES in scripts/check-licenses.js.",
  );
  process.exit(1);
} else {
  const total = Object.values(licenseMap).reduce((sum, pkgs) => sum + pkgs.length, 0);
  console.log(`License check passed: ${total} production dependencies, all using allowed licenses.`);
  console.log(`Licenses found: ${Object.keys(licenseMap).sort().join(", ")}`);
}
