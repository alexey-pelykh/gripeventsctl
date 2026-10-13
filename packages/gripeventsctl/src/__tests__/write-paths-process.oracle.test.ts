// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-GATE, process level (P42): two processes write to one target with one
 * approved go-ahead, released together, and exactly one POST leaves. It is the process-level part of
 * `write-paths.oracle.test.ts`, split out by level. Each process is a worker written here at run
 * time that imports the built core (`packages/core/dist`), as a CLI and an MCP server on one machine
 * would, and runs one write through `createWriteGate()`. The two coordinate through IPC, never sleeps.
 *
 * Written before the write gate exists, from the write gate item (#16) § The write lock and
 * § `createWriteGate()`. The implementing change leaves this file byte-identical.
 */

import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Imports a probed subject. Resolves to `undefined` only when the module runner reports the probed
 * specifier itself as not found. Any other failure (the subject throws at import, a syntax error, a
 * dependency of the subject is missing) is rethrown, so the file fails instead of skipping.
 */
async function importSubject(specifier: string): Promise<unknown> {
  try {
    return await import(specifier);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const found = /^Cannot find (?:module|package) '([^']*)' imported from /.exec(message)?.[1];
    const tail = specifier.replace(/^(?:\.\.?\/)+/, "");
    const subjectNotFound =
      code === "ERR_MODULE_NOT_FOUND" && found !== undefined && (found === tail || found.endsWith(`/${tail}`));
    const entryNotFound = message.startsWith(`Failed to resolve entry for package "${specifier}"`);
    if (subjectNotFound || entryNotFound) return undefined;
    throw error;
  }
}

// Oracle subject: packages/core/src/gate/gate.ts, built into packages/core/dist (not built yet when
// this file was written). The workers import the same file.
const CORE_DIST = new URL("../../../core/dist/index.js", import.meta.url).href;
const core = (await importSubject(CORE_DIST)) as { createWriteGate?: unknown } | undefined;
const subject = typeof core?.createWriteGate === "function" ? core : undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error("oracle subject missing: packages/core/src/gate/gate.ts (built into packages/core/dist)");
}

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MESSAGE = "synthetic message 1";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface Worker {
  child: ChildProcess;
  inbox: Record<string, unknown>[];
  stderr(): string;
  exited: Promise<number | null>;
}

