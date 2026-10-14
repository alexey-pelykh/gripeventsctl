// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { failure, success200 } from "./envelope.js";
import { type GripReply, jsonReply } from "./reply.js";

/**
 * docs/api/interest.md § Throttling (HTTP 429):
 * `{"success":false,"data":"Throttling - Maximum sending rate exceeded"}`.
 * The page records no header; the optional `Retry-After` exercises the issue's backoff rule (honour the
 * header, capped at 300 s) and is not a recorded platform fact.
 */
export function throttled429(retryAfterSeconds?: number): GripReply {
  const reply = failure("Throttling - Maximum sending rate exceeded", 429);
  if (retryAfterSeconds !== undefined) reply.responseOptions.headers["retry-after"] = String(retryAfterSeconds);
  return reply;
}

/**
 * docs/api/interest.md § Response: HTTP 201 `action recorded - swipe message created or updated`; `connection` is 1
 * when the answer made a mutual connection.
 */
export function matchAnswer201(connection: 0 | 1 = 0): GripReply {
  return jsonReply(201, {
    success: true,
    data: { message: "action recorded - swipe message created or updated", connection },
  });
}

export type MatchStatus = "has_match_none" | "has_match_yes" | "has_match_no" | "has_connection";

/** docs/api/interest.md § Check the state first: `{ "success": true, "data": { "status": "has_match_none" } }`. */
export function matchStatus200(status: MatchStatus): GripReply {
  return success200({ status });
}

/**
 * docs/api/interest.md § Errors the app matches on: `"limit of swipes reached for action"`; the status is not recorded
 * (none seen live), 200 by default.
 */
export function swipeCapAnswer(statusCode = 200): GripReply {
  return failure("limit of swipes reached for action", statusCode);
}

/**
 * docs/api/interest.md § Errors the app matches on: `"action not allowed under current mode phase"`; the status is not
 * recorded, 200 by default.
 */
export function modePhaseAnswer(statusCode = 200): GripReply {
  return failure("action not allowed under current mode phase", statusCode);
}

/**
 * docs/api/interest.md § Errors the app matches on: HTTP 409 with an `error.data` array, read from the app code and
 * never seen live; where the array sits on the wire is not verified (docs/api/not-verified.md § Match answers).
 */
export function conflict409(details: string[]): GripReply {
  return jsonReply(409, { error: { data: details } });
}

/**
 * docs/api/interest.md § Errors the app matches on, the other shape the 409 may take on the wire: the array as the
 * envelope's own `data` (`{"success":false,"data":[...]}`), which the app's HTTP client may hand its code as
 * `error.data`. Not seen live either (docs/api/not-verified.md § Match answers); the client accepts both shapes.
 */
export function conflict409InData(details: string[]): GripReply {
  return jsonReply(409, { success: false, data: details });
}
