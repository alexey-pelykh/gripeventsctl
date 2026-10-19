# Contributing to GripEventsCtl

Thank you for your interest in contributing to GripEventsCtl!

## Contributor License Agreement (CLA)

By submitting a pull request or otherwise contributing to this project, you agree to the following terms:

1. **Grant of Rights**: You grant the project maintainer(s) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, distribute, sublicense, and otherwise exploit your contribution in any form.

2. **Dual Licensing**: You acknowledge that the maintainer(s) may offer the software under alternative licenses (including commercial licenses) in addition to the AGPL-3.0 license, and your contribution may be included in such offerings.

3. **Original Work**: You represent that your contribution is your original work, or you have the right to submit it under these terms.

4. **No Warranty**: You provide your contribution "as is" without warranty of any kind.

### How to Agree

By submitting a pull request, you indicate agreement with this CLA. No separate signature is required.

For substantial contributions, please include the following sign-off in your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

You can add this automatically with `git commit -s`.

## Development

### Prerequisites

- **Node.js** >= 22.19.0
- **pnpm** 12.11.2

### Setup

```sh
git clone https://github.com/alexey-pelykh/gripeventsctl.git
cd gripeventsctl
pnpm install
pnpm build
```

### Development Commands

```sh
pnpm build            # Build all packages (via Turbo)
pnpm test             # Run unit tests, then the script self-tests under scripts/__tests__/
pnpm test:coverage    # Run unit tests with coverage
pnpm test:e2e         # Run E2E tests (sequential, needs a live event app session)
pnpm typecheck        # Type check all packages
pnpm lint             # Prettier format:check + ESLint + the repository gates (secret leakage, dependency confusion, test traceability, dated API pages, workflow pins, README posture)
pnpm format           # Auto-fix Prettier formatting
pnpm license-check    # Verify dependency licenses
pnpm dev              # Watch mode
```

`pnpm lint` is the pre-push gate. Run `pnpm format` to fix any Prettier
issue, then run `pnpm lint` again.

Four gates have a strict mode that `pnpm lint` does not run. They run in the release workflow's
`validate` job on a full clone and before a tag: `pnpm check-secret-leakage --history` scans every
blob reachable from every ref and refuses a shallow clone; `pnpm check-api-docs-dated --strict` fails
on a `docs/api/` page without a `Verified live YYYY-MM-DD` label (the three index pages are exempt);
`pnpm check-test-traceability --strict` fails on a `planned` capability; `pnpm test:oracles` fails on
an oracle file whose subject is not built.

### Capability tags

Every test file's first top-level `describe` title starts with one or more capability tags in
square brackets, such as `[CAP-GATE] no write request leaves the process ...`, naming rows of
[`test-capabilities.yaml`](test-capabilities.yaml) at the repository root. `pnpm check-test-traceability`,
the last step of `pnpm lint`, fails on a test file without a tag, a tag the catalog does not hold, an
`active` capability with no tagged file at a level it declares, and a `planned` capability that has a
tagged file: the pull request that lands a capability's first tagged test flips its row to `active`.
A file under `packages/e2e/src/` ending in `.e2e.test.ts` counts for the live level, a file under
`scripts/__tests__/` for the repository-gate level, and every other test file for the unit, component,
surface and process levels alike. The check prints one report line per capability and lists the
`*.oracle.test.ts` files that differ from the base branch.

### Oracle tests

An oracle test is a test written before the code it grades, by a different author than the one
who writes that code. It is named `src/__tests__/<subject>.oracle.test.ts` and sits next to the
unit tests. Each of its top-level `describe` titles starts with a capability tag in square
brackets, such as `[CAP-GATE]`. The file probes its subject module at the top. `pnpm test` skips
an oracle whose subject module is not built yet. It runs the oracle once the module exists, with no
edit to the file and no configuration change. `pnpm test:oracles` runs every oracle file in strict
mode, where a missing subject fails instead of skipping. That command is the done check for the
item the oracles describe. A pull request that implements the code never edits an oracle file: its
diff on `*.oracle.test.ts` is empty, or it links the specification change that moved the assertion
first. A change to an oracle file is a specification change and is reviewed as one.

