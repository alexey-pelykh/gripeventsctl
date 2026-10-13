// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The shape undici's `intercept().reply(callback)` accepts: every builder in this directory returns
 * one, built from the `docs/api/` page and section its comment names, never from the client's own
 * code. Ids are small integers from 1 upward, names `Test Person <n>`, secrets from `fixtureSecrets()`.
 */

export interface GripReply {
  statusCode: number;
  data: string | Buffer;
  responseOptions: { headers: Record<string, string> };
}

export const JSON_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/json" };

/** A JSON reply of `body` on `statusCode`. */
export function jsonReply(statusCode: number, body: unknown, headers: Record<string, string> = {}): GripReply {
  return { statusCode, data: JSON.stringify(body), responseOptions: { headers: { ...JSON_HEADERS, ...headers } } };
}
