// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command } from "commander";

import { packageVersion } from "./lib/package-version.js";

export const PROGRAM_NAME = "gripeventsctl";

/**
 * Build the Commander program. Commands register here as they land; the umbrella package
 * handles `gripeventsctl mcp` before this program sees argv.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      "Unofficial CLI for Grip-hosted event apps: attendee directory, profiles, interest swipes, chat and meetings",
    )
    .version(packageVersion(), "-v, --version", "print the version");
  return program;
}
