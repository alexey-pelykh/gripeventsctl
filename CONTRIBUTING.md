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
pnpm test             # Run unit tests
pnpm test:coverage    # Run unit tests with coverage
pnpm test:e2e         # Run E2E tests (sequential, needs a live event app session)
pnpm typecheck        # Type check all packages
pnpm lint             # Prettier format:check + ESLint + secret-leakage and dependency-confusion checks
pnpm format           # Auto-fix Prettier formatting
pnpm license-check    # Verify dependency licenses
pnpm dev              # Watch mode
```

`pnpm lint` is the pre-push gate. Run `pnpm format` to fix any Prettier
issue, then run `pnpm lint` again.

### Project Structure

The repository is a pnpm monorepo with the following packages:

| Package                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `packages/core`          | API client, session handling and services (`@gripeventsctl/core`) |
| `packages/cli`           | CLI commands and program definition (`@gripeventsctl/cli`)        |
| `packages/mcp`           | MCP server (`@gripeventsctl/mcp`)                                 |
| `packages/gripeventsctl` | Umbrella package with the binary (`gripeventsctl`)                |
| `packages/e2e`           | Private e2e tests (`@gripeventsctl/e2e`)                          |

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

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has four gates. Answer each one in your pull request.

1. **CLI/MCP parity**: a CLI command and its MCP tool stay coupled. If a change adds, renames or removes one side, change the other side too, or declare the difference in [`.mcp-exempt.yaml`](.mcp-exempt.yaml) with a reason.
2. **Writes stay gated**: a call that notifies someone or changes something on the platform runs only behind the safe-mode gate, honours `--dry-run`, and appends to the send log.
3. **Live verification**: a new or changed request shape against `api-prod.grip.events` needs the matching page under `docs/api/` to carry the date it was verified live. The test plan names the e2e test or transcript.
4. **No secrets**: no session token, chat token, password or captured response with personal data goes into a committed file or fixture. `pnpm check-secret-leakage` checks this.

### Branch protection

`main` is protected by the ruleset in `.github/rulesets/main-protection.json`: changes land through a pull request, the `CI` check must pass, history stays linear, and the branch cannot be deleted or force-pushed. `.github/rulesets/README.md` says how to apply and verify the deployed ruleset.

### Releases

A release is a GitHub Release whose tag is a semver version (`v0.1.0`, `v0.2.0-rc.1`). Publishing the release runs `.github/workflows/release.yml`: it validates on three operating systems, audits dependencies, stamps the tag's version into every publishable package and `server.json`, publishes to npm with provenance through OpenID Connect trusted publishing, and attaches the SBOMs and tarballs to the release. Nothing is published from a maintainer's machine.

### Partial closures

When a pull request title or commit references an open **multi-step** issue with `(#N)` but ships only part of its scope, update that issue within 24 hours of the merge. Post a comment or edit the body to say what shipped and what remains. This keeps the issue honest for whoever picks it up next.

This does not apply to full closures, to pull requests without a `(#N)` reference, or to single-step issues.

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) (version 3.0). Please read it before participating.

### Reporting a Concern

To report a concern about behavior in project spaces (issues, pull requests, MCP server interactions, or any other channel), email <alexey.pelykh@gmail.com>. Pseudonymous reports are accepted; truly anonymous reports are not feasible. Best-effort response within 7 days. See the [Code of Conduct](CODE_OF_CONDUCT.md) for the full reporting procedure, privacy commitments, and enforcement ladder.

## Questions?

Open an issue for discussion before starting significant work.
