# GripEventsCtl - Claude Instructions

## Project Context

GripEventsCtl is an unofficial CLI and MCP server for Grip-hosted event apps (`api-prod.grip.events`), for one attendee's own networking at an event they attend. It is not affiliated with, endorsed by or supported by Grip. `docs/legitimacy.md` quotes Grip's attendee terms as published on 2026-10-12 and states the project's reading of them. Do not weaken that page or the README's "Unofficial" block.

State on 2026-10-12: a pnpm workspace scaffold. The binary answers `--version` and `--help`, and `gripeventsctl mcp` starts an MCP server with no tools. The commands in README § Planned surface do not exist yet. Nothing is published to npm. On 2026-10-16 the `auth` group landed (`auth signin`, `auth signout`, `auth status`, issue #7), with the exit-code table, the global `--json` option and the `Terminal` seam in `packages/cli/src/lib/`. On 2026-10-17 the `events` group landed (`events check <slug>`, `events list`, issue #10): the first two entries of the operation registry (`packages/core/src/operations/`), each with its CLI leaf and its MCP twin. On 2026-10-19 the `attendees` group landed (`attendees list`, `attendees dump`, `attendees get`, issue #11): the paced directory read, the export file created only where the user pointed, the per-person profile, and with them `render.tableField`, `exitCode`, the operation context's `signal` and `progress`, and the client's `signal` option. On 2026-10-19 `match status <thing id>` landed (issue #12): the read-only status call the gated writes will run before every POST, the first entry of the `match` group, and with it `operations/context.ts` (the container-id and signal helpers the attendees and match groups share) and `escapeForTerminal` in core (`lib/escape.ts`), so an operation's diagnostic line can escape a wire value. On 2026-10-19 the `chat` group's reads landed (`chat list`, `chat thread <thing id>`, issue #13): the thread list, which is also the connections list, and the messages of one thread, both GETs directly under `/1/`, the thread list naming the container in its `container_id` query parameter and the thread read carrying no query, and with them `render.note`, one sentence printed after the human rendering and appended to the MCP text block.

Packages: `packages/core` (`@gripeventsctl/core`: client, session, redaction), `packages/cli` (`@gripeventsctl/cli`: the Commander program), `packages/mcp` (`@gripeventsctl/mcp`: the MCP server), `packages/gripeventsctl` (the umbrella with the binary; depends on cli and mcp), `packages/e2e` (private; live tests) and `packages/testing` (`@gripeventsctl/testing`: private test helpers and the temporary-home test guard; depends on no workspace package and sits in `devDependencies` only). cli depends on core; mcp depends on core and on cli, for the shared output renderer. Nothing depends on the umbrella, on e2e or on testing at run time.

## Conventions

- **Headers**: every `.ts`, `.js` and `.mjs` file starts with `// SPDX-License-Identifier: AGPL-3.0-only` and `// Copyright (C) 2026 Oleksii PELYKH`; a shebang may precede them; ESLint enforces it. Every Markdown file under `docs/` starts with the same two lines inside an HTML comment. Root Markdown files and package READMEs carry no header.
- **Commits**: `(type) lowercase message` with the types `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`; a `(#N)` suffix for an issue; one logical change per commit. Changes reach `main` through a pull request with a rebase merge. Stage by explicit path.
- **Formatting**: Prettier (`pnpm format`) with the settings in `.editorconfig`: two-space indent for TypeScript, JavaScript, JSON, YAML and Markdown, 120 columns. `pnpm format:check` runs in CI.
- **Dependencies**: versions live in the `catalog:` of `pnpm-workspace.yaml`; package manifests reference `catalog:`; workspace packages reference each other as `workspace:^`. A new pin is read from the registry on the day it is added. A new production dependency must pass `pnpm license-check` (allow-list in `scripts/check-licenses.js`).
- **TypeScript**: `tsconfig.base.json` sets ES2024, NodeNext, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. Relative imports carry the `.js` suffix. ESLint runs `strictTypeChecked`; a number in a template literal goes through `String(n)`.
- **Tests**: unit tests live in `src/__tests__/<subject>.test.ts` next to the code and run with Vitest through `pnpm test`. Live tests are `*.e2e.test.ts` under `packages/e2e/src/` only, collected only when `GRIPEVENTSCTL_E2E=1`, run one file at a time, and read only, except one guarded write against the user's own chat thread. Fixtures are synthetic: never a real token, never a real attendee record. Every test file's first `describe` title starts with its `[CAP-<NAME>]` tags from `test-capabilities.yaml`; `pnpm check-test-traceability` enforces it, and the item that lands a capability's first tagged test flips its row to `active`.
- **CLI/MCP parity**: every CLI leaf command `gripeventsctl <group> <verb>` has a twin MCP tool `gripeventsctl_<group>_<verb>`, and vice versa. A deliberate divergence goes in `.mcp-exempt.yaml` with a reason. `auth signin`, `auth signout` and `auth status` are the standing CLI-only set. The umbrella intercepts `mcp` before Commander parses argv.
- **Vocabulary for writes**: "safe mode" is the default state in which writes are off; "writes enabled" is the config switch that turns them on; the "repeat guard" refuses a second action of the same kind against the same target; the "send log" is the append-only record of every write; a "recorded go-ahead" is the user's stored consent that an assistant-written message may be sent. Use these names in code, docs and messages.

## Rules the code must honour

- The user runs `auth signin` in a terminal. The password never passes through an AI assistant, a log or the MCP server. The MCP server consumes the captured session token and never signs in.
- The session token is stored in the config file (`~/.gripeventsctl.yaml` with mode 0600, or an `op://` reference) and is sent as the `X-Authorization` header. Every call sends a browser `User-Agent`, because the platform's load balancer rejects `curl` user agents.
- Every log path passes through `redactString` from `@gripeventsctl/core`. The secret shapes live only in `packages/core/src/lib/redact.ts`, and `scripts/check-secret-leakage.ts` reads them from there. Extend that module, never its consumers.
- Writes (`interest show`, `interest skip`, `chat send`, and any later meeting action) run only with writes enabled, behind the repeat guard, into the send log, with `--dry-run` support, and never with an assistant-written message without a recorded go-ahead. The platform's throttling (HTTP 429) is honoured with backoff and never evaded. This friction is intentional. Do not remove it.
- `superyes` (strong interest) is documented in `docs/api/interest.md` and is outside the v1 surface.
- A change to any request shape against `api-prod.grip.events` updates the matching `docs/api/` page with a `Verified live YYYY-MM-DD` label from a real run and names the e2e test or transcript in the pull request. A claim without a run goes to `docs/api/not-verified.md`.
- Never commit a session token, a chat token, the config file, `.tmp/`, or a captured response holding attendee data. Attendee data stays in memory unless the user asks for an export.

## Environment variables the tool honours

- `GRIPEVENTSCTL_CONFIG_FILE`: path of the config file; default `~/.gripeventsctl.yaml`.
- `GRIPEVENTSCTL_E2E=1`: opts a run into the live suite.
- `OP_*`: passed through to the 1Password CLI when an `op://` reference is used.
- The `GRIPEVENTSCTL_TOKEN`-style names in the `docs/api/` curl examples are shell placeholders, not configuration.

## Key Files

- `pnpm-workspace.yaml`: packages, catalog, pnpm settings. `turbo.json`: task graph and the environment variables passed to tests.
- `eslint.config.js`, `tsconfig.base.json`, `.prettierrc.json`, `.editorconfig`: the code rules.
- `.mcp-exempt.yaml`: declared CLI/MCP divergences.
- `scripts/check-secret-leakage.ts`, `scripts/check-dep-confusion.ts`, `scripts/check-licenses.js`, `scripts/check-test-traceability.ts`: the repository gates; `test-capabilities.yaml` is the capability catalog the last one reads.
- `docs/api/`: the API notes, one page per surface, every claim dated; `docs/api/not-verified.md` lists the gaps.
- `docs/legitimacy.md`, `SECURITY.md`, `CONTRIBUTING.md`: posture, disclosure channel, contribution rules.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/rulesets/`: CI, release, branch protection.
- `server.json`, `glama.json`: MCP registry manifests; `packages/gripeventsctl/package.json` carries `mcpName`.

## Development

```sh
pnpm install                        # frozen lockfile in CI
pnpm build                          # tsc per package through Turborepo
pnpm typecheck
pnpm lint                           # Prettier check, ESLint, secret leakage, dependency confusion, test traceability: the pre-push gate
pnpm license-check                  # separate from lint
pnpm test                           # unit tests, then the script self-tests under scripts/__tests__/
GRIPEVENTSCTL_E2E=1 pnpm test:e2e   # live suite, after `gripeventsctl auth signin`
pnpm format                         # fix formatting
node packages/gripeventsctl/dist/cli.js --help
```

Node.js >= 22.19.0 (`.nvmrc` pins 22.19.0) and pnpm 12.11.2 (`packageManager`). CI runs the matrix on Node 22 and 24 across three operating systems behind one `CI` gate check.

## Task Tracking

GitHub Issues on this repository, for code, docs and configuration. Issue templates exist for wire breakage and MCP-host failures. The pull request template's gate checklist (parity, gated writes, live verification, no secrets) is answered on every pull request.
