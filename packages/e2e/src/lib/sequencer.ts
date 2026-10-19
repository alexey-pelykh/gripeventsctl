// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `PathSequencer`: the live files in path order. Vitest's default sequencer orders files by cached
 * failures, duration and size (Vitest 5.0.3, `BaseSequencer.sort()`), so `00-session` would not be
 * the first file of a run. This one sorts by `moduleId`, the file path, with a plain code-unit
 * comparison, and keeps the inherited `shard()`.
 */

import { BaseSequencer, type TestSpecification } from "vitest/node";

/** `files` in `moduleId` order, by code units; the input is left as it is. */
export function sortByPath<T extends { moduleId: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => {
    if (a.moduleId < b.moduleId) return -1;
    if (a.moduleId > b.moduleId) return 1;
    return 0;
  });
}

export class PathSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve(sortByPath(files));
  }
}
