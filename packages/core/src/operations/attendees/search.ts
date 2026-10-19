// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * What the three attendees operations share (issue #11 § The search request): the directory search request as
 * `docs/api/attendees.md` § Directory search records it, `GET container/<container_id>/search/?page=<n>&sort=name&type_id=<ids>`
 * with the trailing slash after `search` (without it a request with `type_id` answers HTTP 400), the ids joined by a
 * literal comma in the order given and deduplicated, `page` from 1; the search-entry schema; and the container id of
 * the stored session. The query goes through `GripClient.get()`'s `query` option, which sends the comma as `,` and
 * never as `%2C` (`#url` in `transport/client.ts`); the unit test reads the recorded URL and asserts the literal
 * comma and the `search/?`.
 */

import { z } from "zod";

import type { Query } from "../../transport/client.js";
import { NoSessionError } from "../../transport/errors.js";
import type { OperationContext, RequestShape } from "../operation.js";

/** The sort the page records: by name. */
export const SEARCH_SORT = "name";

/** The page size the page records; no parameter overrides it. A full page says there may be a next one. */
export const SEARCH_PAGE_SIZE = 20;

/** The request shape both `attendees list` and `attendees dump` declare. */
export const SEARCH_REQUEST: RequestShape = Object.freeze({
  method: "GET",
  pathTemplate: "container/<id>/search/?page=<n>&sort=name&type_id=<ids>",
  page: "attendees.md",
  section: "Directory search",
});

/** The help text of `type_ids`, on the CLI flag and in the MCP input schema: the ids come from `events check`. */
export const TYPE_IDS_HELP = "the type ids to read, comma-separated; events check shows the event's type set";

/** The type ids in the order given, each once. */
export function uniqueTypeIds(typeIds: readonly number[]): number[] {
  return [...new Set(typeIds)];
}

/** `container/<container_id>/search/`, with the trailing slash the page records as significant. */
export function searchPath(containerId: number): string {
  return `container/${String(containerId)}/search/`;
}

/** The query of one page: `page=<n>&sort=name&type_id=<id1>,<id2>`, the ids deduplicated in the order given. */
export function searchQuery(typeIds: readonly number[], page: number): Query {
  return { page, sort: SEARCH_SORT, type_id: uniqueTypeIds(typeIds).map(String).join(",") };
}

/**
 * One entry of a search page: the thing id in `id`, every other key kept as sent. This is the one output schema in
 * v1 that keeps unknown keys (`z.looseObject`), because `docs/api/attendees.md` § Directory search says that "the page
 * records no field of a search entry other than `id`" and the entry is itself what the user asked to see. The first
 * live run of `attendees list` records the entry's field names on that page, and the same pull request replaces this
 * schema with an explicit projection of those fields and adds `render.epochFields` for any epoch field among them.
 * Unknown keys pass through to `--json`, to `structuredContent` and to the dump file; every string value still passes
 * the output module's redaction backstop and terminal escaping.
 */
export const searchEntrySchema = z.looseObject({ id: z.number().int() });

export type SearchEntry = z.infer<typeof searchEntrySchema>;

/** The `data` of a search page: the entries in the order sent; empty on the page after the last. */
export const searchPageSchema = z.array(searchEntrySchema);

/**
 * The container id of the stored session. The builders raise `no-session` before any operation with `needsSession`
 * runs; this is the check for a context built by hand.
 */
export function containerIdOf(ctx: OperationContext): number {
  const session = ctx.config.config.session;
  if (session === undefined) throw new NoSessionError(`no session in ${ctx.config.path}`);
  return session.container_id;
}

/** The client's `signal` option from the context, as a spread: absent where the context carries none. */
export function signalOption(ctx: OperationContext): { signal?: AbortSignal } {
  return ctx.signal === undefined ? {} : { signal: ctx.signal };
}
