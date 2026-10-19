// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fake `Terminal` of the CLI tests: settable TTY flags, scripted answers for the visible and the
 * hidden prompts, and a screen buffer. `write(stream, text)` forwards the text to the stream it was
 * given (so a captured stdout and stderr read as the real ones would) and keeps a copy on the screen.
 * The seam is restated here because this package depends on no workspace package; the CLI's
 * `lib/terminal.ts` declares the same shape.
 */

/** A stream the CLI writes to. */
export interface OutputStream {
  write(text: string): unknown;
}

export interface Terminal {
  isStdinTTY(): boolean;
  isStdoutTTY(): boolean;
  prompt(label: string): Promise<string>;
  promptHidden(label: string): Promise<string>;
  write(stream: OutputStream, text: string): void;
}

export interface FakeTerminalOptions {
  /** What `isStdinTTY()` and `isStdoutTTY()` answer; both the same unless `stdoutTTY` is given. */
  tty?: boolean;
  stdoutTTY?: boolean;
  /** The answers of the visible prompts, in order; an unscripted prompt rejects. */
  answers?: string[];
  /**
   * An answer computed from the prompt's label and its ordinal (1 for the first), tried before the scripted list: how
   * a test types back the challenge code a go-ahead prompt shows (issue #16). `undefined` falls through to the list.
   */
  answer?: (label: string, attempt: number) => string | undefined;
  /** The answers of the hidden prompts, in order; an unscripted prompt rejects. */
  hiddenAnswers?: string[];
}

export interface FakeTerminal {
  terminal: Terminal;
  /** Everything written through `write`, in order, whatever the stream. */
  screen(): string;
  /** The labels of the visible prompts shown, in order. */
  visiblePrompts: string[];
  /** The labels of the hidden prompts shown, in order. */
  hiddenPrompts: string[];
}

/** A fake terminal that answers from the script and never reads the process's stdin. */
export function fakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  const stdinTTY = options.tty ?? false;
  const stdoutTTY = options.stdoutTTY ?? stdinTTY;
  const answers = [...(options.answers ?? [])];
  const hiddenAnswers = [...(options.hiddenAnswers ?? [])];
  const screen: string[] = [];
  const visiblePrompts: string[] = [];
  const hiddenPrompts: string[] = [];
  const terminal: Terminal = {
    isStdinTTY: () => stdinTTY,
    isStdoutTTY: () => stdoutTTY,
    prompt: (label) => {
      visiblePrompts.push(label);
      const answer = options.answer?.(label, visiblePrompts.length) ?? answers.shift();
      return answer === undefined
        ? Promise.reject(new Error(`unscripted visible prompt: ${label}`))
        : Promise.resolve(answer);
    },
    promptHidden: (label) => {
      hiddenPrompts.push(label);
      const answer = hiddenAnswers.shift();
      return answer === undefined
        ? Promise.reject(new Error(`unscripted hidden prompt: ${label}`))
        : Promise.resolve(answer);
    },
    write: (stream, text) => {
      screen.push(text);
      stream.write(text);
    },
  };
  return { terminal, screen: () => screen.join(""), visiblePrompts, hiddenPrompts };
}