function startWorker(script: string, options: object, env: NodeJS.ProcessEnv): Worker {
  const child = fork(script, [JSON.stringify(options)], {
    env,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const inbox: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("message", (message: Record<string, unknown>) => inbox.push(message));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, inbox, stderr: () => stderr, exited };
}

/** Resolves with the first message of `type` the worker sent, or rejects when it exits without one. */
function waitFor(worker: Worker, type: string): Promise<Record<string, unknown>> {
  const found = (): Record<string, unknown> | undefined => worker.inbox.find((message) => message["type"] === type);
  return new Promise((resolve, reject) => {
    const early = found();
    if (early !== undefined) {
      resolve(early);
      return;
    }
    const onMessage = (): void => {
      const message = found();
      if (message !== undefined) resolve(message);
    };
    worker.child.on("message", onMessage);
    void worker.exited.then(() => {
      const message = found();
      if (message !== undefined) resolve(message);
      else reject(new Error(`worker exited before "${type}": ${JSON.stringify(worker.inbox)} ${worker.stderr()}`));
    });
  });
}

describe.skipIf(subject === undefined)(
  "[CAP-GATE] no write request leaves the process unless writes are enabled, the repeat guard is clear and a needed go-ahead is recorded, with one critical section per write",
  () => {
    let home = "";

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-two-writers-"));
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    describe("process", () => {
      it("P42: two processes, one target, one approved go-ahead: one POST, one sent line, and the other write refused", async () => {
        const configFile = join(home, ".gripeventsctl.yaml");
        const token = randomUUID();
        await writeFile(
          configFile,
          [
            "version: 1",
            "session:",
            "  slug: test-event-1",
            "  container_id: 1",
            `  token: ${token}`,
            '  signed_in_at: "2026-10-12T10:00:00.000Z"',
            "writes:",
            "  enabled: true",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        // #4 § Path resolution and derived paths: the three files sit beside the config.
        const paths = {
          sendLog: join(home, ".gripeventsctl.send-log.jsonl"),
          goAheads: join(home, ".gripeventsctl.go-aheads.jsonl"),
          writeLock: join(home, ".gripeventsctl.write.lock"),
        };
        // #16 § The go-ahead journal: one proposed and one approved event for the one write.
        const id = randomBytes(8).toString("base64url");
        const fields = { kind: "chat.send", container_id: 1, target_thing_id: 2, message_sha256: sha256(MESSAGE) };
        const proposed = {
          time: new Date(T0 - 3_600_000).toISOString(),
          event: "proposed",
          id,
          ...fields,
          message: MESSAGE,
          source: "mcp",
        };
        const approved = {
          time: new Date(T0 - 1_800_000).toISOString(),
          event: "approved",
          id,
          ...fields,
          source: "cli",
        };
        await appendFile(paths.goAheads, `${JSON.stringify(proposed)}\n${JSON.stringify(approved)}\n`, { mode: 0o600 });

        const script = join(home, "gate-worker.mjs");
        await writeFile(script, WORKER_SOURCE);
        const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, GRIPEVENTSCTL_CONFIG_FILE: configFile };
        for (const name of ["PATH", "SYSTEMROOT", "TMPDIR"]) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        // The POST takes 300 ms inside the lock, well inside the five one-second lock retries.
        const options = { coreUrl: CORE_DIST, configFile, token, paths, now: T0, holdMs: 300, message: MESSAGE };
        const workers = [startWorker(script, options, env), startWorker(script, options, env)];

        // The barrier: both are ready before either is released, and both are released together.
        await Promise.all(workers.map((worker) => waitFor(worker, "ready")));
        for (const worker of workers) worker.child.send({ type: "go" });
        const results = await Promise.all(workers.map((worker) => waitFor(worker, "result")));
        expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0]);

        const postings = workers.flatMap((worker) => worker.inbox.filter((message) => message["type"] === "posting"));
        expect(postings).toHaveLength(1);
        const outcomes = results.map((result) => result["outcome"]).sort();
        expect(outcomes).toEqual(["refused", "sent"]);
        const refusal = results.find((result) => result["outcome"] === "refused")?.["refusal"];
        expect(["repeat-guard", "write-busy"]).toContain(refusal);

        const lines = await readLines(paths.sendLog);
        expect(lines.filter((line) => line["outcome"] === "sent")).toHaveLength(1);
        // A write-busy refusal is the one attempt that leaves no line on disk.
        expect(lines.filter((line) => line["outcome"] === "refused")).toHaveLength(refusal === "repeat-guard" ? 1 : 0);
        expect(lines).toHaveLength(refusal === "repeat-guard" ? 2 : 1);
        const journal = await readLines(paths.goAheads);
        expect(journal.filter((event) => event["id"] === id && event["event"] === "consumed")).toHaveLength(1);
      }, 60_000);
    });
  },
);

/**
 * The worker: it imports the built core, waits for `go`, runs one chat-shaped write to thing 2 with
 * source `mcp` through the gate, reports `posting` from inside `send`, holds the POST for `holdMs`,
 * answers the documented chat answer (docs/api/chat-and-meetings.md § Send a chat message), and
 * reports the result.
 */
const WORKER_SOURCE = `
import { Writable } from "node:stream";
const options = JSON.parse(process.argv[2]);
const { createWriteGate } = await import(options.coreUrl);
const session = { slug: "test-event-1", container_id: 1, token: options.token, signed_in_at: "2026-10-12T10:00:00.000Z" };
const config = { config: { version: 1, session, writes: { enabled: true } }, path: options.configFile, exists: true };
const clock = { now: () => new Date(options.now), sleep: () => Promise.resolve(), timeoutSignal: (ms) => AbortSignal.timeout(ms) };
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
process.on("message", (message) => {
  if (message?.type !== "go") return;
  const gate = createWriteGate({ config, paths: options.paths, clock, source: "mcp", stderr });
  gate.execute({
    kind: "chat.send",
    targetThingId: 2,
    message: options.message,
    dryRun: false,
    request: { method: "POST", path: "chat/thing/2", body: { message: options.message, container_id: 1 } },
    send: async () => {
      process.send({ type: "posting" });
      await new Promise((resolve) => setTimeout(resolve, options.holdMs));
      return { message_id: 7 };
    },
    resultFields: (result) => ({ message_id: result.message_id }),
  }).then(
    (result) => process.send({ type: "result", outcome: result.outcome, refusal: result.refusal ?? null }, () => process.exit(0)),
    (error) => process.send({ type: "error", message: String(error && error.message) }, () => process.exit(1)),
  );
});
process.send({ type: "ready" });
`;
