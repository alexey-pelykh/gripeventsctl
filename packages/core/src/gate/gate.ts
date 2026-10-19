// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The write gate (issue #16 § `OperationContext.gate` and `createWriteGate()`): the one place a write runs. Each
 * surface builds it once per call in its `lib/context.ts`; a write operation passes a `WriteSpec` to `execute()` and
 * never calls the repeat guard, the journal or the lock itself. `execute()` runs this sequence and nothing else may
 * run a write: the switch, the lock, the repeat guard, the status read, the go-ahead check, the plan, the consume,
 * the send, the append. `refuse()` is for the two message-policy refusals the writes raise before the gate.
 *
 * `writesEnabled()` is `config.writes.enabled === true` and nothing else: no environment variable, no flag, no tool
 * argument and no MCP host setting enables writes for one call; this module reads no environment variable and takes
 * no argument that could. A refusal is a result, never an exception: the CLI maps `outcome: "refused"` to exit 4 through
 * the operation's `exitCode`, and the MCP builder returns it as a normal result the assistant can relay. A dry run
 * runs every check, reads the status, sends nothing, and leaves a line flagged `dry_run: true`. Every attempt that
 * reaches a verdict leaves exactly one line, whatever the outcome. Two attempts leave none: `write-busy`, whose line
 * cannot be appended because the log cannot be appended without the lock (its hint says so), and a transport error
 * from the status read, which propagates before any verdict. A lock lost to another writer after it was taken (the
 * holder stalled past the staleness window during the guard or the status read) is `write-busy` too, decided right
 * before the consume, so a guard verdict older than its lock never spends a go-ahead and never sends. The check is
 * not repeated after the consume: a go-ahead spent with no line and a hint to run again would be a worse state than
 * the send that follows the consume at once.
 *
 * The terminal confirmation is the CLI's: `confirm` is present on the CLI path only, runs only where both stdin and
 * stdout are TTYs, and is logged as `go_ahead: "terminal-confirmation"` without touching the journal. Elsewhere a
 * missing go-ahead proposes one and refuses with the id the user approves in a terminal of their own.
 */

import type { Clock } from "../lib/clock.js";
import { redactString, registerSecret } from "../lib/redact.js";
import { GripError, NoSessionError } from "../transport/errors.js";
import { answerMark, lastAnswer } from "../transport/client.js";
import { OP_REFERENCE_PREFIX } from "../config/op.js";
import type { DerivedPaths } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import {
  type GoAheadRecord,
  consumeGoAhead,
  foldJournal,
  goAheadExpiresAt,
  isUnexpired,
  matchesWrite,
  messageSha256,
  proposeGoAhead,
  readJournal,
} from "./go-ahead.js";
import { type WriteLockFn, type WriteLockHandle, type WriteLockOutcome, withWriteLock } from "./lock.js";
import { type WriteKind, type WritePlan, type WriteRequest, type WriteVerdicts, redactRequest } from "./plan.js";
import { type Refusal, type SendLogEntry, appendSendLog, readSendLog, repeatGuard } from "./send-log.js";

export type { Refusal, SendLogEntry } from "./send-log.js";
export type { WriteKind, WritePlan, WriteRequest, WriteVerdicts } from "./plan.js";
export type { GoAheadEvent, GoAheadRecord } from "./go-ahead.js";

/** The go-ahead value of a line the CLI confirmation at a terminal authorised. */
export const TERMINAL_CONFIRMATION = "terminal-confirmation";

/** The most a line carries of a `success: false` answer's `data`, after redaction. */
export const RESPONSE_LENGTH = 1000;

/** The sentence a failed POST's error gains once a journal go-ahead was consumed for it. */
export const GO_AHEAD_USED = "the go-ahead was used; a new one is needed to try again";

export interface WriteSpec<R> {
  kind: WriteKind;
  targetThingId: number;
  /** `null` when the write carries no text. */
  message: string | null;
  dryRun: boolean;
  /** The status read an interest write makes first; chat passes nothing. */
  readStatus?: () => Promise<string>;
  /** `has_match_none` for interest writes. */
  allowedStatus?: string;
  /** Appended to the status-not-none hint; the operation's own sentence. */
  statusHint?: string;
  /** The request the plan shows and `send()` sends. */
  request: WriteRequest;
  /** The POST through `ctx.client.post()`; raises the transport's typed errors. */
  send: () => Promise<R>;
  resultFields: (result: R) => { connection?: number | null; message_id?: number | null };
}

