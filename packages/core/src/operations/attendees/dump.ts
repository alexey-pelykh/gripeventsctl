// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `attendees dump --type <ids> --out <path>` (issue #11 § `attendees dump`): every page of the directory search until
 * `data` is empty, appended page by page to one JSON Lines file the tool creates exclusively at the path the user
 * named (`export-file.ts`), with the pause and the stop rule the 2026 dump lacked. Grip has announced automatic
 * blocking of attendee-list scraping (`docs/api/platform-landscape.md` § Blocking of attendee-list scraping), so the
 * run is paced and stops at the first refusal.
 *
 * The run: `openExportFile()` first, so a refused path sends no request; then pages from 1 upward, one
 * `GripClient.get()` each, never two in flight. Each entry is written as one line, `JSON.stringify(entry)` through
 * `redactString`, through the one handle; then one progress line `page <n>: <k> entries (<total> so far)` on stderr
 * (CLI) or one `notifications/progress` (MCP, when the call carried a progress token); then, when the page held any
 * entry and the signal is not aborted, `clock.sleep(1_500)` with nothing in flight. The run ends on the first empty
 * page (`stopped_on: "end"`, that page being the final request), when `ctx.signal` aborts (no further request,
 * `stopped_on: "cancelled"`: the pause, a queue wait and a 429 wait end at once, a request already sent runs to its
 * answer and its page is kept), or when a request raises `auth-failed`, `gated-type`, `throttled` (the backoff
 * schedule exhausted), `load-balancer-rejected`, `network` or `api` (no further request, `stopped_on` that kind,
 * `hint` the error's hint, and the error's message and hint written to stderr before the operation returns). The
 * handle is closed on every path, and a stopped run returns normally so the result is printed and the file keeps
 * every page written: `exitCode(output)` turns `stopped_on` into the CLI exit code (0 for `end`, 130 for
 * `cancelled`, else the kind's code from the exit-code table). An error of another kind (`no-session` or `config`
 * from a token that cannot be resolved mid-run) is not an outcome the output names and propagates; the file keeps
 * its pages. The pause is never shortened, no retry around a 403 with another session, header set or address.
 */

import { z } from "zod";

import { redactString } from "../../lib/redact.js";
import { GripError } from "../../transport/errors.js";
import { type OperationContext, defineOperation } from "../operation.js";
import { openExportFile, resolveExportPath } from "./export-file.js";
import { containerIdOf, signalOption } from "../context.js";
import {
  SEARCH_REQUEST,
  type SearchEntry,
  TYPE_IDS_HELP,
  searchPageSchema,
  searchPath,
  searchQuery,
} from "./search.js";

/** The pause between two pages, the 2026 dump's choice; not user-adjustable. */
export const PAGE_PAUSE_MS = 1_500;

/** How a run ended: the empty page, the caller's cancellation, or the kind of the error that stopped it. */
export const STOPPED_ON = [
  "end",
  "cancelled",
  "auth-failed",
  "gated-type",
  "throttled",
  "load-balancer-rejected",
  "network",
  "api",
] as const;

export type StoppedOn = (typeof STOPPED_ON)[number];

/** The error kinds that stop a run as an outcome; every other kind propagates. */
const STOPPING_KINDS: ReadonlySet<string> = new Set(STOPPED_ON);

function isStoppingKind(kind: string): kind is StoppedOn {
  return STOPPING_KINDS.has(kind);
}

/** The conventional exit code of a run ended by SIGINT (128 + 2). */
export const CANCELLED_EXIT_CODE = 130;

/**
 * The CLI exit code of each outcome: 0 for `end`, 130 for `cancelled`, else the kind's row of the exit-code table
 * (`packages/cli/src/lib/exit-codes.ts`, which a CLI test checks this map against).
 */
export const DUMP_EXIT_CODES: Readonly<Record<StoppedOn, number>> = Object.freeze({
  end: 0,
  cancelled: CANCELLED_EXIT_CODE,
  "auth-failed": 3,
  "gated-type": 6,
  throttled: 5,
  "load-balancer-rejected": 6,
  network: 7,
  api: 1,
});

/** What the MCP tool description carries after the two read sentences. */
export const DUMP_DESCRIPTION_SUFFIX =
  "A dump reads the whole directory page by page over minutes and writes attendee data to the file named in `out`, and only there. Grip has announced automatic blocking of attendee-list scraping, so a dump risks the account's access to the event. Call it only when the user asked for an export.";

