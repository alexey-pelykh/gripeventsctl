// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `Terminal` seam: every prompt and every TTY check the CLI makes goes through it, so a test
 * drives the commands with a fake that never touches the process's stdin. The real one wraps
 * `@clack/prompts` (`text` for a visible prompt, `password` for a hidden one) and the `isTTY` flags
 * of the process streams. `@gripeventsctl/testing` ships the fake (`fakeTerminal()`), with settable
 * TTY flags, scripted answers and a screen buffer. A later item reuses the seam for the go-ahead
 * confirmation.
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
  /** Write `text` to `stream`: how every line of output reaches the user. */
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
