<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Not verified

This page lists every claim in these docs that was not confirmed against the live API, or that the sources do not date.
Each item names what would verify it.
Conventions and labels are in [README.md](README.md).

**Warning.** Several checks below send a match answer or a chat message.
Those reach a real person.
Run them only on the account owner's explicit go-ahead.

## Every call

- **Whether the API tolerates the headers Node's `fetch` adds by itself.** The client in `@gripeventsctl/core` sends its requests through undici's `fetch`, which adds `accept-language`, `accept-encoding` and `sec-fetch-mode` to every request beside the headers [README.md](README.md) records. No recorded run sent them. Verify with the client's first live read: a 200 answer with these headers present.

## Login and session

- **Which headers the login call needs** besides `Authorization`, `Content-Type` and a browser `User-Agent` (`Accept`, `login-source`, `X-Grip-Version`, `origin`, `referer`). The client in `@gripeventsctl/core` sends all five on the login. Verify by logging in with each header left out in turn. See [login.md](login.md).
- **The token lifetime.** A token written at 21:09 on 2026-10-06 still worked at 22:35 that evening and at 07:39 on 2026-10-07, and all that morning. Verify by recording the last time a token works and the first time it fails.
- **What the API answers to an expired or invalid `user_token`.** The existing clients treat 401 (and the dumper also 403) as an auth failure. Verify by sending a deliberately wrong token to a read-only call and recording the status and body.
- **What the login call answers when it refuses the credentials.** No page here records it. The client in `@gripeventsctl/core` assumes HTTP 401 and reads a 401 answer to the login as refused credentials (the `auth-failed` kind, with the hint to check the email and the password). Verify with one login using a deliberately wrong password, recording the status and the body. See [login.md](login.md).

## Containers

