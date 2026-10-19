// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The write lock (issue #16 § The write lock): a `proper-lockfile` lock on `derivedPaths().writeLock`, created by the
 * opening rule on first use. `withWriteLock(path, fn)` takes the lock with `realpath: false`, `stale: 10000` (the
 * library's default) and five one-second retries, runs `fn`, and releases in `finally`. A lock that cannot be taken
 * after the retries is reported as busy, never thrown: the gate turns it into the `write-busy` refusal. The lock is
 * held from the repeat guard to the send log append of one write, including any 429 wait inside the POST; the library
 * refreshes the lock's mtime every `stale / 2` ms while the process lives, so a 300-second wait keeps it, and a second
 * writer waits for the lock, then runs its own guard over the updated log. This is the dedicated lock of the writes:
 * the config's lock is for `saveConfig()`, and a write must not block a sign-in.
 */

import { lock as lockFile } from "proper-lockfile";

import { ConfigError } from "../transport/errors.js";
import { type AppendFs, openAppendOnly } from "./files.js";

/** The lock options: the file may not exist yet, the default staleness, five one-second retries. */
export const WRITE_LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 5, minTimeout: 1000, maxTimeout: 1000 },
  onCompromised: (): void => undefined,
} as const;

/** The lock operation the module uses; `proper-lockfile`'s `lock` satisfies it and a test injects a fake. */
export type WriteLockFn = (path: string, options: typeof WRITE_LOCK_OPTIONS) => Promise<() => Promise<void>>;

/** What `withWriteLock` answers: the value of `fn` under the lock, or that the lock was busy and `fn` never ran. */
export type WriteLockOutcome<T> = { taken: true; value: T } | { taken: false };

export interface WriteLockOptions {
  lock?: WriteLockFn;
  fs?: AppendFs;
}

/** True where `error` is the library's refusal after the retries: another process holds the lock. */
function isLocked(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "ELOCKED";
}

/**
 * Run `fn` under the write lock at `path`. The lock file is created by the opening rule first (mode `0600`, never
 * through a symbolic link). Busy after the retries: `{ taken: false }` and `fn` never ran. Any other failure to lock
 * is the `config` kind naming the path.
 */
export async function withWriteLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: WriteLockOptions = {},
): Promise<WriteLockOutcome<T>> {
  const handle = await openAppendOnly(path, options.fs);
  await handle.close();
  let release: () => Promise<void>;
  try {
    release = await (options.lock ?? lockFile)(path, WRITE_LOCK_OPTIONS);
  } catch (error: unknown) {
    if (isLocked(error)) return { taken: false };
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot take the write lock ${path}: ${message}`, "check the file and its directory", {
      cause: error,
    });
  }
  try {
    return { taken: true, value: await fn() };
  } finally {
    await release();
  }
}
