// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { success200 } from "./envelope.js";
import type { GripReply } from "./reply.js";

export interface LoginOptions {
  /** The session token: from `fixtureSecrets()`. */
  sessionToken: string;
  /** The chat token, the JWT inside `chat_token.Token`: from `fixtureSecrets()`. */
  chatToken: string;
  identityId?: string;
  firstLogin?: boolean;
}

/** docs/api/login.md § Response: the 200 answer to `POST user/account/login`. Field names from the page; the ids synthetic. */
export function login200(options: LoginOptions): GripReply {
  return success200({
    first_login: options.firstLogin ?? false,
    user_token: options.sessionToken,
    chat_token: {
      IdentityId: options.identityId ?? "eu-west-1:test-identity-1",
      Token: options.chatToken,
      $metadata: { httpStatusCode: 200, requestId: "test-request-1", attempts: 1, totalRetryDelay: 0 },
    },
  });
}
