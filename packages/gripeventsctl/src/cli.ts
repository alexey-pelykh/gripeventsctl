#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { buildProgram } from "@gripeventsctl/cli";
import { runMcpStdio } from "@gripeventsctl/mcp";

/**
 * Umbrella entry point: `gripeventsctl mcp` starts the MCP server over stdio; everything else
 * goes to the Commander program. The MCP branch comes first so Commander never parses its argv.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "mcp") {
    await runMcpStdio(buildProgram().version());
    return;
  }
  await buildProgram().parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
