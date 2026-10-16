// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Test-only child for `spawnMcpStdio()`: writes one non-protocol line to stdout, which breaks the
 * client's frame parser, then stays alive until the parent closes it.
 */

process.stdout.write("not a protocol frame\n");
process.stdin.resume();
setTimeout(() => process.exit(0), 30_000).unref();
