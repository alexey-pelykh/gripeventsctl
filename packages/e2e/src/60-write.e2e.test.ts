// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 60-write (issue #18 § The nine files, item 8): the one guarded write of the suite, `chat send` to the
 * caller's own thing id, in two steps, as any MCP write runs: the dry run, the first real call refused
 * with `go-ahead-missing` and a proposal, the maintainer's approval in a terminal of their own (polled
 * from the journal read-only; the test never appends to it and never calls `writes go-ahead`), then
 * the second call. The message text is fixed per run date, so the recorded go-ahead's message hash
 * matches across the calls of one run; once a run has sent, the repeat guard holds that self-write for
 * the container and every later run is inconclusive. A go-ahead approved in an earlier run of the same
 * date that is still usable would let the first real call send, so the dry run's `go_ahead` verdict
 * stops the run first. Step 8 reads the send log and asserts the three lines the run left.
 */

import { foldJournal, readJournal, readSendLog, redactString, systemClock } from "@gripeventsctl/core";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { type LiveFixture, callLive, checkedCall, openLive, report } from "./lib/live-check.js";
import {
  type Outcome,
  classify,
  conclude,
  drift,
  errorKind,
  inconclusive,
  isPositiveInteger,
  isRecord,
  requireRecord,
} from "./lib/outcome.js";
import { runDate, templatePath } from "./lib/summary.js";

const FILE = "60-write";
const TOOL = "gripeventsctl_chat_send";
const KIND = "chat.send";
/** How often the journal is read while the maintainer approves, and for how long at most. */
const POLL_MS = 2_000;
const APPROVAL_WAIT_MS = 120_000;

