// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `events list` (issue #10 § `events list`): `GET container`, the active containers of the session's application
 * (`docs/api/containers.md` § Containers a session sees), each projected to `id`, `name`, `format` and `has_joined`
 * in the order the API sent them; `branch_url` and any other key are dropped by the schema. The client sends the full
 * header set, `origin` and `referer` included, which the platform's load balancer requires on this path; the
 * operation adds no header and no query. Ended editions and other organisers' containers are absent from the answer
 * (§ What a session cannot see): `events check` is the way to look those up. Without a session the builders raise
 * `no-session` before any request.
 */

import { z } from "zod";

import { defineOperation } from "../operation.js";

export const containerRecord = z.object({
  id: z.number().int(),
  name: z.string(),
  format: z.string(),
  has_joined: z.boolean(),
});

export const eventsListOutput = z.array(containerRecord);

export type EventsListOutput = z.infer<typeof eventsListOutput>;

export const EVENTS_LIST_EMPTY_TEXT = "no active events";

export const eventsList = defineOperation({
  group: "events",
  verb: "list",
  kind: "read",
  description: "List the active events your session can reach",
  needsSession: true,
  input: z.object({}),
  output: eventsListOutput,
  requests: [{ method: "GET", pathTemplate: "container", page: "containers.md", section: "Containers a session sees" }],
  render: { emptyText: EVENTS_LIST_EMPTY_TEXT },
  run: (ctx) => ctx.client.get("container", { schema: eventsListOutput }),
});
