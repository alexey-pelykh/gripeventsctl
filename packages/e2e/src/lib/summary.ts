// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The verification summary (issue #18 § The verification summary): one line per request, written to
 * stderr by the file after each tool call, in this format and nothing else:
 *
 * ```
 * e2e <file> <outcome> <METHOD> <path template> <HTTP status> <YYYY-MM-DD>
 * ```
 *
 * `<file>` is the file's stem (`10-events`); `<METHOD>` and `<path template>` are the operation's
 * `requests[].pathTemplate` from `OPERATIONS`, never the sent path; `<HTTP status>` is the recorder's
 * status for that request, or `-` where no request was sent; `<YYYY-MM-DD>` is the run's UTC date.
 * The line carries no field value, no id, no slug and no token: it passes through `redactString`.
 *
 * The lines are what the pull request pastes under its test plan and what dates the `docs/api/` pages:
 * a `verified` line with a status lets the page carry `Verified live <date>` for that shape; a line
 * with `-` or another outcome does not.
 */

import { BASE_URL, redactString } from "@gripeventsctl/core";

import type { Outcome } from "./outcome.js";

export const SUMMARY_PREFIX = "e2e";

/** The path part of `BASE_URL`, `/1/`: what every sent path starts with. */
const BASE_PATH = new URL(BASE_URL).pathname;

/** The run's UTC date, the same date the page label carries. */
export function runDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function summaryLine(
  file: string,
  outcome: Outcome,
  method: string,
  template: string,
  status: number | "-",
  date: string,
): string {
  const fields = [SUMMARY_PREFIX, file, outcome, method, template, status === "-" ? "-" : String(status), date];
  return redactString(fields.join(" "));
}

/** `path` up to its first `?`. */
function withoutQuery(path: string): string {
  return path.split("?")[0] ?? "";
}

/**
 * True where the recorded path `sent` (query cut, with or without the `/1/` prefix) matches `template`
 * (query cut) segment by segment, every `<...>` placeholder standing for one non-empty segment.
 */
export function templatePath(sent: string, template: string): boolean {
  const sentPath = withoutQuery(sent);
  const relative = sentPath.startsWith(BASE_PATH) ? sentPath.slice(BASE_PATH.length) : sentPath.replace(/^\/+/u, "");
  const want = withoutQuery(template).split("/");
  const got = relative.split("/");
  if (want.length !== got.length) return false;
  return want.every((segment, index) => {
    const actual = got[index] ?? "";
    if (segment.startsWith("<") && segment.endsWith(">")) return actual !== "";
    return segment === actual;
  });
}
