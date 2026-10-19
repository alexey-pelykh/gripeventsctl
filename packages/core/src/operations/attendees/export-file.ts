// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The export file of `attendees dump` (issue #11 § `attendees dump`, the export file): the path checks and the
 * exclusive create, free of attendee data. `openExportFile(out, ctx)` runs the checks in this order, before any
 * request is sent, each refusal the `usage` kind (exit 2 on the CLI, `isError` with `error.kind` `usage` on MCP) with
 * a message naming the rule and the path:
 *
 * 1. On the CLI a relative `out` is resolved against the current working directory; on MCP a relative path is refused
 *    (`out must be an absolute path`), because the server's working directory is the host's, not the user's.
 * 2. `out` is absolute and ends in `.jsonl`.
 * 3. `out` is none of the tool's own files: the config path and the send log, go-ahead journal and write lock derived
 *    from it, compared after `path.resolve` on both sides and with the parent directory's symbolic links resolved,
 *    so `/var/...` and `/private/var/...` on macOS name the same file.
 * 4. The parent directory exists and is not a symbolic link (`lstat`); nothing exists at `out` (`lstat` fails with
 *    `ENOENT`): an existing file, directory or symbolic link, dangling included, is refused, so nothing is ever
 *    written over or through another file.
 * 5. Where the parent directory is inside a git work tree (an ancestor holds a `.git` entry, file or directory;
 *    `insideGitWorkTree`, no `git` binary), the CLI writes one warning line to stderr and proceeds; the MCP twin
 *    refuses, because an assistant must not land attendee data inside a repository.
 * 6. The file is created with `fs.open(out, "wx", 0o600)`: the exclusive create refuses a file that appeared between
 *    the `lstat` and the open with the same `usage` message. The dump appends every page through the returned handle
 *    and never reopens the path. On Windows the mode is what the platform supports and the file inherits the
 *    profile's ACL.
 */

import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { derivedPaths, insideGitWorkTree } from "../../config/paths.js";
import { redactString } from "../../lib/redact.js";
import { UsageError } from "../../transport/errors.js";
import type { OperationContext } from "../operation.js";

export const EXPORT_FILE_SUFFIX = ".jsonl";

/** Owner read and write only: the file holds other attendees' records. */
export const EXPORT_FILE_MODE = 0o600;

export const ABSOLUTE_PATH_MESSAGE = "out must be an absolute path";

/** The warning the CLI writes for an `out` inside a git work tree. */
export function workTreeWarning(out: string): string {
  return `${out} is inside a git work tree; do not commit it`;
}

/** The refusal the MCP twin raises for an `out` inside a git work tree. */
export function workTreeRefusal(out: string): string {
  return `${out} is inside a git work tree; choose a path outside any repository`;
}

export function alreadyExistsMessage(out: string): string {
  return `${out} already exists; choose a new path`;
}

/** The `out` the dump reports and opens: resolved against the working directory on the CLI, as given on MCP. */
export function resolveExportPath(out: string, ctx: Pick<OperationContext, "source">): string {
  return ctx.source === "cli" ? path.resolve(out) : out;
}

function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * `file` with its parent directory's symbolic links resolved where the parent exists, else as `path.resolve` gives
 * it; the file itself is never followed, so a symbolic link at the path compares as the link.
 */
async function canonical(file: string): Promise<string> {
  const resolved = path.resolve(file);
  try {
    return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

/** The tool's own files: the config path and the three paths derived from it. */
export function ownFiles(ctx: Pick<OperationContext, "config">): string[] {
  const derived = derivedPaths(ctx.config.path, ctx.config.config);
  return [ctx.config.path, derived.sendLog, derived.goAheads, derived.writeLock];
}

/** Run the six checks above and return the handle of the newly created file; every refusal is the `usage` kind. */
export async function openExportFile(out: string, ctx: OperationContext): Promise<FileHandle> {
  const resolved = resolveExportPath(out, ctx);
  if (!path.isAbsolute(resolved)) {
    throw new UsageError(`${ABSOLUTE_PATH_MESSAGE}: ${out}`, "pass an absolute path ending in .jsonl");
  }
  if (!resolved.endsWith(EXPORT_FILE_SUFFIX)) {
    throw new UsageError(`out must end in ${EXPORT_FILE_SUFFIX}: ${resolved}`, "name a .jsonl file");
  }
  const target = await canonical(resolved);
  for (const own of ownFiles(ctx)) {
    if ((await canonical(own)) === target) {
      throw new UsageError(
        `out must not be one of the tool's own files: ${resolved}`,
        "name a file that is not the config, the send log, the go-ahead journal or the write lock",
      );
    }
  }
  const parent = path.dirname(resolved);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (error: unknown) {
    const code = errnoOf(error) ?? "cannot be read";
    throw new UsageError(
      `the parent directory of out does not exist (${code}): ${resolved}`,
      "create the directory first",
    );
  }
  if (parentStat.isSymbolicLink()) {
    throw new UsageError(`the parent directory of out is a symbolic link: ${resolved}`, "name the directory itself");
  }
  if (!parentStat.isDirectory()) {
    throw new UsageError(`the parent of out is not a directory: ${resolved}`, "name a file inside a directory");
  }
  try {
    await lstat(resolved);
    throw new UsageError(alreadyExistsMessage(resolved), "choose a new path");
  } catch (error: unknown) {
    if (error instanceof UsageError) throw error;
    if (errnoOf(error) !== "ENOENT") {
      throw new UsageError(`out cannot be checked (${errnoOf(error) ?? "unknown error"}): ${resolved}`);
    }
  }
  if (insideGitWorkTree(resolved)) {
    if (ctx.source === "mcp") throw new UsageError(workTreeRefusal(resolved), "name a path outside any repository");
    ctx.stderr.write(`${redactString(workTreeWarning(resolved))}\n`);
  }
  try {
    return await open(resolved, "wx", EXPORT_FILE_MODE);
  } catch (error: unknown) {
    const code = errnoOf(error);
    if (code === "EEXIST") throw new UsageError(alreadyExistsMessage(resolved), "choose a new path");
    throw new UsageError(`out cannot be created (${code ?? "unknown error"}): ${resolved}`, "choose another path");
  }
}
