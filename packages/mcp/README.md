# @gripeventsctl/mcp

[![npm](https://img.shields.io/npm/v/%40gripeventsctl%2Fmcp?logo=npm)](https://www.npmjs.com/package/@gripeventsctl/mcp)
[![License](https://img.shields.io/npm/l/%40gripeventsctl%2Fmcp)](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)

[Model Context Protocol](https://modelcontextprotocol.io) server exposing a Grip-hosted event app to AI assistants: the attendee directory you can already see as an attendee, your own profile, your own interest swipes, chats and meetings. Powers `gripeventsctl mcp` in the [GripEventsCtl](https://github.com/alexey-pelykh/gripeventsctl) umbrella binary.

> **Unofficial.** GripEventsCtl is NOT affiliated with, endorsed by, or supported by Grip. See the [project README](https://github.com/alexey-pelykh/gripeventsctl#readme) for the full use policy and disclaimer.

## Audience

End users should install the [`gripeventsctl`](https://www.npmjs.com/package/gripeventsctl) umbrella package and configure their MCP client to spawn `gripeventsctl mcp`. This package is published separately for embedders who want to host the server inside their own process.

## Install

```sh
npm install @gripeventsctl/mcp
```

Requires **Node.js >= 22.19.0**, ESM only.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)
