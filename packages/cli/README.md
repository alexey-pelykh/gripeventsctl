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

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)
