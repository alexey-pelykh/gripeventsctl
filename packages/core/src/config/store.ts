// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The config store: `loadConfig()`, `saveConfig()`, the session helpers and the time records.
 *
 * Reads refuse a file that other users of the machine can read (mode bits for group or others
 * set, on POSIX) before the token is read. Writes are atomic and locked: a temporary file beside
 * the target is created exclusively at mode 0600 before any byte is written, then renamed over
 * the target, under a `proper-lockfile` lock shared with every other gripeventsctl process, and
 * an in-process queue so two writers in one process never race for the lock. `saveConfig()`
 * replaces the file without reading it, so a file that cannot be loaded can still be rewritten
 * whole; the session helpers read it first, so they keep `auth` and `writes` and refuse a file
 * they cannot load.
 *
 * The store is reachable through `ConfigStore`, so a later live probe can pass an in-memory store
 * to `saveSession()`, `clearSession()` and `recordAuthFailure()` instead of the file-backed one
 * `createConfigStore()` builds from the environment.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { dirname } from "node:path";

import { lock as lockFile } from "proper-lockfile";
import { LineCounter, parseDocument, stringify as stringifyYaml } from "yaml";

import { type Clock, isoSeconds, systemClock } from "../lib/clock.js";
import { registerSecret } from "../lib/redact.js";
import { ConfigError, GripError, NoSessionError } from "../transport/errors.js";
import { OP_REFERENCE_PREFIX, type OpReadOptions, opRead } from "./op.js";
import { configPath as resolveConfigPath } from "./paths.js";
import { type Config, type Session, emptyConfig, parseConfig, toFileShape, validateConfig } from "./schema.js";

export const CONFIG_FILE_MODE = 0o600;
/** Mode bits that grant group or others any permission; a file with one set is refused. */
const SHARED_MODE_BITS = 0o077;
/** The file-type bits of an `lstat` mode, and the value of a regular file. */
const FILE_TYPE_BITS = 0o170000;
const REGULAR_FILE = 0o100000;
const SYMBOLIC_LINK = 0o120000;

const FIX_OR_DELETE = "fix the config file, or delete it and sign in again";

/**
 * `proper-lockfile` options: `realpath: false` because the locked file may not exist yet. A
 * compromised lock (its directory removed while held) is not fatal: the write goes on as if the
 * lock had been lost, instead of crashing the process from a timer.
 */
export const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 5, minTimeout: 200, maxTimeout: 1000 },
  onCompromised: (): void => undefined,
} as const;

/** The file handle operations a write uses; `node:fs/promises` `FileHandle` satisfies it. */
export interface StoreFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The file-system operations the store uses; `node:fs/promises` satisfies it and a test injects a spy. */
export interface StoreFs {
  lstat(path: string): Promise<{ mode: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  open(path: string, flags: "wx", mode: number): Promise<StoreFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** The lock operation the store uses; `proper-lockfile`'s `lock` satisfies it. */
export type LockFn = (path: string, options: typeof LOCK_OPTIONS) => Promise<() => Promise<void>>;

export interface StoreOptions {
  /** The environment the config path is resolved from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The platform the mode rules are chosen for; default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Testing seam: the file system the store reads and writes through. */
  fs?: StoreFs;
  /** Testing seam: the cross-process lock. */
  lock?: LockFn;
}

export interface LoadResult {
  config: Config;
  /** The resolved config path. */
  path: string;
  /** False when no file exists at the path; `config` is then the empty config. */
  exists: boolean;
  /** False on Windows, where the file inherits the user profile's access control list instead of mode 0600. */
  modeEnforced: boolean;
}

export interface ConfigStore {
  readonly path: string;
  readonly modeEnforced: boolean;
  load(): Promise<LoadResult>;
  /** Validate, then write atomically under the lock, without reading what the file held before. */
  save(config: Config): Promise<void>;
  /**
   * Under the lock: reload, apply `mutate` to the current state, and write the config it returns.
   * A mutator that returns `undefined` leaves the file untouched. A file that cannot be loaded is
   * refused with the `config` kind; `save()` is the way to replace it.
   */
  update(mutate: (current: LoadResult) => Config | undefined): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * Parse the file's YAML. The message of a failure names the position only: the library's own
 * pretty message quotes the offending source line, which may be the one holding the token.
 */
function parseConfigYaml(text: string, path: string): unknown {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false });
  const failure = document.errors[0];
  if (failure !== undefined) {
    const { line, col } = lineCounter.linePos(failure.pos[0]);
    throw new ConfigError(
      `cannot parse config file ${path}: ${failure.code} at line ${String(line)}, column ${String(col)}`,
      FIX_OR_DELETE,
    );
  }
  return document.toJS();
}

// One queue per path, so concurrent writers in one process take the file lock one after another.
const queues = new Map<string, Promise<void>>();

async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  try {
    return await run;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}

/** A file-backed store at the config path `options.env` resolves to. */
export function createConfigStore(options: StoreOptions = {}): ConfigStore {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fs: StoreFs = options.fs ?? nodeFs;
  const lock: LockFn = options.lock ?? lockFile;
  const path = resolveConfigPath(env);
  const modeEnforced = platform !== "win32";

  async function load(): Promise<LoadResult> {
    let mode: number;
    try {
      mode = (await fs.lstat(path)).mode;
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return { config: emptyConfig(), path, exists: false, modeEnforced };
      throw new ConfigError(`cannot read config file ${path}: ${errorMessage(error)}`, "", { cause: error });
    }
    const fileType = mode & FILE_TYPE_BITS;
    if (fileType === SYMBOLIC_LINK) {
      throw new ConfigError(
        `config file ${path} is a symbolic link; the config must be a regular file`,
        `point GRIPEVENTSCTL_CONFIG_FILE at the file the link resolves to`,
      );
    }
    if (fileType !== REGULAR_FILE) {
      throw new ConfigError(`config file ${path} is not a regular file`, FIX_OR_DELETE);
    }
    if (modeEnforced && (mode & SHARED_MODE_BITS) !== 0) {
      throw new ConfigError(
        `config file ${path} has mode ${octal(mode)}; it must not be readable by other users of this machine`,
        `chmod 600 ${path}`,
      );
    }
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error: unknown) {
      throw new ConfigError(`cannot read config file ${path}: ${errorMessage(error)}`, "", { cause: error });
    }
    return { config: parseConfig(parseConfigYaml(text, path), path), path, exists: true, modeEnforced };
  }

