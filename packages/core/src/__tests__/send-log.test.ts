// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-SENDLOG, unit and component: the send log of issue #16 § The send log. The repeat guard's key over the
 * documented variants, the one-line-per-append format read back intact (a text holding `\n`, `"` and a space; one
 * thousand appends leaving the first line's bytes unchanged), a truncated last line skipped with one warning naming
 * the file and never blocking the next append, and the opening rule: the file is created with mode `0600`, `fs.open`
 * is called with `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW` and mode `0o600`, a symbolic link at the path is the
 * `config` kind naming the path with the link's target unchanged, and the `lstat` fallback refuses the link where the
 * platform has no `O_NOFOLLOW`.
 */

import { constants } from "node:fs";
import { lstat, open, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";

import { readSendLog as readLines, sendLogLine, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../index.js";
import { type AppendFs, appendOnlyFlags, noFollowFlag, openAppendOnly } from "../gate/files.js";
import { type SendLogEntry, appendSendLog, openSendLog, readSendLog, repeatGuard } from "../gate/send-log.js";

class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

const KEY = { container_id: 1, target_thing_id: 42, kind: "synthetic.write" };

const line = (overrides: Partial<SendLogEntry> = {}): SendLogEntry => sendLogLine(overrides) as SendLogEntry;

describe("[CAP-SENDLOG] one append-only, 0600, no-follow line per attempt with the documented fields", () => {
  describe("unit: the repeat guard's filter", () => {
    it("U1: returns the newest sent, non-dry-run entry of the same key, and null for another target", () => {
      const older = line();
      const newer = line({ time: "2026-10-12T10:00:00Z" });
      expect(repeatGuard([older, newer], KEY)).toBe(newer);
      expect(repeatGuard([newer, older], KEY)).toBe(older);
      expect(repeatGuard([older], { ...KEY, target_thing_id: 43 })).toBeNull();
      expect(repeatGuard([], KEY)).toBeNull();
    });

    it.each([
      ["a refused entry", line({ outcome: "refused", refusal: "status-not-none", http_status: null })],
      ["a failed entry", line({ outcome: "failed", http_status: 409, response: "conflict" })],
      ["a dry-run entry", line({ dry_run: true, outcome: "dry-run", http_status: null })],
      ["an entry in another container", line({ container_id: 2 })],
      ["an entry of another kind", line({ kind: "other.kind" })],
    ])("U2: %s never blocks and never hides a blocking entry", (_title, variant) => {
      expect(repeatGuard([variant], KEY)).toBeNull();
      expect(repeatGuard([line(), variant], KEY)).toEqual(line());
    });
  });

  describe("component: the file", () => {
    it("C1: a message holding a newline, a quote and a space is one line and parses back the same", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
        const message = 'first line\nsecond "quoted" line ';
        await appendSendLog(path, line({ message, outcome: "refused", refusal: "safe-mode", http_status: null }));
        const text = await readFile(path, "utf8");
        expect(text.endsWith("\n")).toBe(true);
        expect(text.slice(0, -1).includes("\n")).toBe(false);
        const [entry] = await readLines(path);
        expect(entry?.message).toBe(message);
        const stderr = new Sink();
        expect((await readSendLog(path, stderr))[0]?.message).toBe(message);
        expect(stderr.text).toBe("");
      });
    });

    it("C2: a thousand appends leave the first line's bytes unchanged and every line parses", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
        await appendSendLog(path, line({ target_thing_id: 1 }));
        const first = await readFile(path);
        for (let n = 2; n <= 1000; n += 1) await appendSendLog(path, line({ target_thing_id: n }));
        const whole = await readFile(path);
        expect(whole.subarray(0, first.length).equals(first)).toBe(true);
        const entries = await readSendLog(path, new Sink());
        expect(entries).toHaveLength(1000);
        expect(entries.map((entry) => entry.target_thing_id)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
      });
    }, 30_000);

    it("C3: a truncated last line is skipped with one warning naming the file, and the next append succeeds", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
        await appendSendLog(path, line({ target_thing_id: 1 }));
        await appendSendLog(path, line({ target_thing_id: 2 }));
        const whole = await readFile(path, "utf8");
        await writeFile(path, whole.slice(0, -10), { mode: 0o600 });
        const stderr = new Sink();
        const entries = await readSendLog(path, stderr);
        expect(entries.map((entry) => entry.target_thing_id)).toEqual([1]);
        expect(stderr.text.trim().split("\n")).toHaveLength(1);
        expect(stderr.text).toContain(path);
        await appendSendLog(path, line({ target_thing_id: 3 }));
        const after = await readSendLog(path, new Sink());
        expect(after.map((entry) => entry.target_thing_id)).toEqual([1, 3]);
      });
    });

    it("C4: a missing file reads as empty and is created by the first append", async () => {
      await withTempHome(async (home) => {
        const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
        expect(await readSendLog(path, new Sink())).toEqual([]);
        await expect(stat(path)).rejects.toThrow();
        const handle = await openSendLog(path);
        await handle.close();
        expect((await stat(path)).isFile()).toBe(true);
      });
    });
  });

  describe("component: the opening rule", () => {
    it.skipIf(process.platform === "win32")(
      "C5: the file is created with mode 0600, and fs.open is called with O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW and mode 0o600 (skipped on Windows: no mode and no O_NOFOLLOW there)",
      async () => {
        await withTempHome(async (home) => {
          const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
          const spy = vi.fn(open);
          const fs: AppendFs = { lstat, open: spy as unknown as AppendFs["open"] };
          await appendSendLog(path, line(), fs);
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          const noFollow = noFollowFlag();
          expect(noFollow).toBeTypeOf("number");
          const expected = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (noFollow ?? 0);
          expect(appendOnlyFlags()).toBe(expected);
          expect(spy).toHaveBeenCalledWith(path, expected, 0o600);
        });
      },
    );

    it.skipIf(process.platform === "win32")(
      "C6: a symbolic link at the path is refused with the config kind naming the path, and the target is unchanged (skipped on Windows: symbolic links need a privilege there)",
      async () => {
        await withTempHome(async (home) => {
          const target = join(home.dir, "target.txt");
          await writeFile(target, "untouched\n", { mode: 0o600 });
          const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
          await symlink(target, path);
          const failure = await appendSendLog(path, line()).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(ConfigError);
          expect((failure as ConfigError).kind).toBe("config");
          expect((failure as ConfigError).message).toContain(path);
          expect(await readFile(target, "utf8")).toBe("untouched\n");
        });
      },
    );

    it.skipIf(process.platform === "win32")(
      "C7: without O_NOFOLLOW the lstat fallback refuses the link before any open (the Windows path, exercised here by passing no flag)",
      async () => {
        await withTempHome(async (home) => {
          const target = join(home.dir, "target.txt");
          await writeFile(target, "untouched\n", { mode: 0o600 });
          const path = join(home.dir, ".gripeventsctl.send-log.jsonl");
          await symlink(target, path);
          const opened = vi.fn(open);
          const fs: AppendFs = { lstat, open: opened as unknown as AppendFs["open"] };
          const failure = await openAppendOnly(path, fs, null).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(ConfigError);
          expect((failure as ConfigError).message).toContain(path);
          expect(opened).not.toHaveBeenCalled();
          expect(await readFile(target, "utf8")).toBe("untouched\n");
          // A regular file passes the fallback and is opened without the flag.
          const plain = join(home.dir, "plain.jsonl");
          const handle = await openAppendOnly(plain, fs, null);
          await handle.close();
          expect(opened).toHaveBeenCalledWith(
            plain,
            constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
            0o600,
          );
        });
      },
    );
  });
});
