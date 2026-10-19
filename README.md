# GripEventsCtl

[![CI](https://github.com/alexey-pelykh/gripeventsctl/actions/workflows/ci.yml/badge.svg)](https://github.com/alexey-pelykh/gripeventsctl/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/gripeventsctl?logo=npm)](https://www.npmjs.com/package/gripeventsctl)
[![npm downloads](https://img.shields.io/npm/dm/gripeventsctl?logo=npm)](https://www.npmjs.com/package/gripeventsctl)
[![GitHub Repo stars](https://img.shields.io/github/stars/alexey-pelykh/gripeventsctl?style=flat&logo=github)](https://github.com/alexey-pelykh/gripeventsctl)
[![License](https://img.shields.io/github/license/alexey-pelykh/gripeventsctl)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-3.0-4baaaa.svg)](CODE_OF_CONDUCT.md)

An unofficial CLI and MCP server for event apps hosted on [Grip](https://grip.events). It helps you network at an event you attend, from your terminal or through an AI assistant.

## ⚠️ Unofficial - Personal Use Only

**GripEventsCtl is NOT affiliated with, endorsed by, or supported by Grip.** It talks to a Grip-hosted event app with your own attendee session. It is for your own networking at an event you attend.

"Grip" is the name of the event-networking platform run by Intros.at Ltd. This project uses the name only to say which platform your session belongs to.

It is **NOT** for:

- Spam or unsolicited outreach
- Mass swiping or mass messaging
- Scraping attendee directories into lead lists
- Contacting people outside the platform
- Operating against an account that is not your own
- Any behavior that breaks the platform's terms or burdens it

If you see misuse of GripEventsCtl, report it as described in [Abuse reporting in SECURITY.md](SECURITY.md#abuse-reporting).

The friction in the code is on purpose: writes are off by default, repeats are blocked, and the platform's rate limits are honoured. Do not remove it.

## Status

This repository holds the workspace scaffold and, in `@gripeventsctl/core`, the transport client the commands will use (`GripClient`: the fixed base URL and header set, the config lookup, the login call, the response envelope and error kinds, the HTTP 429 backoff, paging, one request in flight per process). Of the commands below under "Commands", the three `auth` commands, the two `events` commands, the three `attendees` commands, `match status`, the three `chat` commands, `schedule info` and the two `interest` commands exist; `attendance get` does not; the three `writes` commands (`writes status`, `writes pending`, `writes go-ahead`) exist too. The `no` answer `interest skip` sends is from the app code and is not yet verified live (`docs/api/interest.md` § Send an answer).

- Nothing is published to npm yet. The npm badges show "not found" until the first release.
- The binary answers `--version`, `--help`, the three `auth` commands (`auth signin <slug>`, `auth signout`, `auth status`), the two `events` commands (`events check <slug>`, `events list`) and the three `attendees` commands (`attendees list --type <ids> [--page <n>]`, `attendees dump --type <ids> --out <path>`, `attendees get <thing id | user_id | me>`), `match status <thing id>`, the three `chat` commands (`chat list`, `chat thread <thing id>`, `chat send <thing id> <text> [--dry-run]`), `schedule info`, the two `interest` commands (`interest show <thing id> [--message <text>] [--dry-run]`, `interest skip <thing id> [--dry-run]`) and the three `writes` commands (`writes status`, `writes pending`, `writes go-ahead`). It has no other commands.
- `gripeventsctl mcp` starts the MCP server over stdio. The server lists fourteen tools, `gripeventsctl_events_check`, `gripeventsctl_events_list`, `gripeventsctl_attendees_list`, `gripeventsctl_attendees_dump`, `gripeventsctl_attendees_get`, `gripeventsctl_match_status`, `gripeventsctl_chat_list`, `gripeventsctl_chat_thread`, `gripeventsctl_chat_send`, `gripeventsctl_schedule_info`, `gripeventsctl_interest_show`, `gripeventsctl_interest_skip`, `gripeventsctl_writes_status` and `gripeventsctl_writes_pending`. The three writes run only with writes enabled, behind the repeat guard, into the send log, and never with an assistant-written message without a recorded go-ahead.

## Install

Planned, once the first version is published:

```sh
npm install -g gripeventsctl
```

Requires Node.js 22.19.0 or newer.

## MCP Integration

`gripeventsctl mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Each CLI command gets a twin MCP tool named `gripeventsctl_<group>_<verb>`. The exceptions are the `auth` group (`auth signin`, `auth signout`, `auth status`) and `writes go-ahead`, which are CLI-only.

<details>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add gripeventsctl -- npx gripeventsctl mcp
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gripeventsctl": {
      "command": "npx",
      "args": ["gripeventsctl", "mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "gripeventsctl": {
      "command": "npx",
      "args": ["gripeventsctl", "mcp"]
    }
  }
}
```

</details>

Anything that can start `gripeventsctl mcp` can use your saved session. Do not give MCP access to agents you do not trust.

Attendee data is other people's personal data. When an assistant calls a tool, the result enters its context, and your assistant host decides how long it keeps that data. Pick a host and a chat mode that match how you want that data handled. GripEventsCtl writes none of it to disk unless you ask for an export.

## Authentication

You sign in yourself, in a terminal:

```sh
gripeventsctl auth signin <slug>
```

The slug is the last part of the event's web address, `https://matchmaking.grip.events/<slug>`. The command looks the event up, asks for your email and your password (the password is never echoed), signs in once and stores the session. `--email <email>` skips the email prompt; `--container-id <n>` overrides the container id the event config names. There is no `--password` option, and the password is never read from an argument or an environment variable. With `auth.credentials` set to a 1Password item (`op://<vault>/<item>` holding a `username` and a `password` field), the command reads both from the 1Password CLI and needs no terminal.

The password never passes through an AI assistant. The MCP server has no sign-in tool: it only uses the session token that you already captured.

The session token is stored in one of two ways:

- In `~/.gripeventsctl.yaml` with file mode `0600`.
- As a reference to a 1Password item, written as an `op://` path.

`auth signout` removes the token. `auth status` shows whether you are signed in, for which event and since when, and reads the config file only. `--json` on any command gives machine-readable output on stdout; errors go to stderr with one exit code per kind of failure (see [`packages/cli/README.md`](packages/cli/README.md#exit-codes)).

## Writes are gated

Reads are free. Three actions change something on the platform and notify another person:

- Show interest in an attendee, with an optional message of up to 250 characters.
- Skip an attendee.
- Send a chat message.

These rules apply to all three:

- They are off by default. You enable them in the config file.
- The repeat guard refuses a second action of the same kind against the same person.
- Every write is logged to the append-only send log.
- A message written by an assistant is never sent unless your go-ahead is recorded first.
- Every write supports `--dry-run`, which shows what would be sent and sends nothing.

The tool honours the platform's own rate limits.

## Commands

Read commands:

| Command                                     | What it does                                                         |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `events check <slug>`                       | Check whether an event slug runs on Grip and show its type set       |
| `events list`                               | List the active events your session can reach                        |
| `attendees list --type <ids> [--page <n>]`  | List one page of the attendee directory for the given type ids       |
| `attendees dump --type <ids> --out <path>`  | Export the attendee directory to the JSON Lines file you name        |
| `attendees get <thing id \| user_id \| me>` | Show one attendee's profile; `user_id` or `me` shows your own record |
| `match status <thing id>`                   | Show whether you have answered a person, and whether you connected   |
| `chat list`                                 | List your chat threads, which are also your connections              |
| `chat thread <thing id>`                    | Show the messages in your thread with one person                     |
| `schedule info`                             | Show your schedule: meetings and agenda sessions                     |

One read is held, `attendance get`: no documented call returns one attendance record by thing id.

Gated writes:

| Command                                                   | What it does                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `interest show <thing id> [--message <text>] [--dry-run]` | Show interest in a person, with an optional message of up to 250 characters |
| `interest skip <thing id> [--dry-run]`                    | Skip a person                                                               |
| `chat send <thing id> <text> [--dry-run]`                 | Send a chat message to a person you are connected with                      |

Write gate:

| Command                | What it does                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `writes status`        | Show whether writes are enabled, where the send log is, and how many go-aheads await approval |
| `writes pending`       | List the proposed go-aheads that await approval in a terminal                                 |
| `writes go-ahead <id>` | Record your go-ahead for one proposed message, at a terminal of your own (CLI only)           |

Auth commands: `auth signin`, `auth signout`, `auth status`.

## Development

Requires Node.js 22.19.0 or newer and pnpm 12.11.2.

```sh
pnpm install
pnpm build             # build all packages with Turborepo
pnpm test              # unit tests
pnpm test:coverage     # unit tests with coverage
pnpm test:e2e          # e2e tests against a live event app session
pnpm typecheck         # type check all packages
pnpm lint              # Prettier check, ESLint and the repository gates
pnpm format            # fix Prettier formatting
pnpm license-check     # check dependency licenses
pnpm dev               # watch mode
```

The packages are `@gripeventsctl/core`, `@gripeventsctl/cli`, `@gripeventsctl/mcp`, the umbrella `gripeventsctl` and the private `@gripeventsctl/e2e` and `@gripeventsctl/testing`. See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## Documentation

- [`docs/api/`](docs/api/): notes on the platform API, one page per surface. Each claim carries the date it was verified.
- [`docs/legitimacy.md`](docs/legitimacy.md): the project's position on trademarks, platform terms and the AGPL choice.

## Security

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md#reporting-a-vulnerability). Never paste a session token or your config file into an issue.

## License

[AGPL-3.0-only](LICENSE)

- Running `gripeventsctl` as a CLI or MCP server does not put your own code under the AGPL.
- Importing `@gripeventsctl/core` into your code puts the combined work under the AGPL.
- Changing and distributing GripEventsCtl means sharing your changes under the AGPL.
