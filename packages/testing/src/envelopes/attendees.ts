// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { failure, success200 } from "./envelope.js";
import type { GripReply } from "./reply.js";

export interface SearchPageOptions {
  /** How many non-empty pages the directory holds; the page after the last one is empty. */
  pages?: number;
  /** Entries per page: 20, the size no parameter overrides. */
  pageSize?: number;
}

/**
 * docs/api/attendees.md § Directory search: a page holds 20 entries, each with the thing id in `id`
 * (the page records no other field name); paging ends at an empty `data` array. Ids run from 1
 * upward across the pages.
 */
export function searchPage200(page: number, options: SearchPageOptions = {}): GripReply {
  const pages = options.pages ?? 3;
  const pageSize = options.pageSize ?? 20;
  if (page > pages) return success200([]);
  return success200(Array.from({ length: pageSize }, (_unused, index) => ({ id: (page - 1) * pageSize + index + 1 })));
}

/** docs/api/attendees.md § Gated for a normal attendee token (HTTP 403): `thing N not authorized`. The page does not say what N identifies; the parameter name is the fixture's. */
export function gatedType403(thingId: number): GripReply {
  return failure(`thing ${String(thingId)} not authorized`, 403);
}

/** docs/api/attendees.md § The per-person profile: `data.id` equals the requested thing id; the other fields omitted. */
export function profile200(thingId: number): GripReply {
  return success200({ id: thingId, name: `Test Person ${String(thingId)}` });
}
