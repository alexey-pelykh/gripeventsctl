// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `writes` group: `writes status` and `writes pending` are derived from the registry like every other leaf; the
 * hand-written `writes go-ahead` (issue #16) is registered here beside them, on the group command the derived leaves
 * created. A program built over operations without the two derived leaves (a test over one synthetic operation) has
 * no `writes` group and so no `writes go-ahead`.
 */

import type { Command } from "commander";

import type { CliContext } from "../../lib/context.js";
import { registerGoAhead } from "./go-ahead.js";

export const WRITES_GROUP = "writes";

export function registerWrites(program: Command, context: CliContext): void {
  const writes = program.commands.find((command) => command.name() === WRITES_GROUP);
  if (writes !== undefined) registerGoAhead(writes, context);
}
