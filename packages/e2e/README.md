# @gripeventsctl/e2e

End-to-end test harness for GripEventsCtl. Runs against a **live** Grip-hosted event app using the maintainer's own session; there is no public sandbox to test against.

This package is **private** (not published to npm). Test cases live alongside the harness as `*.e2e.test.ts` files.

## Opting in

`pnpm test:e2e` collects nothing unless `GRIPEVENTSCTL_E2E=1` is set; no workflow runs it, and the script self-test `scripts/__tests__/e2e-suite-shape.test.ts` runs that collect-nothing path on every CI job. With the variable set, the nine `*.e2e.test.ts` files run one at a time, in path order (`00-session` to `70-mcp-stdio`, through the path sequencer in `vitest.e2e.config.ts`), against the session the user captured with `gripeventsctl auth signin`. The write file, `60-write`, needs `writes.enabled: true` in the config and the user at a second terminal of their own: Vitest workers have no TTY, so the test prints the `gripeventsctl writes go-ahead <id>` line and polls the journal until the approval lands. `GRIPEVENTSCTL_E2E_TYPE_ID=<id>` names one listable type id for `20-attendees` and skips its type probe.

Every file writes one verification summary line per request to stderr, `e2e <file> <outcome> <METHOD> <path template> <HTTP status> <YYYY-MM-DD>`: the pull request pastes them under its test plan, and a `verified` line with a status, from a test that passed, dates the request shape on its `docs/api/` page. The outcome on the line is the classification of the answer's fields; a type check the test runs after it can still fail the test, so a line is read beside the test's result. Three further line forms exist: `-` in the method and status columns with the tool's name as the template for a tool that sends nothing (`gripeventsctl_writes_status`), `-` in the status column for a documented shape that sent no request, and `<unmatched>` as the template for a request no documented shape matches. An `inconclusive` outcome is a skip whose reason Vitest prints with the test; a `contract-drift` outcome is a failure whose message names field names and kinds, never a value. The harness library under `src/lib/` and its unit tests under `src/__tests__/` run with `pnpm test` and need no session.

## Live-account safety policy

- The suite reads only, except one guarded write test against the user's own chat thread if the API allows it. Interest swipes and messages to other attendees are never sent by a test.
- The harness never holds a password. It uses the session token the user captured; a leaked token is revoked by signing out.
- Failure output goes through the redaction in `@gripeventsctl/core` so a token never lands in a log.
- Attendee data returned by the live API stays in memory; the harness writes no capture to disk.
