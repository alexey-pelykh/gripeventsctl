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

export interface SearchEntry {
  /** The thing id, the one field the page records. */
  id: number;
  [field: string]: unknown;
}

/**
 * docs/api/attendees.md § Directory search: one page of entries as given, each at least `id` (the thing id); the page
 * records no other field name, so any further field is the test's own.
 */
export function searchEntries200(entries: SearchEntry[]): GripReply {
  return success200(entries);
}

/** docs/api/attendees.md § Directory search: the empty `data` array that ends the paging. */
export function searchEmpty200(): GripReply {
  return success200([]);
}

/**
 * docs/api/attendees.md § Gated for a normal attendee token (HTTP 403): `thing N not authorized`. The page does not say
 * what N identifies; the parameter name is the fixture's.
 */
export function gatedType403(thingId: number): GripReply {
  return failure(`thing ${String(thingId)} not authorized`, 403);
}

export interface SpeakerSession {
  session_name: string;
  description: string;
  track: string;
  location: string;
  /** Epoch seconds. */
  date_start: number;
}

export interface ProfileFields {
  /** The rich Grip profile fields; the page names examples, not keys, so the test gives them. */
  rtm?: Record<string, unknown>;
  rtm_raw?: Record<string, unknown>;
  /** `sessions.speaker[]`: the sessions the attendee speaks at. */
  speaker?: SpeakerSession[];
  /** Past events both the attendee and the caller attended. */
  common_containers?: unknown[];
  common_connections_count?: number;
  rtm_score?: number;
  /** Further keys merged into `data`, for tests of unknown-field handling. */
  extra?: Record<string, unknown>;
}

/**
 * docs/api/attendees.md § The per-person profile: `data.id` equals the requested thing id, with `rtm`, `rtm_raw`,
 * `sessions.speaker[]` (`session_name`, `description`, `track`, `location`, `date_start`), `common_containers`,
 * `common_connections_count` and `rtm_score` as given. `name` is a fixture field the section does not record; a field
 * not given is omitted.
 */
export function profile200(thingId: number, fields: ProfileFields = {}): GripReply {
  return success200({
    id: thingId,
    name: `Test Person ${String(thingId)}`,
    ...(fields.rtm === undefined ? {} : { rtm: fields.rtm }),
    ...(fields.rtm_raw === undefined ? {} : { rtm_raw: fields.rtm_raw }),
    ...(fields.speaker === undefined ? {} : { sessions: { speaker: fields.speaker } }),
    ...(fields.common_containers === undefined ? {} : { common_containers: fields.common_containers }),
    ...(fields.common_connections_count === undefined
      ? {}
      : { common_connections_count: fields.common_connections_count }),
    ...(fields.rtm_score === undefined ? {} : { rtm_score: fields.rtm_score }),
    ...fields.extra,
  });
}
