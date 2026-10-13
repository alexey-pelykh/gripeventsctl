// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The paths the temporary-home guard watches, by the same rule `@gripeventsctl/core` applies:
 * the config file (`GRIPEVENTSCTL_CONFIG_FILE`, else `~/.gripeventsctl.yaml`), and beside it the
 * send log, the go-ahead journal and the write lock derived from the config path's prefix. The
 * rule is restated here because this package depends on no workspace package; the core test
 * `config-paths.test.ts` asserts the two rules agree, so a change to one fails until the other
 * follows.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CONFIG_FILE_NAME = ".gripeventsctl.yaml";

export interface GuardedPaths {
  config: string;
  sendLog: string;
  goAheads: string;
  writeLock: string;
}

/** The config path and the paths derived from it, for `env`. */
export function guardedPaths(env: NodeJS.ProcessEnv): GuardedPaths {
  const home = process.platform === "win32" ? env["USERPROFILE"] : env["HOME"];
  const override = env["GRIPEVENTSCTL_CONFIG_FILE"];
  let config: string;
  if (override === undefined || override === "") {
    config = join(home === undefined || home === "" ? homedir() : home, CONFIG_FILE_NAME);
  } else {
    config = isAbsolute(override) ? override : resolve(override);
  }
  const prefix = config.endsWith(".yaml") ? config.slice(0, -".yaml".length) : config;
  return {
    config,
    sendLog: `${prefix}.send-log.jsonl`,
    goAheads: `${prefix}.go-aheads.jsonl`,
    writeLock: `${prefix}.write.lock`,
  };
}
