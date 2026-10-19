// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `recordingDispatcher()`: an undici dispatcher that records the method, the path and the status of
 * every answer, and nothing else: no header, no body, no query value. The query string is cut from
 * the path before it is stored, so a slug or a container id in a query never reaches the record. A
 * numeric path segment (a container id, a thing id) is still in `path`; the record is private to the
 * file that owns the dispatcher, and the summary line prints the operation's template, never the path.
 *
 * It composes an `Agent` of its own (`Dispatcher.compose()`, undici 8.11.2), never the global
 * dispatcher, so a probe's request never lands in a read file's record. The handler wrapper delegates
 * every method of the dispatch handler API to the one it wraps, so `fetch` sees its own handler
 * called as it expects.
 */

import { Agent, type Dispatcher } from "undici";

export interface RecordedCall {
  method: string;
  /** The path as sent, the query cut. */
  path: string;
  status: number;
}

export interface Recorder {
  dispatcher: Dispatcher;
  readonly calls: RecordedCall[];
  last(): RecordedCall | undefined;
  /** Close the underlying dispatcher. */
  close(): Promise<void>;
}

type Handler = Dispatcher.DispatchHandler;
type Args<K extends keyof Handler> = Parameters<NonNullable<Handler[K]>>;

class RecordingHandler implements Handler {
  readonly #inner: Handler;
  readonly #record: (status: number) => void;

  constructor(inner: Handler, record: (status: number) => void) {
    this.#inner = inner;
    this.#record = record;
  }

  onRequestStart(...args: Args<"onRequestStart">): void {
    this.#inner.onRequestStart?.(...args);
  }

  onRequestUpgrade(...args: Args<"onRequestUpgrade">): void {
    this.#inner.onRequestUpgrade?.(...args);
  }

  onResponseStart(...args: Args<"onResponseStart">): void {
    this.#record(args[1]);
    this.#inner.onResponseStart?.(...args);
  }

  onResponseData(...args: Args<"onResponseData">): void {
    this.#inner.onResponseData?.(...args);
  }

  onResponseEnd(...args: Args<"onResponseEnd">): void {
    this.#inner.onResponseEnd?.(...args);
  }

  onResponseError(...args: Args<"onResponseError">): void {
    this.#inner.onResponseError?.(...args);
  }

  onResponseStarted(): void {
    this.#inner.onResponseStarted?.();
  }

  onBodySent(...args: Args<"onBodySent">): void {
    this.#inner.onBodySent?.(...args);
  }
}

/** `path` up to its first `?`. */
export function stripQuery(path: string): string {
  return path.split("?")[0] ?? "";
}

/** A recorder over `base` (a fresh `Agent` by default; a test passes its mock agent). */
export function recordingDispatcher(base: Dispatcher = new Agent()): Recorder {
  const calls: RecordedCall[] = [];
  const interceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) =>
    dispatch(
      opts,
      new RecordingHandler(handler, (status) => {
        calls.push({ method: opts.method, path: stripQuery(opts.path), status });
      }),
    );
  return {
    dispatcher: base.compose(interceptor),
    calls,
    last: () => calls.at(-1),
    close: async () => {
      await base.close();
    },
  };
}
