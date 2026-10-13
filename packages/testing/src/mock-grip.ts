// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `MockAgent` harness every client test injects as the `dispatcher`: nothing reaches the
 * network, every request is recorded, and an interceptor declared but never reached fails the test.
 * Created once per test file, inside a `describe` body or at module scope; the hooks it registers
 * belong to that scope, so it needs a running Vitest.
 */

import { Writable } from "node:stream";

import { type Interceptable, MockAgent } from "undici";
import { afterAll, afterEach } from "vitest";

/**
 * The API origin, restated here because this package depends on no workspace package; `headers.test.ts` in core
 * asserts it equals `API_ORIGIN`. Named for the mock so it is never read as `GRIP_API_ORIGIN`, one of the
 * environment variables the client must ignore (AC-01).
 */
export const MOCK_API_ORIGIN = "https://api-prod.grip.events";

/**
 * An undici `MockAgent` with `disableNetConnect()` (an accidental live request fails the test) and
 * call history enabled, `assertNoPendingInterceptors()` after each test and `close()` after all.
 * Request assertions read `agent.getCallHistory()`.
 */
export function mockGrip(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableCallHistory();
  afterEach(() => {
    agent.assertNoPendingInterceptors();
  });
  afterAll(async () => {
    await agent.close();
  });
  return agent;
}

/** The interceptable pool of the API origin: `gripPool(agent).intercept({ path, method }).reply(...)`. */
export function gripPool(agent: MockAgent): Interceptable {
  return agent.get(MOCK_API_ORIGIN);
}

class TextSink extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

export interface StderrSink {
  /** The stream to pass as the client's `stderr`. */
  stream: Writable;
  /** Everything written so far. */
  text(): string;
}

/** A writable stream collecting what the client writes to its `stderr`. */
export function stderrSink(): StderrSink {
  const sink = new TextSink();
  return { stream: sink, text: () => sink.text };
}