- **Whether `data.container.general.container_id` holds the looked-up container's own id rather than the application's default.** On 2026-10-13 it held `9840` for `wsai26`, the one live edition read, whose `data.application.login.default_container_id` was `9840` too, so no value in that answer separates the looked-up id from the application's default. The ended edition `wsai25`, the only other slug read, answered without the key. Verify by reading the config answer of a live slug whose own id differs from `default_container_id` (containers.md's 2026-10-07 runs show the slug `inspiredmindshub` and the container `6700` InspiredMindsHub). Each further live or ended edition read narrows, without settling, whether every live edition carries the key and whether every ended edition lacks it. See [containers.md](containers.md#fields-of-a-200-answer).

## Attendees

- **The full path and the parameters of the facet endpoint.** The source gives only `/search/facet/value`. Verify from the web app's code or its network traffic, then call it on a live container. See [attendees.md](attendees.md#facets).
- **Which gated type id belongs to which group** (sponsor, exhibitor, organiser staff). Verify by reading `data.application.permissions.type_permissions` and the type names in the config. **Verified live 2026-10-13**: the config answer for the ended edition `wsai25` had no `data.application.permissions` at all, so run this check while the edition is live. See [containers.md](containers.md#fields-of-a-200-answer).
- **What N identifies in the 403 `thing N not authorized`.** [attendees.md](attendees.md#gated-for-a-normal-attendee-token-http-403) records this answer for a type set that holds a gated type. It does not record whether N is the gated type's id, or which id N names when the set holds several gated ids. The client in `@gripeventsctl/core` reports N as the id the answer names, never as a type id. Verify by searching with one gated type id alone, then with two, and comparing N with the ids sent.
- **Whether the profile endpoint throttles.** The existing fetcher backs off on 429, but the sources record no 429 from it. Verify by watching for 429 during a paced fetch.
- **The endpoints public scrapers call:** `container/<id>/search?...`, `search/extension/<id>` (a saved-search variant) and `thing/<id>/contact_details`. They were read from public repositories, not run. Verify with a read-only call on a live container. Note that the 2026 notes record a 400 for a search with `type_id` and no slash after `search`.

## Match answers (interest, strong interest, skip)

- **How the server treats `match` (as against `match_manual`) for a person Grip never recommended.** Verify by posting `match/yes` for one such person and reading the status. This notifies the person. See [interest.md](interest.md#what-the-app-sends-match_manual-versus-match).
- **The swipe cap** behind `"limit of swipes reached for action"`. 90 `match_manual` sends in one morning on 2026-10-07 did not reach it, and the 481 sends that day stopped on no such error. Verify only by reaching the cap, or from Grip's own statement.
- **`superyes`.** Read from the app code, and available only where the event enables it. Verify on an event that enables "must-meet", with one send. This notifies the person.
- **`no` sent through the API.** `has_match_no` was seen after the user skipped someone in the app, but no `no` was posted from a script. Verify with one POST of `no` and a status read.
- **What the server does with a message over 250 characters.** The 250-character cap is the app's textarea; every scripted message was kept within it. Verify with one over-long message. This notifies the person.
- **The `?source=<value>` query parameter.** No code path in the saved app chunks sets it. Verify only if a later app build sets it.
- **The rate limit itself.** The server does not state it. The 48th POST within 107 seconds answered 429 on 2026-10-07; three seconds between POSTs met no 429. Verify only from Grip's own statement, or by measuring again.
- **The errors the app matches on:** `"action not allowed under current mode phase"` (hosted-buyer events) and HTTP 409 with an `error.data` array. Read from the app code; none was seen live. Verify on a hosted-buyer event, or when an admin preference exists for a pair.
- **The body of an HTTP 409.** The app code reads an `error.data` array from its HTTP client's error object, which may be the body's own `data` (see [interest.md](interest.md#errors-the-app-matches-on)). No live 409 is recorded. Until one is, the client in `@gripeventsctl/core` reads both `{"error": {"data": [...]}}` and `{"success": false, "data": [...]}` as the `conflict` kind. Verify by recording the body of one live 409, for example when an admin preference exists for a pair.
- **Undo.** `DELETE container/<container_id>/thing/<your_thing_id>/match_manual/yes/to_thing/<thing_id>` and its 400 `"connection between things exist"` were read from the app code, not run. Verify by withdrawing one interest and reading the status.
- **Whether `user_id` works in the DELETE path.** The app sends the numeric thing id there. Verify with one DELETE using `user_id`.
- **The lists read from the app code:** `super_interested`, `skipped`, `interested_in_you` with `?search=<text>&page=<n>`, and `GET thing/user_id/match` (Grip's recommendations). Verify with read-only calls on a live container.
- **What `interested_in_you` holds.** It was empty on 2026-10-07 although three people had shown interest first. One explanation is that it holds only interest not yet answered. Verify by reading it while someone's interest is still unanswered, then again after answering.

## Chat, meetings and schedule

- **The full set of `user_display_type` values** in the schedule. The source names `confirmed` and `awaiting_response` and says there are more. Verify by reading schedules that hold meetings in every state. See [chat-and-meetings.md](chat-and-meetings.md#schedule).

## Platform landscape

- **The Grip Organiser MCP tools.** They were read from Grip's guide, not connected. Verify by connecting with an organiser account. See [platform-landscape.md](platform-landscape.md).
- **The rows marked "reported only".** Apple App Store pages answered 429 and apkpure answered 403 to the fetches, so these rows rest on the research passes' own reading of those pages. Verify by fetching each cited page, or by finding each event's slug with the config lookup.
- **Absence of public wrappers.** GitHub code search is known to be incomplete: one repository with all three hostnames surfaced only through repository search. The official MCP Registry timed out, and PulseMCP and Reddit blocked the research agent. An empty result there is not proof of absence. Verify by repeating those searches.
- **The Swagger document behind the organiser dashboard.** It was not looked for. Verify with an organiser login.
- **Whether the anti-scraping blocking is active** for container `9840` or any other container. It cannot be seen from outside. The 2026-10-06 directory dump and profile fetches did not trip it.
- **The organiser API's `/thing/register`** and its Grip Dashboard token. Read from Lead Liaison's connector page, not called. Verify with an organiser token.
- **The earlier public endpoints** `api.intros.at/1/public/container/...` and `api.intros.at/1/public/session/...`. The Wayback CDX index lists them answering 200 in 2020 and 2021; the snapshots were not opened. Verify by opening the snapshots.
- **The Gemini report's claim that Informa left Grip.** Recorded as unsupported: its only source does not mention Grip in that context, and live Money20/20 containers contradict it. Its market-size figures were not checked.

## Claims the sources do not date

These come from the 2026 notes without a date of their own.
Verify each by running the call again on a live container and recording the date.

- The trailing slash after `search` matters; a search with `type_id` and no slash answers 400.
- A search page holds 20 entries, and no parameter overrides the page size.
- The listable types `5956`, `5959`, `5957`, `1031`, `415`, `453` and the gated types `5919`, `5930`, `5958`, `6107`, `6109`, `1630` of World Summit AI 2026. The directory dump they fed ran on 2026-10-06.
- The 4,506 attendees across the six listable types.
- A type set that includes a gated id answers 403 for the whole call.
- `data.application.permissions.type_permissions` holds the year's type set, and `GET thing/type` is platform-wide. The config answer for the ended edition `wsai25` had no `data.application.permissions` at all (**Verified live 2026-10-13**; see [containers.md](containers.md#fields-of-a-200-answer)), so confirm the type set while the edition is live.
- The facet counts: 554 attendees ticked "Consultancy AI" and 562 "IT Services and software" under Company Type Interested.
- `GET container/<container_id>/thing/user_id` returns the caller's own record. The source marks it verified live and was written on 2026-10-07, but gives no date for the check itself.
