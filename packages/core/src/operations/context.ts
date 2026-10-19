// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * What an operation whose path carries the container id reads from its `OperationContext`: the container id of the
 * stored session and the client's `signal` option. They sat in `attendees/search.ts` while the attendees group was
 * the only one with such a path; the match group reads them too, so they live beside `operation.ts`.
 */

import { NoSessionError } from "../transport/errors.js";
import type { OperationContext } from "./operation.js";

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
