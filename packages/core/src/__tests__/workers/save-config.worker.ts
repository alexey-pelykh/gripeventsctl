// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// The child of config-concurrency.test.ts: one process saving one config through the built core,
// as a CLI and an MCP server on one machine would. Run with `node save-config.worker.ts <slug> <token>`
// and GRIPEVENTSCTL_CONFIG_FILE set; Node strips the types itself (erasable syntax only in here).

import { saveConfig } from "@gripeventsctl/core";

const [slug, token] = process.argv.slice(2);
if (slug === undefined || token === undefined) {
  process.stderr.write("usage: save-config.worker.ts <slug> <token>\n");
  process.exit(2);
}

await saveConfig({
  version: 1,
  session: { slug, container_id: 1, token, signed_in_at: "2026-10-12T12:00:00Z" },
  writes: { enabled: false },
});
process.stdout.write(`saved ${slug}\n`);
