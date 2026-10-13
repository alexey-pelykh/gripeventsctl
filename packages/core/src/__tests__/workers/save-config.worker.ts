// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// The child of config-concurrency.test.ts: one process writing the config through the built core
// (`@gripeventsctl/core` resolves to this package's own `dist`, so the test needs a build first;
// `pnpm test` builds before it tests), as a CLI and an MCP server on one machine would. Node
// strips the types itself, so only erasable syntax is used here. GRIPEVENTSCTL_CONFIG_FILE names
// the file.
//
//   save <slug> <token>      saveConfig() with a session for <slug>
//   merge <field> <holdMs>   update(): hold the lock for <holdMs>, then set `writes.enabled`
//                            (<field> = writes) or `auth.credentials` (<field> = auth)

import { createConfigStore, saveConfig } from "@gripeventsctl/core";

const [mode, first, second] = process.argv.slice(2);

function usage(): never {
  process.stderr.write("usage: save-config.worker.ts save <slug> <token> | merge <writes|auth> <holdMs>\n");
  process.exit(2);
}

if (mode === "save" && first !== undefined && second !== undefined) {
  await saveConfig({
    version: 1,
    session: { slug: first, container_id: 1, token: second, signed_in_at: "2026-10-12T12:00:00Z" },
    writes: { enabled: false },
  });
  process.stdout.write(`saved ${first}\n`);
} else if (mode === "merge" && (first === "writes" || first === "auth") && second !== undefined) {
  const holdMs = Number(second);
  await createConfigStore().update(({ config }) => {
    // Hold the lock long enough for the sibling process to be waiting on it.
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      // busy wait
    }
    return first === "writes"
      ? { ...config, writes: { ...config.writes, enabled: true } }
      : { ...config, auth: { credentials: "op://Vault/Item" } };
  });
  process.stdout.write(`merged ${first}\n`);
} else {
  usage();
}
