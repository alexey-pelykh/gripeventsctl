# @gripeventsctl/e2e

End-to-end test harness for GripEventsCtl. Runs against a **live** Grip-hosted event app using the maintainer's own session; there is no public sandbox to test against.

This package is **private** (not published to npm). Test cases live alongside the harness as `*.e2e.test.ts` files.

## Opting in

`pnpm test:e2e` collects nothing unless `GRIPEVENTSCTL_E2E=1` is set, so the CI matrix runs it safely on every push. With the variable set, the files run one at a time, in filename order, against the session the user captured with `gripeventsctl auth signin`.

## Live-account safety policy

- The suite reads only, except one guarded write test against the user's own chat thread if the API allows it. Interest swipes and messages to other attendees are never sent by a test.
- The harness never holds a password. It uses the session token the user captured; a leaked token is revoked by signing out.
- Failure output goes through the redaction in `@gripeventsctl/core` so a token never lands in a log.
- Attendee data returned by the live API stays in memory; the harness writes no capture to disk.
