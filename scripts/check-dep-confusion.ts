#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Workspace dependency-confusion guard.
 *
 * Asserts that every `@gripeventsctl/*` dependency declared by any workspace
 * package resolves to a workspace-internal package (pnpm's `link:`
 * resolution), never to a public registry. A `@gripeventsctl/*` name resolving
 * to a registry version would mean either (a) someone published a
 * package under our scope without our involvement (dependency-confusion
 * attack), or (b) an internal `workspace:` ref got rewritten somewhere
 * along the build chain.
 *
 * The npm scope `@gripeventsctl` is NOT reserved by the maintainer of this
 * project on npmjs.com — anyone could publish `@gripeventsctl/anything` if they
 * registered the scope first. This guard is the defense.
 *
 * How it works:
 *   1. Run `pnpm ls --json --recursive --prod --depth=1` to enumerate
 *      every direct dependency declared by every workspace package.
 *   2. For each `@gripeventsctl/*` dep, assert the resolved `version` field
 *      starts with `link:` — pnpm's marker for workspace-internal
 *      resolution. A version like `1.2.3` or `^1.2.3` means it resolved
 *      to a published registry version, which is the failure mode.
 *
 * Why `--prod`:
 *   The devDependencies block can legitimately contain registry-shaped
 *   versions for tooling. The user-install surface (the one supply-chain
 *   attacks target) is what's installed via `npm install -g gripeventsctl`, which
 *   only pulls production deps. devDeps stay on the maintainer's
 *   machine and in CI.
 *
 * Why `--depth=1`:
 *   depth=0 lists only the workspace packages themselves with no
 *   dependency fields. depth=1 includes their direct deps. depth>1 would
 *   also include transitive deps, which we don't need — the only
 *   `@gripeventsctl/*` names we care about are the ones WE declare.
 *
 * Exit codes:
 *   0 — every `@gripeventsctl/*` dep resolves to a workspace-internal package
 *   1 — one or more `@gripeventsctl/*` deps resolve to a non-workspace version
 *
 * Wired into the root `lint` script (`package.json`) and runs on every
 * PR / push via `ci.yml`.
 */

import { execSync } from "node:child_process";

interface PnpmListPackage {
  name?: string;
  version?: string;
  path?: string;
  private?: boolean;
  dependencies?: Record<string, PnpmListDependency>;
}

interface PnpmListDependency {
  version?: string;
  path?: string;
  resolved?: string;
}

interface Finding {
  declaredBy: string;
  depName: string;
  resolvedVersion: string;
}

function listWorkspaceProdDeps(): PnpmListPackage[] {
  const stdout = execSync("pnpm ls --json --recursive --prod --depth=1", {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("pnpm ls did not return a JSON array");
  }
  return parsed as PnpmListPackage[];
}

function findOffenders(packages: PnpmListPackage[]): Finding[] {
  const findings: Finding[] = [];
  for (const pkg of packages) {
    const pkgName = pkg.name ?? "<unnamed>";
    const deps = pkg.dependencies ?? {};
    for (const [depName, info] of Object.entries(deps)) {
      if (!depName.startsWith("@gripeventsctl/")) continue;
      const version = info.version ?? "";
      if (!version.startsWith("link:")) {
        findings.push({
          declaredBy: pkgName,
          depName,
          resolvedVersion: version || "<empty>",
        });
      }
    }
  }
  return findings;
}

function main(): void {
  const packages = listWorkspaceProdDeps();
  const findings = findOffenders(packages);
  if (findings.length === 0) {
    const gripeventsctlDepCount = packages.reduce((acc, pkg) => {
      const deps = pkg.dependencies ?? {};
      return acc + Object.keys(deps).filter((d) => d.startsWith("@gripeventsctl/")).length;
    }, 0);
    console.log(
      `[check-dep-confusion] OK — ${String(gripeventsctlDepCount)} @gripeventsctl/* dep(s) all resolve to workspace.`,
    );
    return;
  }
  console.error("[check-dep-confusion] FAIL — @gripeventsctl/* deps resolving outside the workspace:");
  for (const f of findings) {
    console.error(`  ${f.declaredBy} → ${f.depName} @ ${f.resolvedVersion}`);
  }
  console.error("");
  console.error("Workspace-internal deps MUST use `workspace:^` (or `workspace:*`) in package.json.");
  console.error("A registry-shaped version on an `@gripeventsctl/*` name means either:");
  console.error("  (a) someone published under the @gripeventsctl scope without our involvement, or");
  console.error("  (b) a workspace ref got rewritten somewhere along the build chain.");
  console.error("Investigate before merging.");
  process.exit(1);
}

main();