export interface WriteResult {
  plan: WritePlan;
  outcome: "sent" | "refused" | "failed" | "dry-run";
  refusal?: Refusal;
  hint?: string;
  go_ahead_id?: string;
  go_ahead_expires_at?: string;
  connection?: number | null;
  message_id?: number | null;
  log_entry: SendLogEntry;
}

/** What the terminal confirmation shows: the write, in the words the view renders. */
export interface ConfirmationView {
  kind: WriteKind;
  slug: string;
  container_id: number;
  target_thing_id: number;
  message: string;
  message_sha256: string;
}

/**
 * The CLI's terminal confirmation: `interactive` is whether both stdin and stdout are TTYs, read by `execute()` before
 * it calls `run`; `run` shows the view, asks for the challenge code, and answers whether the user typed it.
 */
export interface TerminalConfirmation {
  interactive: boolean;
  run(view: ConfirmationView): Promise<boolean>;
}

export interface WriteGate {
  writesEnabled(): boolean;
  execute<R>(spec: WriteSpec<R>): Promise<WriteResult>;
  refuse(
    spec: Pick<WriteSpec<unknown>, "kind" | "targetThingId" | "message" | "dryRun" | "request">,
    refusal: "message-too-long" | "message-characters",
    hint: string,
  ): Promise<WriteResult>;
}

export interface WriteGateOptions {
  /** The `loadConfig()` result, as `OperationContext.config` holds it, so a hint can name the config path. */
  config: { config: Config; path: string; exists: boolean };
  paths: DerivedPaths;
  clock: Clock;
  source: "cli" | "mcp";
  /** Diagnostics only: the one warning a partial line leaves. */
  stderr: NodeJS.WritableStream;
  /** The CLI's terminal confirmation; absent on MCP. */
  confirm?: TerminalConfirmation;
  /** The lock operation; `proper-lockfile`'s by default. A test injects one that reports a compromise. */
  lock?: WriteLockFn;
}

/** The hint of the safe-mode refusal: the config switch that enables writes, and the file it lives in. */
export function safeModeHint(configPath: string): string {
  return `set writes.enabled: true in ${configPath} to leave safe mode`;
}

/** The hint of the write-busy refusal. */
export function writeBusyHint(lockPath: string): string {
  return `another write holds ${lockPath}; wait for it to finish and run again; no send log line was written`;
}

/** The hint of the repeat-guard refusal, naming the entry that blocks. */
export function repeatGuardHint(kind: WriteKind, thingId: number, time: string, withText: boolean): string {
  const base = `repeat guard: ${kind} to thing ${String(thingId)} was sent on ${time}; a conversation continues in the app`;
  return kind === "interest.show" && withText ? `${base}; the app edits the intro message, this tool does not` : base;
}

/** The hint of the status-not-none refusal, with the operation's own sentence appended where it gives one. */
export function statusNotNoneHint(status: string, allowed: string, statusHint: string | undefined): string {
  const base = `the status is ${status}; this tool posts only to ${allowed}, so an answer you set in the app stays as you set it`;
  return statusHint === undefined || statusHint === "" ? base : `${base}; ${statusHint}`;
}

/** The hint of the go-ahead-missing refusal on the proposal path, word for word. */
export function goAheadMissingHint(id: string): string {
  return `No recorded go-ahead for this text. Ask the user to run gripeventsctl writes go-ahead ${id} in a terminal of their own (not through the host's shell, which has no TTY), then call again with the same thing id and the same text.`;
}

/** The hint of the go-ahead-missing refusal on a dry run, where no proposal is created. */
export const GO_AHEAD_MISSING_DRY_RUN_HINT =
  "no recorded go-ahead for this text; a run that is not a dry run proposes one for the user to approve";

/** The hint of a declined terminal confirmation. */
export const NOT_CONFIRMED_HINT = "not confirmed; nothing was sent";

/** The hint of the go-ahead-expired refusal. */
export function goAheadExpiredHint(id: string, expiredAt: string): string {
  return `the go-ahead ${id} expired at ${expiredAt}; ask the user to run gripeventsctl writes go-ahead on a new proposal`;
}

/** The refusal a dry run reports: the first failing verdict, in the sequence's order. */
export function firstFailingVerdict(verdicts: WriteVerdicts): Refusal | undefined {
  if (!verdicts.writes_enabled) return "safe-mode";
  if (verdicts.repeat_guard === "blocked") return "repeat-guard";
  if (verdicts.status === "not-none") return "status-not-none";
  if (verdicts.go_ahead === "missing") return "go-ahead-missing";
  if (verdicts.go_ahead === "expired") return "go-ahead-expired";
  return undefined;
}

