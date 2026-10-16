// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { success200 } from "./envelope.js";
import type { GripReply } from "./reply.js";

export interface ChatThreadEntry {
  thing_id: number;
  name: string;
  job_title: string;
  company_name: string;
  last_message: string;
  /** Epoch seconds. */
  last_message_date: number;
  last_message_is_read: boolean;
  new_messages_count: number;
  total_message_count: number;
  chat_id: number;
}

/** A synthetic thread with the other person `Test Person <n>` at `Example Org <n>`; ids run from `n`. */
export function chatThreadEntry(n: number, overrides: Partial<ChatThreadEntry> = {}): ChatThreadEntry {
  return {
    thing_id: n,
    name: `Test Person ${String(n)}`,
    job_title: "Test Title",
    company_name: `Example Org ${String(n)}`,
    last_message: `synthetic message ${String(n)}`,
    last_message_date: 1_760_000_000 + n,
    last_message_is_read: false,
    new_messages_count: 1,
    total_message_count: 1,
    chat_id: n,
    ...overrides,
  };
}

/**
 * docs/api/chat-and-meetings.md § Chat threads: the answer to `GET chat/latest?container_id=<id>` lists every thread
 * in `data`, each with `thing_id`, `name`, `job_title`, `company_name`, `last_message`, `last_message_date` (epoch),
 * `last_message_is_read`, `new_messages_count`, `total_message_count` and `chat_id`.
 */
export function chatLatest200(threads: ChatThreadEntry[] = [chatThreadEntry(1)]): GripReply {
  return success200(threads);
}

export interface ChatMessageEntry {
  id: number;
  sender_id: number;
  recipient_id: number;
  message: string;
  /** Epoch seconds. */
  date_created: number;
  is_read: boolean;
  meeting_action: null | string;
}

/** A synthetic message `synthetic message <n>` from thing `sender` to thing `recipient`. */
export function chatMessageEntry(
  n: number,
  sender: number,
  recipient: number,
  overrides: Partial<ChatMessageEntry> = {},
): ChatMessageEntry {
  return {
    id: n,
    sender_id: sender,
    recipient_id: recipient,
    message: `synthetic message ${String(n)}`,
    date_created: 1_760_000_000 + n,
    is_read: false,
    meeting_action: null,
    ...overrides,
  };
}

/**
 * docs/api/chat-and-meetings.md § Messages in a thread: the answer to `GET chat/thing/<thing_id>` lists the messages
 * in `data`, each with `id`, `sender_id`, `recipient_id`, `message`, `date_created` (epoch), `is_read` and
 * `meeting_action`. The page records no value of `meeting_action`; `null` is the fixture's.
 */
export function chatThread200(messages: ChatMessageEntry[] = [chatMessageEntry(1, 2, 1)]): GripReply {
  return success200(messages);
}

/**
 * docs/api/chat-and-meetings.md § Send a chat message: HTTP 200 `{"success":true,"data":{"message_id":<id>}}` to
 * `POST chat/thing/<thing_id>`.
 */
export function chatSend200(messageId = 1): GripReply {
  return success200({ message_id: messageId });
}

export interface ScheduleAttendee {
  thing_id: number;
  name: string;
  company_name: string;
  status: string;
}

export interface ScheduleEntry {
  type: "meeting" | "session";
  status: "accepted" | "pending" | "declined";
  user_display_type: string;
  attendees: ScheduleAttendee[];
  requestor_id: number;
  /** Epoch seconds. */
  date_start_timestamp: number;
  date_end_timestamp: number;
  location: string;
  message: string;
  has_conflict: boolean;
}

/** A synthetic accepted meeting `n` with `Test Person <n>` of `Example Org <n>`, asked for by thing `n`. */
export function scheduleEntry(n: number, overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    type: "meeting",
    status: "accepted",
    user_display_type: "confirmed",
    attendees: [
      { thing_id: n, name: `Test Person ${String(n)}`, company_name: `Example Org ${String(n)}`, status: "accepted" },
    ],
    requestor_id: n,
    date_start_timestamp: 1_760_000_000 + n * 3600,
    date_end_timestamp: 1_760_000_000 + n * 3600 + 1800,
    location: `Table ${String(n)}`,
    message: `synthetic message ${String(n)}`,
    has_conflict: false,
    ...overrides,
  };
}

/**
 * docs/api/chat-and-meetings.md § Schedule: the answer to `GET schedule/thing/user_id/info?container_id=<id>` carries
 * `data.schedule`, one entry per meeting and per agenda session, each with `type`, `status`, `user_display_type`,
 * `attendees[]` (`thing_id`, `name`, `company_name`, `status`), `requestor_id`, `date_start_timestamp`,
 * `date_end_timestamp`, `location`, `message` and `has_conflict`.
 */
export function scheduleInfo200(entries: ScheduleEntry[] = [scheduleEntry(1)]): GripReply {
  return success200({ schedule: entries });
}
