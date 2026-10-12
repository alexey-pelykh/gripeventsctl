# Third-Party Notices

GripEventsCtl itself is licensed under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)).

This file provides attribution for third-party components that GripEventsCtl
**redistributes transitively** but which do not ship their own consumer-reachable
license or notice files. Every dependency GripEventsCtl currently installs ships
its own `LICENSE` inside its npm package, so this file lists none. It exists so
that each package's `prepack` step has a notices file to copy, and it grows the
day a dependency with a bundled native binary or a vendored component is added.

The per-release [CycloneDX SBOM](https://github.com/alexey-pelykh/gripeventsctl/releases)
(attached to each GitHub Release) is the authoritative machine-readable inventory
of the npm dependency graph. The `license-check` script (`scripts/check-licenses.js`)
keeps every production dependency on the AGPL-compatible allow-list.