/** The `response` field of a failed line: the error's redacted body excerpt, or its kind, cut to the length. */
function responseOf(error: unknown): string {
  if (error instanceof GripError) return (error.bodyExcerpt ?? error.kind).slice(0, RESPONSE_LENGTH);
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message).slice(0, RESPONSE_LENGTH);
}

/** The HTTP status an error carries, where it classified an answer. */
function statusOf(error: unknown): number | null {
  return error instanceof GripError && error.status !== undefined ? error.status : null;
}

/** The matching journal record for a write: the newest usable one, else the newest expired approval, else none. */
function findGoAhead(
  records: ReadonlyMap<string, GoAheadRecord>,
  write: { kind: string; container_id: number; target_thing_id: number; message_sha256: string },
  now: Date,
): { usable?: GoAheadRecord; expired?: GoAheadRecord } {
  let usable: GoAheadRecord | undefined;
  let expired: GoAheadRecord | undefined;
  for (const record of records.values()) {
    if (record.state !== "approved" || !matchesWrite(record, write)) continue;
    if (isUnexpired(record, now)) usable = record;
    else expired = record;
  }
  return { ...(usable === undefined ? {} : { usable }), ...(expired === undefined ? {} : { expired }) };
}

/** The write gate over `options`; nothing is read or written until `execute()` or `refuse()` runs. */
export function createWriteGate(options: WriteGateOptions): WriteGate {
  const { config, paths, clock, source, stderr, confirm } = options;
  const lockOptions = options.lock === undefined ? {} : { lock: options.lock };
  const token = config.config.session?.token;
  // The stored token is a secret this process already holds: registered, so no hint or plan can carry it.
  if (token !== undefined && !token.startsWith(OP_REFERENCE_PREFIX)) registerSecret(token);

  // Read as `unknown`: a config built by hand may hold another value, and only the boolean `true` enables writes.
  const writesEnabled = (): boolean => {
    const enabled: unknown = config.config.writes.enabled;
    return enabled === true;
  };

  const containerId = (): number => {
    const session = config.config.session;
    if (session === undefined) throw new NoSessionError(`no session in ${config.path}`);
    return session.container_id;
  };

  interface Attempt {
    plan: WritePlan;
    message: string | null;
    message_sha256: string | null;
    dryRun: boolean;
  }

  const attemptOf = (
    spec: Pick<WriteSpec<unknown>, "kind" | "targetThingId" | "message" | "dryRun" | "request">,
    status: WriteVerdicts["status"],
  ): Attempt => ({
    plan: {
      kind: spec.kind,
      container_id: containerId(),
      target_thing_id: spec.targetThingId,
      request: redactRequest(spec.request),
      status_before: null,
      verdicts: {
        writes_enabled: writesEnabled(),
        repeat_guard: "clear",
        status,
        go_ahead: spec.message === null ? "not-needed" : "missing",
      },
    },
    message: spec.message,
    message_sha256: spec.message === null ? null : messageSha256(spec.message),
    dryRun: spec.dryRun,
  });

  const lineOf = (
    attempt: Attempt,
    fields: Pick<SendLogEntry, "outcome" | "refusal" | "go_ahead" | "http_status" | "response"> &
      Partial<Pick<SendLogEntry, "connection" | "message_id">>,
  ): SendLogEntry => ({
    time: clock.now().toISOString(),
    kind: attempt.plan.kind,
    source,
    container_id: attempt.plan.container_id,
    target_thing_id: attempt.plan.target_thing_id,
    status_before: attempt.plan.status_before,
    message: attempt.message,
    message_sha256: attempt.message_sha256,
    go_ahead: fields.go_ahead,
    dry_run: attempt.dryRun,
    outcome: fields.outcome,
    refusal: fields.refusal,
    http_status: fields.http_status,
    response: fields.response,
    connection: fields.connection ?? null,
    message_id: fields.message_id ?? null,
  });

  const refusedLine = (attempt: Attempt, refusal: Refusal, go_ahead: string | null = null): SendLogEntry =>
    lineOf(attempt, { outcome: "refused", refusal, go_ahead, http_status: null, response: null });

  const refused = (
    attempt: Attempt,
    refusal: Refusal,
    hint: string,
    entry: SendLogEntry,
    extra: Pick<WriteResult, "go_ahead_id" | "go_ahead_expires_at"> = {},
  ): WriteResult => ({ plan: attempt.plan, outcome: "refused", refusal, hint, ...extra, log_entry: entry });

  const busy = (attempt: Attempt): WriteResult =>
    refused(attempt, "write-busy", writeBusyHint(paths.writeLock), refusedLine(attempt, "write-busy"));

  /** Append `entry` under the lock; busy after the retries is the write-busy result instead. */
  const appendRefusal = async (attempt: Attempt, refusal: Refusal, hint: string): Promise<WriteResult> => {
    const entry = refusedLine(attempt, refusal);
    const outcome = await withWriteLock(paths.writeLock, () => appendSendLog(paths.sendLog, entry), lockOptions);
    return outcome.taken ? refused(attempt, refusal, hint, entry) : busy(attempt);
  };

  async function execute<R>(spec: WriteSpec<R>): Promise<WriteResult> {
    // 1. The plan skeleton; a missing session is `no-session`.
    const attempt = attemptOf(spec, spec.readStatus === undefined ? "not-read" : "allowed");
    const { plan } = attempt;
    const write = {
      kind: plan.kind,
      container_id: plan.container_id,
      target_thing_id: plan.target_thing_id,
      message_sha256: attempt.message_sha256 ?? "",
    };

    // 2. The switch: safe mode refuses before anything else; a dry run records the verdict and goes on.
    if (!writesEnabled() && !spec.dryRun) return appendRefusal(attempt, "safe-mode", safeModeHint(config.path));

    // 3. The lock, held from the repeat guard to the append.
    const locked: WriteLockOutcome<WriteResult> = await withWriteLock(
      paths.writeLock,
      async (lock: WriteLockHandle): Promise<WriteResult> => {
        // 4. The repeat guard over the send log as it is now.
        const blocking = repeatGuard(await readSendLog(paths.sendLog, stderr), write);
        if (blocking !== null) {
          plan.verdicts.repeat_guard = "blocked";
          if (!spec.dryRun) {
            const hint = repeatGuardHint(plan.kind, plan.target_thing_id, blocking.time, attempt.message !== null);
            const entry = refusedLine(attempt, "repeat-guard");
            await appendSendLog(paths.sendLog, entry);
            return refused(attempt, "repeat-guard", hint, entry);
          }
        }

        // 5. The status read: the one platform call inside the lock before the POST. A transport error propagates
        // after the lock is released, with nothing appended: the attempt never reached a verdict.
        if (spec.readStatus !== undefined) {
          const status = await spec.readStatus();
          plan.status_before = status;
          if (status !== spec.allowedStatus) {
            plan.verdicts.status = "not-none";
            if (!spec.dryRun) {
              const hint = statusNotNoneHint(status, spec.allowedStatus ?? "", spec.statusHint);
              const entry = refusedLine(attempt, "status-not-none");
              await appendSendLog(paths.sendLog, entry);
              return refused(attempt, "status-not-none", hint, entry);
            }
          }
        }

        // 6. The go-ahead check for a write that carries a text.
        let journalGoAhead: GoAheadRecord | undefined;
        let expiredGoAhead: GoAheadRecord | undefined;
        let goAheadId: string | null = null;
        if (attempt.message !== null) {
          const now = clock.now();
          const found = findGoAhead(foldJournal(await readJournal(paths.goAheads, stderr)), write, now);
          expiredGoAhead = found.expired;
          if (found.usable !== undefined) {
            plan.verdicts.go_ahead = "recorded";
            journalGoAhead = found.usable;
            goAheadId = found.usable.id;
          } else if (found.expired !== undefined && !spec.dryRun) {
            plan.verdicts.go_ahead = "expired";
            const proposal = await proposeGoAhead(
              paths.goAheads,
              { ...write, message: attempt.message, source },
              clock,
            );
            const hint = goAheadExpiredHint(found.expired.id, goAheadExpiresAt(found.expired).toISOString());
            const entry = refusedLine(attempt, "go-ahead-expired");
            await appendSendLog(paths.sendLog, entry);
            return refused(attempt, "go-ahead-expired", hint, entry, {
              go_ahead_id: proposal.id,
              go_ahead_expires_at: goAheadExpiresAt(proposal).toISOString(),
            });
          } else if (found.expired !== undefined) {
            plan.verdicts.go_ahead = "expired";
          } else if (spec.dryRun) {
            plan.verdicts.go_ahead = "missing";
          } else if (confirm?.interactive) {
            let confirmed: boolean;
            try {
              confirmed = await confirm.run({
                kind: plan.kind,
                slug: config.config.session?.slug ?? "",
                container_id: plan.container_id,
                target_thing_id: plan.target_thing_id,
                message: attempt.message,
                message_sha256: write.message_sha256,
              });
            } catch {
              confirmed = false;
            }
            if (!confirmed) {
              const entry = refusedLine(attempt, "go-ahead-missing");
              await appendSendLog(paths.sendLog, entry);
              return refused(attempt, "go-ahead-missing", NOT_CONFIRMED_HINT, entry);
            }
            plan.verdicts.go_ahead = "recorded";
            goAheadId = TERMINAL_CONFIRMATION;
          } else {
            const proposal = await proposeGoAhead(
              paths.goAheads,
              { ...write, message: attempt.message, source },
              clock,
            );
            const entry = refusedLine(attempt, "go-ahead-missing");
            await appendSendLog(paths.sendLog, entry);
            return refused(attempt, "go-ahead-missing", goAheadMissingHint(proposal.id), entry, {
              go_ahead_id: proposal.id,
              go_ahead_expires_at: goAheadExpiresAt(proposal).toISOString(),
            });
          }
        }

        // 7. The plan is complete. A dry run leaves its line and sends nothing.
        if (spec.dryRun) {
          const failing = firstFailingVerdict(plan.verdicts);
          const entry = lineOf(attempt, {
            outcome: failing === undefined ? "dry-run" : "refused",
            refusal: failing ?? null,
            go_ahead: goAheadId,
            http_status: null,
            response: null,
          });
          await appendSendLog(paths.sendLog, entry);
          if (failing === undefined) return { plan, outcome: "dry-run", log_entry: entry };
          const hint =
            failing === "safe-mode"
              ? safeModeHint(config.path)
              : failing === "repeat-guard"
                ? repeatGuardHint(plan.kind, plan.target_thing_id, blocking?.time ?? "", attempt.message !== null)
                : failing === "status-not-none"
                  ? statusNotNoneHint(plan.status_before ?? "", spec.allowedStatus ?? "", spec.statusHint)
                  : failing === "go-ahead-expired"
                    ? goAheadExpiredHint(
                        expiredGoAhead?.id ?? "",
                        expiredGoAhead === undefined ? "" : goAheadExpiresAt(expiredGoAhead).toISOString(),
                      )
                    : GO_AHEAD_MISSING_DRY_RUN_HINT;
          return refused(attempt, failing, hint, entry);
        }

        // The lock must still be this process's: a verdict read before the lock was lost to another writer is stale.
        if (lock.compromised()) return busy(attempt);

        // 8. The consume, on disk before the POST leaves: a crash between the two leaves the go-ahead used.
        if (journalGoAhead !== undefined) await consumeGoAhead(paths.goAheads, journalGoAhead, source, clock);

        // 9. The send; the transport's 429 backoff runs inside this await, under the lock.
        const mark = answerMark();
        let answer: R;
        try {
          answer = await spec.send();
        } catch (error: unknown) {
          // 10. The append of a failed attempt, then the error re-raised for the surface's exit code or error result.
          await appendSendLog(
            paths.sendLog,
            lineOf(attempt, {
              outcome: "failed",
              refusal: null,
              go_ahead: goAheadId,
              http_status: statusOf(error),
              response: responseOf(error),
            }),
          );
          if (journalGoAhead !== undefined && error instanceof Error)
            error.message = `${error.message}; ${GO_AHEAD_USED}`;
          throw error;
        }
        const last = lastAnswer();
        const http_status =
          last !== undefined && last.sequence > mark && last.method === "POST" && last.path === spec.request.path
            ? last.status
            : null;
        const fields = spec.resultFields(answer);
        // 10. The append of a sent attempt.
        const entry = lineOf(attempt, {
          outcome: "sent",
          refusal: null,
          go_ahead: goAheadId,
          http_status,
          response: null,
          ...(fields.connection === undefined ? {} : { connection: fields.connection }),
          ...(fields.message_id === undefined ? {} : { message_id: fields.message_id }),
        });
        await appendSendLog(paths.sendLog, entry);
        return {
          plan,
          outcome: "sent",
          ...(goAheadId === null ? {} : { go_ahead_id: goAheadId }),
          ...(fields.connection === undefined ? {} : { connection: fields.connection }),
          ...(fields.message_id === undefined ? {} : { message_id: fields.message_id }),
          log_entry: entry,
        };
      },
      lockOptions,
    );
    return locked.taken ? locked.value : busy(attempt);
  }

  async function refuse(
    spec: Pick<WriteSpec<unknown>, "kind" | "targetThingId" | "message" | "dryRun" | "request">,
    refusal: "message-too-long" | "message-characters",
    hint: string,
  ): Promise<WriteResult> {
    return appendRefusal(attemptOf(spec, "not-read"), refusal, hint);
  }

  return { writesEnabled, execute, refuse };
}
