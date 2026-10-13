<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Grip attendee API

This folder documents the API that Grip-hosted event apps call on `api-prod.grip.events`.
GripEventsCtl is built from these pages.
Grip publishes no documentation for this API (see [platform-landscape.md](platform-landscape.md)).
Everything here was read from Grip's own matchmaking web app or tested against the live API with an attendee account.

## Pages

| Page                                           | What it covers                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [login.md](login.md)                           | The login call that turns an attendee's credentials into a `user_token`.                        |
| [containers.md](containers.md)                 | Event config by slug, the per-event application token, listing the containers a session sees.   |
| [attendees.md](attendees.md)                   | Directory search, paging, type ids, the per-person profile, facets, rates, id persistence.      |
| [interest.md](interest.md)                     | `match_manual` yes, superyes and no, the message, the status check, undo, related lists, 429.   |
| [chat-and-meetings.md](chat-and-meetings.md)   | Chat threads, chat messages, meetings and the schedule.                                         |
| [platform-landscape.md](platform-landscape.md) | Public coverage of the API, the organiser API, other events on Grip, the anti-scraping roadmap. |
| [not-verified.md](not-verified.md)             | Every claim the sources mark as not verified, with what would verify it.                        |

## Base URL

Every attendee call goes to:

```
https://api-prod.grip.events/1/
```

Paths in these pages are relative to that base unless they start with `https://`.
For example, `container/9840/search/` means `https://api-prod.grip.events/1/container/9840/search/`.
`GET https://api-prod.grip.events/` answers "Welcome to the Intros API" (verified 2026-10-07).

## Headers every call sends

The web app build `Web/54.0.2` sends this set on authenticated calls.
The existing clients send the same set on every call after login.

