// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The operation registry (issue #9 § The `Operation` type): `OPERATIONS` is the ordered list the CLI builder and the
 * MCP builder read, so every CLI leaf command has its MCP twin and the reverse (events, attendees, match, chat,
 * schedule, interest, writes; `chat send` sits with its group, after `chat thread`). The `Operation` type and
 * `defineOperation()` live in `operation.ts`.
 */

import { attendeesDump } from "./attendees/dump.js";
import { attendeesGet } from "./attendees/get.js";
import { attendeesList } from "./attendees/list.js";
import { chatList } from "./chat/list.js";
import { chatSend } from "./chat/send.js";
import { chatThread } from "./chat/thread.js";
import { eventsCheck } from "./events/check.js";
import { eventsList } from "./events/list.js";
import { interestShow } from "./interest/show.js";
import { interestSkip } from "./interest/skip.js";
import { matchStatus } from "./match/status.js";
import type { Operation } from "./operation.js";
import { scheduleInfo } from "./schedule/info.js";
import { writesPending } from "./writes/pending.js";
import { writesStatus } from "./writes/status.js";

/** The registry, ordered: events, attendees, match, chat, schedule, interest, writes. */
export const OPERATIONS: readonly Operation[] = Object.freeze([
  eventsCheck,
  eventsList,
  attendeesList,
  attendeesDump,
  attendeesGet,
  matchStatus,
  chatList,
  chatThread,
  chatSend,
  scheduleInfo,
  interestShow,
  interestSkip,
  writesStatus,
  writesPending,
]);
