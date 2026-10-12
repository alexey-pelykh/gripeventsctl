# Security Policy

GripEventsCtl is an unofficial, personal-use CLI and MCP server for event apps hosted on Grip.
It runs on your own computer and holds one Grip session token.
This page says how to report a flaw and what the project defends against.

## Reporting a vulnerability

Email **alexey.pelykh@gmail.com** to report a security flaw in GripEventsCtl.
Do not open a public issue or discussion for it.
The maintainer aims to reply within 7 days, on a best-effort basis.

Please include:

- what the flaw is and what an attacker gains from it;
- steps to reproduce it, or a proof of concept;
- the GripEventsCtl version you tested.

Never put a real session token, chat token, password or attendee data in a report.
Replace each one with a placeholder.

## Supported versions

GripEventsCtl is pre-release.
Security fixes go into the latest release only.
No older version receives fixes.

## Scope

GripEventsCtl is a local tool that holds one session token.
These count as vulnerabilities:

- The session token or the chat token appears in a log, an error message, crash output, an export, an MCP response, or a tracked file.
- The config file is written with wider permissions than mode 0600.
- A password passes through the MCP server or reaches an AI assistant.
- A write reaches Grip while writes are off in the config file.
- A write repeats to the same person despite the repeat guard.
- A write reaches Grip without an entry in the append-only record.
- A message your assistant wrote is sent without your recorded go-ahead.
- Attendee data lands on disk without you asking for an export.
- The MCP server accepts a connection from anything other than its stdio parent.
- A build or release step lets someone change what gets published.

These do not count:

- A flaw in Grip's own platform.
  Report it to Intros.at Ltd, which runs Grip.
  Its end-user agreement gives support@grip.events as its contact address.
- An attack that needs control of your user account or your computer first.
- Grip changing its interface so that GripEventsCtl stops working.
  That is a bug: open an issue with the "wire broke for me" template.
- Someone misusing GripEventsCtl against other attendees.
  See [Abuse reporting](#abuse-reporting).

## Threat model

### Session token on disk

Sign-in stores the session token in `~/.gripeventsctl.yaml` with mode 0600.
You can instead point the config at a 1Password item with an `op://` reference.
Anyone who can read the token can act as you in that event's app.
The project trusts the local machine and the user account that owns the file.
Do not commit the config file, and do not keep it in a folder that syncs to the cloud.

`gripeventsctl auth signout` removes the token from the config file.
Whether Grip also ends the session on its side is not verified on 2026-10-12.

### Secrets and attendee data stay out of logs

Every log path runs through one redaction step.
It masks the session token, a 36-character UUID sent as `X-Authorization`.
It also masks the chat token, a JWT.
Attendee data never goes into logs.
The repository's lint fails when a tracked file contains a token-shaped value.

### MCP server over stdio

`gripeventsctl mcp` speaks stdio only.
Your MCP client starts it as a child process.
Any process that can start it gets every tool it offers, acting as you.
Give MCP access only to an assistant you trust.

Profiles and chat messages are text written by other attendees.
That text can carry instructions aimed at your assistant.
The write guards are the defence: writes are off by default, and an assistant-written message needs your recorded go-ahead.

### No network listener

GripEventsCtl opens no port and runs no server.
It makes outbound HTTPS requests to Grip's API host, `api-prod.grip.events`, and nothing listens for inbound connections.

### Third-party platform changes

Grip can change its interface, its terms or its blocking at any time.
GripEventsCtl follows those changes and does not work around them.
The project's posture on Grip's terms is in [docs/legitimacy.md](docs/legitimacy.md).

## Abuse reporting

Tell the maintainer if you see GripEventsCtl used to misuse a Grip event app.
Examples are spam to attendees, bulk export of a directory, lead lists built from attendee data, or a way around Grip's limits.

- **Email**: alexey.pelykh@gmail.com. The maintainer aims to reply within 7 days, on a best-effort basis.
- Do not post attendee names or other personal data in a public issue.

The maintainer investigates credible reports.
You can also report a user's conduct to Grip itself at support@grip.events.

This channel is not for security flaws.
For those, see [Reporting a vulnerability](#reporting-a-vulnerability).

## Dependency posture

- Every GitHub Action is pinned to a full commit SHA, with the version in a comment.
- CI installs with `pnpm install --frozen-lockfile --ignore-scripts`, so the lockfile cannot drift and install scripts do not run.
- A release fails when `pnpm audit --audit-level=high` finds a high or critical advisory.
- CI and release run `pnpm license-check`, which keeps every production dependency on a licence allow-list.
- Releases publish npm provenance and attach CycloneDX SBOMs to the GitHub Release.
