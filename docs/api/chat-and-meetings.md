<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Chat, meetings and schedule

**Verified live 2026-10-07**, every call on this page, on container `9840`.
Conventions, headers and labels are in [README.md](README.md).
Every call sends the full header set with `X-Authorization: <user_token>`.

These calls sit directly under `https://api-prod.grip.events/1/`, not under `container/<container_id>/`.
They name the container in a `container_id` query parameter or body field instead.

## Chat threads

```
GET https://api-prod.grip.events/1/chat/latest?container_id=<container_id>
```

The answer lists every chat thread in `data`.
Each thread carries:

| Field                  | Content                               |
| ---------------------- | ------------------------------------- |
| `thing_id`             | The other person's thing id.          |
| `name`                 | Their name.                           |
| `job_title`            | Their job title.                      |
| `company_name`         | Their company.                        |
| `last_message`         | The text of the last message.         |
| `last_message_date`    | Its time (epoch).                     |
| `last_message_is_read` | Whether it has been read.             |
| `new_messages_count`   | The number of unread messages.        |
| `total_message_count`  | The number of messages in the thread. |
| `chat_id`              | The thread's id.                      |

A person who showed interest back gets a thread even before anyone types.
So this list is also the connections list.
`GET container/<container_id>/thing/user_id/connections` answers 404.

## Messages in a thread

```
GET https://api-prod.grip.events/1/chat/thing/<thing_id>
```

The answer lists the messages in `data`.
Each message carries `id`, `sender_id`, `recipient_id`, `message`, `date_created` (epoch), `is_read` and `meeting_action`.

## Send a chat message

**A chat message reaches the person.**
Send one only on the user's explicit go-ahead.

```
POST https://api-prod.grip.events/1/chat/thing/<thing_id>
Content-Type: application/json

{"message": "<text>", "container_id": <container_id>}
```

```
HTTP 200
{"success":true,"data":{"message_id":<id>}}
```

- On 2026-10-07, 35 messages were sent three seconds apart. None was throttled, and each read back verbatim.
- The app's own call is `postChatMessage`.
- The existing sender logs every attempt and skips a (thing id, text) pair already sent, so a run can be repeated. A person can still get a second, different message.

## Meetings

```
GET https://api-prod.grip.events/1/meeting/thing/user_id?container_id=<container_id>
```

The answer lists the caller's meetings.
Each meeting carries `meeting_id`, `organizer`, `date_start`, `status`, `location` and `table_name`.

## Schedule

```
GET https://api-prod.grip.events/1/schedule/thing/user_id/info?container_id=<container_id>
```

The answer carries `data.schedule`, one entry per meeting **and** per agenda session.
Each entry carries:

| Field                                        | Content                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `type`                                       | `meeting` or `session`.                                               |
| `status`                                     | `accepted`, `pending` or `declined`.                                  |
| `user_display_type`                          | How the app shows it, for example `confirmed` or `awaiting_response`. |
| `attendees`                                  | Each with `thing_id`, `name`, `company_name` and `status`.            |
| `requestor_id`                               | The thing id of the person who asked for the meeting.                 |
| `date_start_timestamp`, `date_end_timestamp` | Start and end (epoch).                                                |
| `location`                                   | Where it takes place.                                                 |
| `message`                                    | The note sent with the request.                                       |
| `has_conflict`                               | Whether it overlaps another entry.                                    |

The source lists `user_display_type` values only in part: `confirmed`, `awaiting_response`, and more not recorded.

## Interest lists and chat

`GET container/<container_id>/thing/user_id/interested_in_you` was empty on 2026-10-07, although three people had shown interest first.
See [interest.md](interest.md#related-lists).

## Example

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
H=(-H "X-Authorization: $GRIPEVENTSCTL_TOKEN" -H 'login-source: web' -H 'X-Grip-Version: Web/54.0.2'
   -H 'Accept: application/json' -H 'origin: https://matchmaking.grip.events' -H 'referer: https://matchmaking.grip.events/')

curl -sS -A "$UA" "${H[@]}" 'https://api-prod.grip.events/1/chat/latest?container_id=9840'
curl -sS -A "$UA" "${H[@]}" 'https://api-prod.grip.events/1/schedule/thing/user_id/info?container_id=9840'
```
