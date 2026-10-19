# @gripeventsctl/core

[![npm](https://img.shields.io/npm/v/%40gripeventsctl%2Fcore?logo=npm)](https://www.npmjs.com/package/@gripeventsctl/core)
[![License](https://img.shields.io/npm/l/%40gripeventsctl%2Fcore)](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)

Core library for the [GripEventsCtl](https://github.com/alexey-pelykh/gripeventsctl) toolkit: the client for a Grip-hosted event app's API, the session handling and the service namespaces.

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

## Audience

Library consumers who want programmatic access to the surfaces the `gripeventsctl` CLI exposes. End users should install the [`gripeventsctl`](https://www.npmjs.com/package/gripeventsctl) umbrella package instead; it ships the CLI binary and the MCP server.

## Install

```sh
npm install @gripeventsctl/core
```

Requires **Node.js >= 22.19.0**, ESM only.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/gripeventsctl/blob/main/LICENSE)
