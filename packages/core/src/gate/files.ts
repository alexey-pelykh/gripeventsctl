// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The opening rule of the three local files of the write gate (issue #16 § The three local files): the send log, the
 * go-ahead journal and the write lock are opened with `O_APPEND | O_CREAT | O_WRONLY`, mode `0o600`, and `O_NOFOLLOW`
 * where `fs.constants.O_NOFOLLOW` is defined; where it is not (Windows), an `lstat` before the open refuses a symbolic
 * link. A refused symbolic link is the `config` kind naming the path, and the link's target is never written. The
 * flags travel as a number, not the string `"a"`, so the mode and `O_NOFOLLOW` apply at creation. A file created by
 * this rule is `0600` from creation on POSIX; on Windows it inherits the user profile's access control list, as the
 * config does.
 */

import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";

import { ConfigError } from "../transport/errors.js";

/** The mode every file of the gate is created with. */
export const GATE_FILE_MODE = 0o600;

/** What an opened append-only file offers the gate; `node:fs/promises` `FileHandle` satisfies it. */
export interface AppendHandle {
  write(data: string, position?: null, encoding?: "utf8"): Promise<unknown>;
  close(): Promise<void>;
}

/** The file-system operations the rule uses; `node:fs/promises` satisfies it and a test injects a spy. */
export interface AppendFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  open(path: string, flags: number, mode: number): Promise<AppendHandle>;
}

/** The flags constant of the platform, `undefined` where the platform defines no `O_NOFOLLOW` (Windows). */
export function noFollowFlag(): number | undefined {
  const flag: unknown = (constants as Record<string, unknown>)["O_NOFOLLOW"];
  return typeof flag === "number" ? flag : undefined;
}

/** The flags the rule opens with: append, create, write-only, and no-follow where the platform defines it. */
export function appendOnlyFlags(): number {
  const base = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY;
  const noFollow = noFollowFlag();
  return noFollow === undefined ? base : base | noFollow;
}

/** The `config` error of a path that is a symbolic link: the gate never writes through one. */
export function symbolicLinkRefused(path: string): ConfigError {
  return new ConfigError(
    `${path} is a symbolic link; the write gate does not write through one`,
    "replace the link with a regular file, or remove it so the tool creates the file",
  );
}

const defaultFs: AppendFs = { lstat, open };

/** True where `error` is the platform's refusal of a symbolic link under `O_NOFOLLOW`. */
function isNoFollowRefusal(error: unknown): boolean {
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return code === "ELOOP" || code === "EMLINK";
}

/**
 * Open `path` for appending by the rule above, creating it with mode `0600` where it does not exist. A symbolic link
 * at `path` is the `config` kind naming the path; any other failure is the `config` kind too, with the system error
 * as its cause. `noFollow` is the platform's flag, `null` where it has none; a test passes `null` to exercise the
 * `lstat` fallback on a platform that has the flag.
 */
export async function openAppendOnly(
  path: string,
  fs: AppendFs = defaultFs,
  noFollow: number | null = noFollowFlag() ?? null,
): Promise<AppendHandle> {
  if (noFollow === null) {
    // No `O_NOFOLLOW` on this platform: the link check runs before the open.
    let link = false;
    try {
      link = (await fs.lstat(path)).isSymbolicLink();
    } catch {
      // The file does not exist yet, or cannot be inspected: the open decides.
    }
    if (link) throw symbolicLinkRefused(path);
  }
  try {
    return await fs.open(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (noFollow ?? 0),
      GATE_FILE_MODE,
    );
  } catch (error: unknown) {
    if (isNoFollowRefusal(error)) throw symbolicLinkRefused(path);
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot open ${path} for appending: ${message}`, "check the file and its directory", {
      cause: error,
    });
  }
}

/** True where the file exists, is not empty and does not end in a newline: a partial line a crash left behind. */
async function endsMidLine(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const handle = await open(path, "r");
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Append `text` to `path` by the rule above: open, write, close, so no handle outlives the append. Where the file ends
 * in a partial line (a crash mid-append), a newline goes first, so the partial line stays the one line the reader
 * skips and the new line parses.
 */
export async function appendText(path: string, text: string, fs: AppendFs = defaultFs): Promise<void> {
  const separator = (await endsMidLine(path)) ? "\n" : "";
  const handle = await openAppendOnly(path, fs);
  try {
    await handle.write(`${separator}${text}`, null, "utf8");
  } finally {
    await handle.close();
  }
}
