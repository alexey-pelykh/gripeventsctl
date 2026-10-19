// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `probeStore()`: an isolated config for the auth probe (`05-auth-probe`), so a wrong token can go
 * through a real `GripClient` without the client's `recordAuthFailure()` writing `auth_failed_at` into
 * the maintainer's config.
 *
 * Issue #18 specifies an in-memory `ConfigStore` the client is built over. The landed client
 * (`@gripeventsctl/core`, issue #5) has no store option: it reads the config file the environment it
 * is given names, and records a 401 through a file-backed store at that same path. So the isolation
 * runs through the config-path seam instead: a config with the real session's `slug` and
 * `container_id`, the given token and writes off, written by core's own writer at mode 0600 into a
 * fresh temporary directory, and an environment whose `HOME`, `USERPROFILE` and
 * `GRIPEVENTSCTL_CONFIG_FILE` point there. A client built with that environment reads and records in
 * that directory only; `remove()` deletes it. The maintainer's config is never opened.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_FILE_ENV,
  CONFIG_VERSION,
  type ConfigStore,
  DEFAULT_CONFIG_FILE_NAME,
  type Session,
  createConfigStore,
} from "@gripeventsctl/core";

export interface ProbeStore {
  /** The environment a client reads the probe config from: `base` with the three home variables redirected. */
  env: NodeJS.ProcessEnv;
  /** The probe config file, alone in a directory of its own. */
  path: string;
  /** The file-backed store over it, for a test that reads what a 401 recorded there. */
  store: ConfigStore;
  /** Remove the directory and everything in it. */
  remove(): Promise<void>;
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the form the config schema accepts. */
function nowSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

export async function probeStore(
  session: Pick<Session, "slug" | "container_id">,
  token: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<ProbeStore> {
  const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-e2e-probe-"));
  const path = join(dir, DEFAULT_CONFIG_FILE_NAME);
  const env: NodeJS.ProcessEnv = { ...base, HOME: dir, USERPROFILE: dir, [CONFIG_FILE_ENV]: path };
  const store = createConfigStore({ env });
  const remove = (): Promise<void> => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  try {
    await store.save({
      version: CONFIG_VERSION,
      session: { slug: session.slug, container_id: session.container_id, token, signed_in_at: nowSeconds() },
      writes: { enabled: false },
    });
  } catch (error: unknown) {
    await remove();
    throw error;
  }
  return { env, path, store, remove };
}
