// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `Terminal` seam: every prompt and every TTY check the CLI makes goes through it, so a test
 * drives the commands with a fake that never touches the process's stdin. The real one wraps
 * `@clack/prompts` (`text` for a visible prompt, `password` for a hidden one) and the `isTTY` flags
 * of the process streams. `@gripeventsctl/testing` ships the fake (`fakeTerminal()`), with settable
 * TTY flags, scripted answers and a screen buffer. `write` carries what is shown beside a prompt, the
 * go-ahead view of issue #16 for one; a result, an error and Commander's own output go to the stream
 * itself, so a fake whose `write` only keeps a screen still leaves `--json` one document on stdout.
 */

import { isCancel, password, text } from "@clack/prompts";
import { UsageError } from "@gripeventsctl/core";

/** A stream the CLI writes to; `process.stdout` and `process.stderr` satisfy it. */
export interface OutputStream {
  write(text: string): unknown;
}

export interface Terminal {
  isStdinTTY(): boolean;
  isStdoutTTY(): boolean;
  /** A visible prompt; the answer is echoed as typed. */
  prompt(label: string): Promise<string>;
  /** A hidden prompt: the answer is never echoed. */
  promptHidden(label: string): Promise<string>;
  /** Write `text` to `stream`: how a screen shown beside a prompt reaches the user. */
  write(stream: OutputStream, text: string): void;
}

/** The `usage` error of a prompt the user cancelled (Ctrl-C or Escape). Exit code 2. */
export function promptCancelled(label: string): UsageError {
  return new UsageError(`the prompt "${label}" was cancelled`, "run the command again to answer it");
}

/** The real terminal: `@clack/prompts` on the process's own streams. */
export function realTerminal(): Terminal {
  return {
    isStdinTTY: () => process.stdin.isTTY,
    isStdoutTTY: () => process.stdout.isTTY,
    async prompt(label) {
      const answer = await text({ message: label });
      if (isCancel(answer)) throw promptCancelled(label);
      return answer;
    },
    async promptHidden(label) {
      const answer = await password({ message: label });
      if (isCancel(answer)) throw promptCancelled(label);
      return answer;
    },
    write(stream, text) {
      stream.write(text);
    },
  };
}
