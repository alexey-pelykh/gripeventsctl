<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Interest, strong interest and skip

Grip calls this a match answer, and the app calls the click a swipe.
`yes` shows interest in a person, `superyes` shows strong interest, and `no` skips the person.
Conventions, headers and labels are in [README.md](README.md).
Every call on this page sends the full header set with `X-Authorization: <user_token>`.

**A `yes` or `superyes` notifies the other person.**
Send one only on the user's explicit go-ahead.

## What the app sends: `match_manual` versus `match`

**From the app code** (build `Web/54.0.2`).
The click goes through `postAnswer` in the app's match service.
It builds one of two URLs from the same arguments:

| Where the person came from                                                                                                                      | Path the app uses                                         | Why                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Any list you browsed or searched yourself: search results, Interested-in-you, Connections, Interested, Skipped, a profile page, chat, a meeting | `thing/user_id/match_manual/<answer>/to_thing/<thing_id>` | The component flag `artificialMatch` is `true` everywhere except the recommendations list. |
| The Recommendations list (Grip's own suggestions, `GET .../thing/user_id/match`) and home-feed blocks whose `content_context` is `recommended`  | `thing/user_id/match/<answer>/to_thing/<thing_id>`        | `artificialMatch` is `false` only there.                                                   |

A person found through the directory search takes `match_manual`.
The plain `match` segment records an answer to a recommendation Grip served.
Whether the server accepts `match` for a person it never recommended is not verified.

## Send an answer

**Verified live 2026-10-07** for `yes` (90 sends in the first round, 481 in all that day).

```
POST https://api-prod.grip.events/1/container/<container_id>/thing/user_id/match_manual/<answer>/to_thing/<thing_id>
Content-Type: application/json

{"message": "<optional text, at most 250 characters>"}
```

- `user_id` is a literal. The server resolves it to the caller. `GET container/<container_id>/thing/user_id` returns the caller's own record; it was verified live by 2026-10-07, the date the source was written.
- `<thing_id>` is the target's thing id, the `id` from the directory search or the profile.
- `<answer>` is one of the values below. The app's enum is `NO`, `YES`, `SUPERYES`.

| `<answer>` | Meaning                                                        | Status                                    |
| ---------- | -------------------------------------------------------------- | ----------------------------------------- |
| `yes`      | Show Interest                                                  | Verified live 2026-10-07                  |
| `superyes` | Strong interest ("must-meet"), only where the event enables it | From the app code; not verified           |
| `no`       | Skip                                                           | From the app code; not verified as a POST |

### The message

- The message is optional.
- The app's textarea caps it at 250 characters. The cap for a meeting-decline message is 100 characters. Both caps are from the app code. What the server does with a longer message is not verified.
- The app shows the message box only for people (`type_category_id` `1`), not for companies.
- From a profile card with no text typed, the app sends `{"message": ""}`. From the chat and meeting screens it sends `{}`.
- Sending `yes` again with a new text is how the app's "edit intro message" works (from the app code). So a message can be added to an interest that already exists.

### The `source` query parameter

The app's call also takes `swipeOrigin`, `listIndex` and `source`.
They are analytics only, except that `source` becomes `?source=<value>` on the `match_manual` URL.
No code path in the saved app chunks sets `source`, so the app sends no query string (from the app code).

## Response

**Verified live 2026-10-07** (90 sends):

```
HTTP 201
{"success":true,"data":{"message":"action recorded - swipe message created or updated","connection":0}}
```

- `connection` is `1` when the answer made a mutual connection, because the other person had already shown interest. The app then adds the person to its connections list (from the app code).
- Every one of the 90 sends answered `connection: 0`.
- The text can be read back from the `interested` list (see [Related lists](#related-lists)). All 90 texts read back verbatim on 2026-10-07.

## Errors

### Throttling (HTTP 429)

**Verified live 2026-10-07.**

```
HTTP 429
{"success":false,"data":"Throttling - Maximum sending rate exceeded"}
```

- The 48th POST within 107 seconds answered 429. The loop did one status GET, one POST and a one-second pause per person.
- The server does not state its limit.
- The same POST went through 56 seconds later.
- 43 more POSTs at three seconds apart met no further 429.
- Later rounds that day at three seconds apart, 63 and then 328 POSTs, met no 429.

The bulk sender's own comment records the threshold as "the 47th POST in 105 s".
Take the threshold as about 47 POSTs in under two minutes, clearing within a minute.

### Errors the app matches on

**From the app code;** none was seen live.

| Answer                                          | Meaning                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `"limit of swipes reached for action"`          | The daily or event swipe cap. 90 `match_manual` sends in one morning on 2026-10-07 did not reach it. |
| `"action not allowed under current mode phase"` | Hosted-buyer events only.                                                                            |
| HTTP 409 with an `error.data` array             | The app opens a confirm dialog, for example when an admin preference exists for that pair.           |

In the normal, non-hosted-buyer code path the app only logs other errors.

## Check the state first

**Verified live 2026-10-07.** Read-only, no side effects.

```
GET https://api-prod.grip.events/1/container/<container_id>/thing/user_id/match/<thing_id>/status
```

```json
{ "success": true, "data": { "status": "has_match_none" } }
```

| `status`         | Meaning                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `has_match_none` | Not yet answered.                                                                                                                                                     |
| `has_match_yes`  | You showed interest. Seen for a person the user marked in the app on 2026-10-06.                                                                                      |
| `has_match_no`   | You skipped the person.                                                                                                                                               |
| `has_connection` | The other person showed interest back. They leave the `interested` list and appear under connections (see [chat-and-meetings.md](chat-and-meetings.md#chat-threads)). |

- The reversed form `thing/<thing_id>/match/user_id/status` answers 403.
- By 10:50 CEST on 2026-10-07, 26 of the 481 people sent to that day had reached `has_connection`.

Read the status before every POST.
Post only to `has_match_none`, so that an answer the user set by hand in the app (`has_match_yes`, `has_match_no`) stays as they set it.

## Undo

**From the app code;** not run live.

```
DELETE https://api-prod.grip.events/1/container/<container_id>/thing/<your_thing_id>/match_manual/yes/to_thing/<thing_id>
```

- The app's `deleteSwipe` passes your own numeric thing id, not `user_id`.
- It repeats the same `<answer>` and the same segment (`match` or `match_manual`) it posted with.
- HTTP 400 containing `"connection between things exist"` means the interest is already mutual. It cannot be withdrawn this way.

Whether `user_id` also works in the DELETE path is not verified.

## Related lists

All under `container/<container_id>/`.

| Call                                          | What it lists                                                      | Status                            |
| --------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `GET thing/user_id/interested?page=<n>`       | The people you showed interest in.                                 | Verified live 2026-10-07          |
| `GET thing/user_id/super_interested?page=<n>` | The people you showed strong interest in.                          | From the app code                 |
| `GET thing/user_id/skipped?page=<n>`          | The people you skipped.                                            | From the app code                 |
| `GET thing/user_id/interested_in_you`         | People who showed interest in you. The first call takes no `page`. | Called live 2026-10-07; see below |
| `GET thing/user_id/match`                     | Grip's recommendations.                                            | From the app code                 |

- `super_interested`, `skipped` and `interested_in_you` also take `?search=<text>&page=<n>` (from the app code).
- `interested` is paged. An empty `data` array ends it.
- Each `interested` entry carries `swipe_message` (the text, verbatim), `swipe_message_date_sent` (epoch), `match_date`, `rtm` and `rtm_score`.
- `interested_in_you` was empty on 2026-10-07, although three people had shown interest first. One explanation is that the list holds only interest you have not answered yet; that is not verified.

## Sending to many people

The 2026-10-07 runs used this pattern:

1. Skip a person whose message is longer than 250 characters, or who is already logged as sent.
2. Read the status first. Post only to `has_match_none`.
3. Append every attempt to a log (time, thing id, status before, HTTP code, body, message, success).
4. Pause three seconds between people.
5. On a 429, wait 60 seconds, doubling on each repeat, and retry the same person.
6. Stop at any other failed POST. A re-run skips everyone already logged as sent.
7. Read every text back from the `interested` list.

Outcome on 2026-10-07: 481 sent in three rounds (07:33 to 07:39, 08:03 to 08:07 and 10:23 to 10:45 CEST).
Every text read back verbatim, except for people who had already shown interest back: the `interested` list no longer carries them.

## Example

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
H=(-H "X-Authorization: $GRIPEVENTSCTL_TOKEN" -H 'login-source: web' -H 'X-Grip-Version: Web/54.0.2'
   -H 'Accept: application/json' -H 'origin: https://matchmaking.grip.events' -H 'referer: https://matchmaking.grip.events/')
THING_ID='<thing_id>'

# 1. Read-only: has this person been answered already?
curl -sS -A "$UA" "${H[@]}" \
  "https://api-prod.grip.events/1/container/9840/thing/user_id/match/$THING_ID/status"

# 2. Only with the user's explicit go-ahead: this notifies the person.
curl -sS -A "$UA" "${H[@]}" -H 'Content-Type: application/json' -X POST \
  -d '{"message":"<your message, at most 250 characters>"}' \
  "https://api-prod.grip.events/1/container/9840/thing/user_id/match_manual/yes/to_thing/$THING_ID"
```