  async function acquireLock(): Promise<() => Promise<void>> {
    try {
      return await lock(path, LOCK_OPTIONS);
    } catch (error: unknown) {
      throw new ConfigError(
        `cannot lock config file ${path}: ${errorMessage(error)}`,
        `another gripeventsctl process holds ${path}.lock; retry, or remove that directory if no process is running`,
        { cause: error },
      );
    }
  }

  async function writeAtomically(config: Config): Promise<void> {
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    let handle: StoreFileHandle | undefined;
    try {
      // Exclusive create at mode 0600 before any byte is written: the token never sits in a file
      // other users can read, not even between a write and a chmod.
      handle = await fs.open(temporary, "wx", CONFIG_FILE_MODE);
      await handle.writeFile(stringifyYaml(toFileShape(config)), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, path);
    } catch (error: unknown) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      if (error instanceof GripError) throw error;
      throw new ConfigError(`cannot write config file ${path}: ${errorMessage(error)}`, "", { cause: error });
    }
  }

  /** Take the lock around `task`; a failure to release never masks what `task` threw. */
  async function locked(task: () => Promise<void>): Promise<void> {
    await serialized(path, async () => {
      try {
        await fs.mkdir(dirname(path), { recursive: true });
      } catch (error: unknown) {
        throw new ConfigError(`cannot create the directory of ${path}: ${errorMessage(error)}`, "", { cause: error });
      }
      const release = await acquireLock();
      try {
        await task();
      } finally {
        await release().catch(() => undefined);
      }
    });
  }

  return {
    path,
    modeEnforced,
    load,
    async save(config) {
      validateConfig(config);
      await locked(() => writeAtomically(config));
    },
    async update(mutate) {
      await locked(async () => {
        const next = mutate(await load());
        if (next === undefined) return;
        await writeAtomically(validateConfig(next));
      });
    },
  };
}

/** Load the config at the resolved path; the empty config with `exists: false` when no file is there. */
export function loadConfig(options: StoreOptions = {}): Promise<LoadResult> {
  return createConfigStore(options).load();
}

/** Validate `config` and write it atomically at mode 0600 under the lock, replacing whatever the file held. */
export function saveConfig(config: Config, options: StoreOptions = {}): Promise<void> {
  return createConfigStore(options).save(config);
}

export interface SessionOptions extends StoreOptions {
  /** The clock `signed_in_at` and `auth_failed_at` are read from; default the system clock. */
  clock?: Clock;
  /** The store to update; default the file-backed store `createConfigStore(options)` builds. */
  store?: ConfigStore;
}

function storeFor(options: SessionOptions): ConfigStore {
  return options.store ?? createConfigStore(options);
}

/**
 * Store the session the sign-in command captured: `signed_in_at` is set from the clock, any
 * `auth_failed_at` is dropped, any existing session is replaced. `auth` and `writes` are kept,
 * so a file that cannot be loaded is refused rather than overwritten.
 */
export async function saveSession(
  session: Omit<Session, "signed_in_at" | "auth_failed_at">,
  options: SessionOptions = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  await storeFor(options).update(({ config }) => ({
    ...config,
    session: {
      slug: session.slug,
      container_id: session.container_id,
      token: session.token,
      signed_in_at: isoSeconds(clock.now()),
    },
  }));
}

/** Remove the session; `auth` and `writes` stay as they are. */
export async function clearSession(options: SessionOptions = {}): Promise<void> {
  await storeFor(options).update(({ config }) => {
    const next: Config = { version: config.version, writes: config.writes };
    if (config.auth !== undefined) next.auth = config.auth;
    return next;
  });
}

/**
 * Record the first authentication failure: `session.auth_failed_at` is set from the clock only
 * when it is absent (the first failure is the measurement; later failures do not move it). With
 * no session, nothing is written.
 */
export async function recordAuthFailure(options: SessionOptions = {}): Promise<void> {
  const clock = options.clock ?? systemClock;
  await storeFor(options).update(({ config }) => {
    if (config.session === undefined || config.session.auth_failed_at !== undefined) return undefined;
    return { ...config, session: { ...config.session, auth_failed_at: isoSeconds(clock.now()) } };
  });
}

export interface ResolveSessionTokenOptions extends OpReadOptions {
  /** The environment whose `OP_*` variables reach the 1Password CLI; default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The session token: `session.token` itself, or the value an `op://` field reference resolves to
 * through the 1Password CLI. Either way the value is registered as a secret and never stored.
 */
export async function resolveSessionToken(config: Config, options: ResolveSessionTokenOptions = {}): Promise<string> {
  const session = config.session;
  if (session === undefined) throw new NoSessionError();
  if (!session.token.startsWith(OP_REFERENCE_PREFIX)) {
    registerSecret(session.token);
    return session.token;
  }
  const readOptions: OpReadOptions = options.execFile === undefined ? {} : { execFile: options.execFile };
  return opRead(session.token, options.env ?? process.env, readOptions);
}