export const attendeesDumpInput = z.object({
  type_ids: z.array(z.number().int().positive()).min(1).describe(TYPE_IDS_HELP),
  /** The JSON Lines file to create; no default, so nothing is written unless the user named a file. */
  out: z.string().min(1).describe("the .jsonl file to create for the export; it must not exist yet"),
});

export const attendeesDumpOutput = z.object({
  /** The number of non-empty pages written; pages run from 1, so also the last page written. */
  pages: z.number().int().min(0),
  /** The number of lines written. */
  entries: z.number().int().min(0),
  stopped_on: z.enum(STOPPED_ON),
  /** The absolute path of the file. */
  out: z.string(),
  /** The hint of the error that stopped the run; `null` otherwise. */
  hint: z.string().nullable(),
});

export type AttendeesDumpOutput = z.infer<typeof attendeesDumpOutput>;

/** The progress line of one page. */
export function progressMessage(page: number, count: number, total: number): string {
  return `page ${String(page)}: ${String(count)} entries (${String(total)} so far)`;
}

/** The human form: the summary line, `stopped: <stopped_on>` and, where the run stopped on an error, `hint: <hint>`. */
export function renderAttendeesDump(output: AttendeesDumpOutput): string {
  const lines = [
    `wrote ${String(output.entries)} entries from ${String(output.pages)} pages to ${output.out}`,
    `stopped: ${output.stopped_on}`,
  ];
  if (output.hint !== null) lines.push(`hint: ${output.hint}`);
  return lines.join("\n");
}

/** True once the caller cancelled the run. A function, so the flag is read again after every await. */
function cancelled(ctx: OperationContext): boolean {
  return ctx.signal?.aborted === true;
}

/** The page pause, ended at once by the signal: resolves normally in both cases; the caller reads `cancelled()`. */
async function pause(ctx: OperationContext): Promise<void> {
  try {
    await ctx.clock.sleep(PAGE_PAUSE_MS, ctx.signal);
  } catch (error: unknown) {
    if (!cancelled(ctx)) throw error;
  }
}

export const attendeesDump = defineOperation({
  group: "attendees",
  verb: "dump",
  kind: "read",
  description: "Export the attendee directory of the given type ids to a JSON Lines file you name",
  needsSession: true,
  input: attendeesDumpInput,
  output: attendeesDumpOutput,
  requests: [SEARCH_REQUEST],
  cli: { flags: { type_ids: "type" } },
  mcp: { descriptionSuffix: DUMP_DESCRIPTION_SUFFIX },
  render: { human: renderAttendeesDump },
  exitCode: (output) => DUMP_EXIT_CODES[output.stopped_on],
  async run(ctx, input): Promise<AttendeesDumpOutput> {
    const containerId = containerIdOf(ctx);
    const out = resolveExportPath(input.out, ctx);
    const handle = await openExportFile(out, ctx);
    let pages = 0;
    let entries = 0;
    let stoppedOn: StoppedOn = "end";
    let hint: string | null = null;
    try {
      for (let page = 1; ; page += 1) {
        if (cancelled(ctx)) {
          stoppedOn = "cancelled";
          break;
        }
        let data: SearchEntry[];
        try {
          data = await ctx.client.get(searchPath(containerId), {
            query: searchQuery(input.type_ids, page),
            schema: searchPageSchema,
            ...signalOption(ctx),
          });
        } catch (error: unknown) {
          if (error instanceof GripError && isStoppingKind(error.kind)) {
            stoppedOn = error.kind;
            hint = error.hint === "" ? null : error.hint;
            ctx.stderr.write(`${redactString(error.message)}\n`);
            if (hint !== null) ctx.stderr.write(`hint: ${redactString(hint)}\n`);
            break;
          }
          if (cancelled(ctx)) {
            stoppedOn = "cancelled";
            break;
          }
          throw error;
        }
        if (data.length === 0) break;
        for (const entry of data) await handle.write(`${redactString(JSON.stringify(entry))}\n`);
        pages += 1;
        entries += data.length;
        const message = progressMessage(page, data.length, entries);
        if (ctx.progress !== undefined) await ctx.progress(pages, message);
        else ctx.stderr.write(`${redactString(message)}\n`);
        if (cancelled(ctx)) {
          stoppedOn = "cancelled";
          break;
        }
        await pause(ctx);
      }
    } finally {
      await handle.close();
    }
    return { pages, entries, stopped_on: stoppedOn, out, hint };
  },
});