Two checks in CI make these rules mechanical. The `Oracles` job fails a pull request that touches a
`*.oracle.test.ts` file unless the pull request carries the `spec-change` label; a maintainer adds
the label once the specification change has been reviewed. The same job runs `pnpm check-oracles`,
which runs the oracle files in strict mode and grades each one against the pending ledger
[`oracles.pending`](oracles.pending) at the repository root. The ledger lists, one path per line and
sorted, every oracle file whose subject module is not built yet. A listed file may fail only because
its subject is missing. A file not listed must pass. A listed file whose cases pass fails the check
and is named: the pull request that built its subject removes its line from the ledger in the same
change. A ledger line that names a file that does not exist fails too. The check prints one line
per oracle file with its state. The release workflow runs the same check before publishing.

### Project Structure

The repository is a pnpm monorepo with the following packages:

| Package                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `packages/core`          | API client, session handling and services (`@gripeventsctl/core`) |
| `packages/cli`           | CLI commands and program definition (`@gripeventsctl/cli`)        |
| `packages/mcp`           | MCP server (`@gripeventsctl/mcp`)                                 |
| `packages/gripeventsctl` | Umbrella package with the binary (`gripeventsctl`)                |
| `packages/e2e`           | Private e2e tests (`@gripeventsctl/e2e`)                          |
| `packages/testing`       | Private test helpers (`@gripeventsctl/testing`)                   |

### Conventions

Follow the project conventions in [CLAUDE.md](CLAUDE.md).

### Submitting Changes

1. Fork the repository and create a feature branch.
2. Make your changes.
3. Commit with a message in the format below.
4. Open a pull request.

### Commit messages

The format is `(type) lowercase message`. The types are:

- `feat`: a new feature
- `fix`: a bug fix
- `chore`: maintenance that changes no behavior
- `docs`: documentation only
- `ci`: CI configuration
- `refactor`: a code change that neither fixes a bug nor adds a feature
- `test`: tests only

Add an issue reference as a `(#N)` suffix, for example `(feat) add events check (#12)`.

Each commit holds one logical change.

### Pull request gates

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has five gates. Answer each one in your pull request.

1. **CLI/MCP parity**: a CLI command and its MCP tool stay coupled. If a change adds, renames or removes one side, change the other side too, or declare the difference in [`.mcp-exempt.yaml`](.mcp-exempt.yaml) with a reason.
2. **Writes stay gated**: a call that notifies someone or changes something on the platform runs only behind the safe-mode gate, honours `--dry-run`, and appends to the send log.
3. **Live verification**: a new or changed request shape against `api-prod.grip.events` needs the matching page under `docs/api/` to carry the date it was verified live. The test plan names the e2e test or transcript.
4. **No secrets**: no session token, chat token, password or captured response with personal data goes into a committed file or fixture. `pnpm check-secret-leakage` checks this.
5. **Oracles untouched**: a pull request that implements an item with pre-authored `*.oracle.test.ts` files leaves those files unchanged, or links the specification change that moved the assertion first and carries the `spec-change` label. It removes the item's files from [`oracles.pending`](oracles.pending), and `pnpm check-oracles` is green.

### Branch protection

`main` is protected by the ruleset in `.github/rulesets/main-protection.json`: changes land through a pull request, the `CI` check must pass, history stays linear, and the branch cannot be deleted or force-pushed. `.github/rulesets/README.md` says how to apply and verify the deployed ruleset.

### Releases

A release is a GitHub Release whose tag is a semver version (`v0.1.0`, `v0.2.0-rc.1`). Publishing the release runs `.github/workflows/release.yml`: it validates on three operating systems, audits dependencies, stamps the tag's version into every publishable package and `server.json`, publishes to npm with provenance through OpenID Connect trusted publishing, attaches the tarballs and, from a separate job, the SBOMs to the release, and publishes `server.json` to the MCP registry from a job that holds only `contents: read` and `id-token: write`. Nothing is published from a maintainer's machine. `pnpm check-workflow-pins` keeps the workflow's pins, permissions and strict steps as described.

### Partial closures

When a pull request title or commit references an open **multi-step** issue with `(#N)` but ships only part of its scope, update that issue within 24 hours of the merge. Post a comment or edit the body to say what shipped and what remains. This keeps the issue honest for whoever picks it up next.

This does not apply to full closures, to pull requests without a `(#N)` reference, or to single-step issues.

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) (version 3.0). Please read it before participating.

### Reporting a Concern

To report a concern about behavior in project spaces (issues, pull requests, MCP server interactions, or any other channel), email <alexey.pelykh@gmail.com>. Pseudonymous reports are accepted; truly anonymous reports are not feasible. Best-effort response within 7 days. See the [Code of Conduct](CODE_OF_CONDUCT.md) for the full reporting procedure, privacy commitments, and enforcement ladder.

## Questions?

Open an issue for discussion before starting significant work.