vi.setConfig({ testTimeout: 180_000 });

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 60-write: the one guarded self-message through the gate", () => {
  it("dry-runs, is refused without a go-ahead, waits for the maintainer's approval, then sends once", async (ctx) => {
    const { session, server } = fixture.ready(ctx);

    // 1. Writes off: nothing else runs.
    if (!session.writesEnabled) inconclusive(ctx, `writes are off: set writes.enabled: true in ${session.configPath}`);

    // 2. The caller's own thing id.
    const { content: me } = await checkedCall(
      ctx,
      FILE,
      server,
      "gripeventsctl_attendees_get",
      { thing_id: "user_id" },
      ["id"],
    );
    const thingId = me["id"];
    if (!isPositiveInteger(thingId)) return drift("id of the caller's own record is not a positive integer");
    const message = `gripeventsctl e2e self-message ${runDate()}`;
    const logMark = (await readSendLog(session.sendLogPath, process.stderr)).length;
    const ownLines = async (): Promise<Awaited<ReturnType<typeof readSendLog>>> =>
      (await readSendLog(session.sendLogPath, process.stderr))
        .slice(logMark)
        .filter(
          (entry) =>
            entry.kind === KIND && entry.container_id === session.containerId && entry.target_thing_id === thingId,
        );

    // 3. The dry run: the plan, the verdicts, nothing sent.
    const dry = await checkedCall(ctx, FILE, server, TOOL, { thing_id: thingId, message, dry_run: true }, [
      "plan.request.method",
      "plan.request.path",
      "plan.verdicts.writes_enabled",
      "plan.verdicts.repeat_guard",
      "plan.verdicts.go_ahead",
      "outcome",
    ]);
    const request = requireRecord(dry.content, "plan.request");
    const verdicts = requireRecord(dry.content, "plan.verdicts");
    if (
      request["method"] !== "POST" ||
      typeof request["path"] !== "string" ||
      !templatePath(request["path"], "chat/thing/<thing id>")
    ) {
      drift("plan.request is not POST chat/thing/<thing id>");
    }
    const body = request["body"];
    if (!isRecord(body) || !("message" in body) || !("container_id" in body)) {
      drift("plan.request.body does not hold message and container_id");
    }
    if (verdicts["writes_enabled"] !== true) drift("plan.verdicts.writes_enabled is not true");
    if (verdicts["repeat_guard"] === "blocked") {
      const earlier = (await readSendLog(session.sendLogPath, process.stderr))
        .filter(
          (entry) =>
            entry.kind === KIND &&
            entry.container_id === session.containerId &&
            entry.outcome === "sent" &&
            !entry.dry_run,
        )
        .at(-1);
      inconclusive(
        ctx,
        `the repeat guard holds a sent ${KIND} entry for this container from ${earlier?.time ?? "an earlier run"}`,
      );
    }
    if (verdicts["go_ahead"] === "recorded") {
      inconclusive(
        ctx,
        "a recorded go-ahead from an earlier run of this date still covers this text, so the first real call would send; run again once it has expired (24 hours) or on another date",
      );
    }
    if (dry.call.calls.length > 0) drift("the dry run sent a request");

    // 4. The first real call: refused for the missing go-ahead, with a proposal. A sent message here means the gate
    // did not hold, and the pull request stops.
    const refused = await checkedCall(ctx, FILE, server, TOOL, { thing_id: thingId, message }, ["outcome"]);
    if (refused.content["outcome"] === "sent")
      drift("a message was sent without a recorded go-ahead: the gate did not hold");
    if (refused.content["outcome"] !== "refused" || refused.content["refusal"] !== "go-ahead-missing") {
      drift("the first real call is not refused with go-ahead-missing");
    }
    const id = refused.content["go_ahead_id"];
    if (typeof id !== "string" || id.length !== 11) return drift("go_ahead_id is not 11 characters");
    if (typeof refused.content["go_ahead_expires_at"] !== "string") drift("go_ahead_expires_at is absent");
    if (refused.call.calls.length > 0) drift("the refused call sent a request");

    // 5. The maintainer approves in a terminal of their own: Vitest workers have no TTY.
    process.stderr.write(redactString(`approve in a terminal of your own: gripeventsctl writes go-ahead ${id}\n`));

    // 6. Poll the journal read-only until the proposal's latest event is `approved`.
    const deadline = Date.now() + APPROVAL_WAIT_MS;
    let approved = false;
    while (Date.now() < deadline) {
      const record = foldJournal(await readJournal(session.journalPath, process.stderr)).get(id);
      if (record?.state === "approved") {
        approved = true;
        break;
      }
      await systemClock.sleep(POLL_MS);
    }
    if (!approved) inconclusive(ctx, `go-ahead ${id} not approved within ${String(APPROVAL_WAIT_MS / 1_000)} s`);

    // 7. The second call, the same text: sent with a message id, or the platform's own refusal of a self-thread.
    const sent = await callLive(server, TOOL, { thing_id: thingId, message });
    let outcome: Outcome;
    let reason: string | undefined;
    let outcomeWord: string;
    if (sent.result.isError === true) {
      const kind = errorKind(sent.result);
      const failed = classify(sent.result, []);
      outcomeWord = "failed";
      if (kind === "api") {
        outcome = "inconclusive";
        reason = "the platform offers no self-thread";
        process.stderr.write(
          redactString(
            `${FILE}: the self-message was answered HTTP ${String(sent.calls.at(-1)?.status ?? "-")}, kind api\n`,
          ),
        );
      } else {
        outcome = failed.outcome;
        reason = failed.reason;
      }
    } else if (sent.content?.["outcome"] === "sent" && isPositiveInteger(sent.content["message_id"])) {
      outcome = "verified";
      outcomeWord = "sent";
    } else {
      outcome = "contract-drift";
      outcomeWord = String(sent.content?.["outcome"]);
      reason = `the second call's outcome is ${outcomeWord}${typeof sent.content?.["refusal"] === "string" ? ` (${sent.content["refusal"]})` : ""}, not sent`;
    }
    report(FILE, sent, outcome);

    // 8. The send log: the dry run's line, the refused line, and exactly one line for the second call, in order.
    const lines = await ownLines();
    if (lines.length !== 3) drift(`the send log gained ${String(lines.length)} ${KIND} line(s) for this target, not 3`);
    const [first, second, third] = lines;
    if (first?.dry_run !== true || (first.outcome !== "dry-run" && first.outcome !== "refused")) {
      drift("the first new send log line is not the dry run's");
    }
    if (second?.dry_run !== false || second.outcome !== "refused" || second.refusal !== "go-ahead-missing") {
      drift("the second new send log line is not the go-ahead-missing refusal");
    }
    if (third?.dry_run !== false || third.outcome !== outcomeWord || third.source !== "mcp") {
      drift(`the third new send log line is not the ${outcomeWord} line of the second call from the mcp source`);
    }
    conclude(ctx, outcome, reason);
  });
});
