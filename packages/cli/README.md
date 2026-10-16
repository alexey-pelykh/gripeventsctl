# @gripeventsctl/cli

[![npm](https://img.shields.io/npm/v/%40gripeventsctl%2Fcli?logo=npm)](https://www.npmjs.com/package/@gripeventsctl/cli)
[![License](https://img.shields.io/npm/l/%40gripeventsctl%2Fcli)](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)

[Commander](https://github.com/tj/commander.js)-based CLI program for the [GripEventsCtl](https://github.com/alexey-pelykh/gripeventsctl) toolkit. Powers the `gripeventsctl` binary shipped by the umbrella package.

> **Unofficial.** GripEventsCtl is NOT affiliated with, endorsed by, or supported by Grip. See the [project README](https://github.com/alexey-pelykh/gripeventsctl#readme) for the full use policy and disclaimer.

## Audience

End users should install the [`gripeventsctl`](https://www.npmjs.com/package/gripeventsctl) umbrella package; it ships the `gripeventsctl` binary plus the MCP server. This package is published separately for embedders who want to mount the Commander program inside another CLI tree.

## Install

```sh
npm install @gripeventsctl/cli
```

Requires **Node.js >= 22.19.0**, ESM only.

## Commands

| Command                                                     | What it does                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `auth signin <slug> [--container-id <n>] [--email <email>]` | Look the event up, read the credentials from the terminal or a 1Password item, sign in once, store the session    |
| `auth signout`                                              | Remove the stored session; the writes enabled switch and the credentials reference stay                           |
| `auth status`                                               | Show the stored session (slug, container, sign-in time, first authentication failure); reads the config file only |

`--json` on the program gives machine-readable output on stdout. Human output goes to stdout; errors and diagnostics go to stderr. The config file path comes from `GRIPEVENTSCTL_CONFIG_FILE` (default `~/.gripeventsctl.yaml`); there is no `--config` option.

## Exit codes

Success exits 0. A failure prints one line on stderr (`<message>; hint: <hint>`), or with `--json` one object `{ "error": { "kind", "message", "hint" } }` on stderr and nothing on stdout. Commander's own usage errors (unknown command, missing argument, unknown option, too many arguments) are the exception: they print Commander's message and the command's help on stderr, in the human form even with `--json`, never echoing a value typed in the wrong place. The code follows the error's `kind`:

| `kind`                                              | Exit |
| --------------------------------------------------- | ---- |
| `usage` (bad arguments, Commander's own errors too) | 2    |
| `no-session`, `auth-failed`                         | 3    |
| `write-refused`                                     | 4    |
| `throttled`, `swipe-cap`                            | 5    |
| `gated-type`, `load-balancer-rejected`              | 6    |
| `network`                                           | 7    |
| `config`                                            | 8    |
| `unknown-slug`, `mode-phase`, `conflict`, `api`     | 1    |

An exception that is no `GripError` exits 1 with the kind `unexpected`. A kind or a code may be added later; none is renumbered.

## Embedding

`buildProgram(options?)` returns the Commander program; `runProgram(argv, options?)` parses `argv` (the arguments after the program name) and resolves to `{ exitCode, error? }` without calling `process.exit`. The options inject the seams the commands take from the process by default: `terminal` (the prompts and TTY checks), `stdout`, `stderr`, `dispatcher` (undici), `clock`, `env` and `platform`.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)
