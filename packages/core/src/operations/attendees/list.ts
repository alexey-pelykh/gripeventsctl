// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `attendees list --type <ids> [--page <n>]` (issue #11 § `attendees list`): one page of the directory search sorted
 * by name for the given type ids (`docs/api/attendees.md` § Directory search), each entry with its thing id. One
 * `GripClient.get()` of the page and never a second request, whatever the page holds: paging through the directory is
 * `attendees dump`. The output is `{ page, next_page, entries }`, where `next_page` is `page + 1` when the page holds
 * the recorded page size of 20 entries and `null` otherwise (`null` means this is the last page). A `gated-type`,
 * `auth-failed`, `throttled`, `load-balancer-rejected`, `network` or `api` error propagates untouched: the operation
 * catches nothing and retries nothing, and never loops over type ids (the user reads the type set from `events
 * check`). The human form is the table of the entries (`render.tableField`), `id` first and the other keys as sent,
 * then `page: <n>` and `next_page: <n+1>` or `next_page: null`; an empty page prints `no attendees of these types`
 * before the two lines, exit 0.
 */

import { z } from "zod";

import { defineOperation } from "../operation.js";
import { containerIdOf, signalOption } from "../context.js";
import {
  SEARCH_PAGE_SIZE,
  SEARCH_REQUEST,
  TYPE_IDS_HELP,
  searchEntrySchema,
  searchPageSchema,
  searchPath,
  searchQuery,
} from "./search.js";

export const attendeesListInput = z.object({
  type_ids: z.array(z.number().int().positive()).min(1).describe(TYPE_IDS_HELP),
  page: z.number().int().min(1).default(1).describe("the page of the directory, from 1; 20 entries per page"),
});

export const attendeesListOutput = z.object({
  page: z.number().int().min(1),
  /** `page + 1` when the page holds 20 entries, else `null`: this is the last page. */
  next_page: z.number().int().min(2).nullable(),
  entries: z.array(searchEntrySchema),
});

export type AttendeesListOutput = z.infer<typeof attendeesListOutput>;

export const ATTENDEES_LIST_EMPTY_TEXT = "no attendees of these types";

export const attendeesList = defineOperation({
  group: "attendees",
  verb: "list",
  kind: "read",
  description: "List one page of the attendee directory for the given type ids",
  needsSession: true,
  input: attendeesListInput,
  output: attendeesListOutput,
  requests: [SEARCH_REQUEST],
  cli: { flags: { type_ids: "type" } },
  render: { tableField: "entries", emptyText: ATTENDEES_LIST_EMPTY_TEXT },
  async run(ctx, input): Promise<AttendeesListOutput> {
    const entries = await ctx.client.get(searchPath(containerIdOf(ctx)), {
      query: searchQuery(input.type_ids, input.page),
      schema: searchPageSchema,
      ...signalOption(ctx),
    });
    return {
      page: input.page,
      next_page: entries.length === SEARCH_PAGE_SIZE ? input.page + 1 : null,
      entries,
    };
  },
});