| Header            | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `X-Authorization` | the `user_token` (see [Authentication](#authentication))           |
| `User-Agent`      | a desktop browser string (see [User-Agent rule](#user-agent-rule)) |
| `login-source`    | `web`                                                              |
| `X-Grip-Version`  | `Web/54.0.2`                                                       |
| `Accept`          | `application/json`                                                 |
| `origin`          | `https://matchmaking.grip.events`                                  |
| `referer`         | `https://matchmaking.grip.events/`                                 |

A call with a body also sends `Content-Type: application/json`.

`X-Grip-Version` was `Web/54.0.2` on 2026-10-07.
Public scrapers sent `Web/22.0.6` in 2023 and `Web/37.0.0` in early 2025, so the value moves with app releases.

## User-Agent rule

The AWS load balancer in front of the API answers HTTP 403 to `curl`'s default User-Agent.
Send a desktop browser User-Agent on every call.
The existing clients send:

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36
```

On 2026-10-07, every `container` call answered 403 with an HTML page from the load balancer until the request also carried `origin: https://matchmaking.grip.events` and `referer: https://matchmaking.grip.events/`.
Send `origin` and `referer` with the browser User-Agent on every authenticated call.

## Authentication

The API uses two different auth headers.

| Header                          | Value                                                    | Used for                                                                                 |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Authorization: Bearer <token>` | the bootstrap bearer, or the per-event application token | `config?container_name=<slug>` (bootstrap bearer) and the login call (application token) |
| `X-Authorization: <user_token>` | the session token the login call returns                 | every call made as the attendee: search, profiles, interest, chat, meetings, containers  |

- The **bootstrap bearer** is `8tnDoVVUeuFAGj4ztm9yuzYhG4vGznfz`. It is public: the web app ships with it. It is enough for the config lookup by slug, with no login. See [containers.md](containers.md).
- The **per-event application token** is `data.application.general.token` in the config response. The login call sends it together with the attendee's `Basic` credentials. See [login.md](login.md). Treat it as a credential: never paste it anywhere.
- The **`user_token`** is the session token. Every attendee call sends it in `X-Authorization`. Treat it as a credential.

## Response envelope

The JSON answers recorded in the sources have this shape:

```json
{ "success": true, "data": "<object, array or string>" }
```

An error answers `"success": false`, and `data` carries the reason, for example `{"success":false,"data":"Throttling - Maximum sending rate exceeded"}`.
A list endpoint returns an array in `data`. A paged list ends with an empty `data` array.
One exception is read from the app code only: an HTTP 409 on a match answer carries an `error.data` array (see [interest.md](interest.md#errors-the-app-matches-on)).
The load balancer's 403 is an HTML page, not JSON.

## How claims are dated

These pages port two research notes written on 2026-10-07 for World Summit AI 2026 (container `9840`, slug `wsai26`), with later checks on 2026-10-09 and 2026-10-13.
Each claim carries one of these labels:

| Label                        | Meaning                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Verified live YYYY-MM-DD** | The call was run against `api-prod.grip.events` on that date and the answer was read.                                    |
| **From the app code**        | Read from the JavaScript of the matchmaking web app build `Web/54.0.2`. The call was not run.                            |
| **Not verified**             | Neither run nor read in the app code, or the source gives no date. [not-verified.md](not-verified.md) lists all of them. |

Dates are ISO 8601 (`YYYY-MM-DD`).
Clock times are local time in Amsterdam (CEST, UTC+2) unless a page says otherwise.
Counts (type totals, facet counts, rates, throttling thresholds) are measurements of the 2026 edition on the date given. They will differ for other events and other years.
Timestamps in API answers are Unix epoch seconds.

## Vocabulary

These pages use Grip's own words.

| Word                        | Meaning                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| application                 | An organiser's white-label app on Grip: a branded mobile app plus a web app. It has an `application_id` and holds one container per event edition. |
| container                   | One event edition, for example `9840` for World Summit AI 2026. It has a numeric id and a slug.                                                    |
| slug                        | The container's fixed "system name", the path in `https://matchmaking.grip.events/<slug>`. The config lookup takes it as `container_name`.         |
| thing                       | An attendee record (also a company record). Every thing has a numeric thing id.                                                                    |
| type                        | An attendee category inside a container: Subscriber, Speaker, VIP, Press, Team, Partner, and the gated ones.                                       |
| `user_id`                   | A literal path segment. The server resolves it to the caller's own thing.                                                                          |
| `match_manual` `yes`        | Show interest in a person.                                                                                                                         |
| `match_manual` `superyes`   | Strong interest ("must-meet"), only where the event enables it.                                                                                    |
| `match_manual` `no`         | Skip a person.                                                                                                                                     |
| connection                  | Two people who have both shown interest. The app opens a chat thread between them.                                                                 |
| `user_token`                | The session token, sent as `X-Authorization`.                                                                                                      |
| bootstrap bearer            | The public bearer token the web app ships with.                                                                                                    |
| per-event application token | `data.application.general.token` from the config lookup, used by the login call.                                                                   |

Placeholders in angle brackets stand for values you supply: `<container_id>`, `<thing_id>`, `<slug>`, `<user_token>`.
`curl` examples read the session token from `$GRIPEVENTSCTL_TOKEN`.

## How these endpoints were found

Redo these steps when the app changes.
The chunk names below are those of build `Web/54.0.2` on 2026-10-07; a new build renames them.

1. `GET https://matchmaking.grip.events/<slug>` returns the app shell. It references `main.js`, which references `chunk-XXXXXXXX.js` files.
2. Fetch every referenced chunk from `https://matchmaking.grip.events/<chunk>.js` with a browser User-Agent. Repeat for chunk names found inside the fetched chunks until no new names appear. Many feature modules load lazily: the swipe service appeared only on the second pass. The closure reached 76 chunks on 2026-10-07.
3. Search the chunks for `this.http.post(` and for `postAnswer(`.
   - The match service (`chunk-H3QF5ZOW.js`) holds the URL templates and the `NO`, `YES`, `SUPERYES` enum.
   - The network list component (`chunk-WVJZ3RBJ.js`) decides `match` versus `match_manual`.
   - The profile-card component (`chunk-DPHXZMBC.js`, method `onInterestedIn`) shows the request arguments and the error handling.
   - `chunk-DCG7KCKL.js` holds the related lists and `postChatMessage`.
4. Confirm placeholders and read-only endpoints against the live API before documenting them.
