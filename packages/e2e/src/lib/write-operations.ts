// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The tool names the static check (`__tests__/suite-shape.test.ts`) and the live files read, so each
 * literal sits in one place: the three write tools, the three write kinds, and the v1 tool set
 * `70-mcp-stdio` asserts (issue #17 § Registration; the parity gate of the umbrella package asserts the
 * same list against the registry). Only `60-write` may name a write tool in its own source.
 */

export const WRITE_TOOL_NAMES: readonly string[] = Object.freeze([
  "gripeventsctl_chat_send",
  "gripeventsctl_interest_show",
  "gripeventsctl_interest_skip",
]);

export const WRITE_KIND_NAMES: readonly string[] = Object.freeze(["chat.send", "interest.show", "interest.skip"]);

/** The v1 tools, in registry order: the reads except the held `attendance get`, the three writes, the two `writes` reads. */
export const V1_TOOL_NAMES: readonly string[] = Object.freeze([
  "gripeventsctl_events_check",
  "gripeventsctl_events_list",
  "gripeventsctl_attendees_list",
  "gripeventsctl_attendees_dump",
  "gripeventsctl_attendees_get",
  "gripeventsctl_match_status",
  "gripeventsctl_chat_list",
  "gripeventsctl_chat_thread",
  "gripeventsctl_chat_send",
  "gripeventsctl_schedule_info",
  "gripeventsctl_interest_show",
  "gripeventsctl_interest_skip",
  "gripeventsctl_writes_status",
  "gripeventsctl_writes_pending",
]);
