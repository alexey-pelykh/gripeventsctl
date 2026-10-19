// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `liveSession()`: the session the maintainer signed in with `gripeventsctl auth signin`, read through
 * `loadConfig()` from the environment as the process has it (`GRIPEVENTSCTL_CONFIG_FILE` honoured). It
 * never writes the config, never resolves the token (the client does, through the store) and never
 * prints the token, the slug or the container id. No config or no session is one error, whose message
 * is `NO_SESSION_MESSAGE`; every live file turns it into `inconclusive`.
 */

import { type Config, type Session, derivedPaths, loadConfig } from "@gripeventsctl/core";

export interface LiveSession {
  configPath: string;
  config: Config;
  session: Session;
  containerId: number;
  slug: string;
  writesEnabled: boolean;
  sendLogPath: string;
  journalPath: string;
}

export const NO_SESSION_MESSAGE = "no session: run gripeventsctl auth signin <slug> first";

export async function liveSession(env: NodeJS.ProcessEnv = process.env): Promise<LiveSession> {
  const loaded = await loadConfig({ env });
  const session = loaded.config.session;
  if (!loaded.exists || session === undefined) throw new Error(NO_SESSION_MESSAGE);
  const paths = derivedPaths(loaded.path, loaded.config);
  return {
    configPath: loaded.path,
    config: loaded.config,
    session,
    containerId: session.container_id,
    slug: session.slug,
    writesEnabled: loaded.config.writes.enabled,
    sendLogPath: paths.sendLog,
    journalPath: paths.goAheads,
  };
}
