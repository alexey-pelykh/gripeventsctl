// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { randomBytes, randomUUID } from "node:crypto";

export interface FixtureSecrets {
  /** A session token: a 36-character UUID, the shape of the login call's `user_token`. */
  sessionToken: string;
  /** A chat token: a JWT-shaped string, the shape of the login call's `chat_token.Token`. */
  chatToken: string;
  /** A per-event application token. */
  applicationToken: string;
  /** An attendee password. */
  password: string;
  /** The email the `Basic` value is built from. */
  email: string;
  /** `base64(email:password)`, the login call's `Basic` value. */
  basic: string;
}

export const FIXTURE_EMAIL = "test.person.1@example.com";

/** Secret-shaped values generated per run; none is a literal in any committed file. */
export function fixtureSecrets(): FixtureSecrets {
  const segment = (bytes: number): string => randomBytes(bytes).toString("base64url");
  const password = segment(18);
  return {
    sessionToken: randomUUID(),
    chatToken: `eyJ${segment(24)}.${segment(60)}.${segment(32)}`,
    applicationToken: randomBytes(16).toString("hex"),
    password,
    email: FIXTURE_EMAIL,
    basic: Buffer.from(`${FIXTURE_EMAIL}:${password}`, "utf8").toString("base64"),
  };
}
