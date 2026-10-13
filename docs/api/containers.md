<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Containers

A container is one event edition.
Every organiser has an application (a white-label app) that holds one container per edition.
Conventions, headers and labels are in [README.md](README.md).

## Config by slug

**Verified live 2026-10-07.** No login is needed.

```
GET https://api-prod.grip.events/1/config?container_name=<slug>
Authorization: Bearer 8tnDoVVUeuFAGj4ztm9yuzYhG4vGznfz
Accept: application/json
User-Agent: <a desktop browser string>
```

- `8tnDoVVUeuFAGj4ztm9yuzYhG4vGznfz` is the bootstrap bearer. The public web app ships with it.
- `<slug>` is the path of the event's web app, `https://matchmaking.grip.events/<slug>`. It is the container's fixed "system name".
- The lookup is case-insensitive (2026-10-07). For example, the slug `ITCVegas2026` is published in mixed case.
- This call worked without `origin` and `referer` on 2026-10-07.

### Answers

| HTTP | Body                                               | Meaning                     |
| ---- | -------------------------------------------------- | --------------------------- |
| 200  | `success: true`, config in `data`                  | The slug exists on Grip.    |
| 404  | `data`: `No results found for this container name` | No container has this slug. |

A 404 means only that this slug is unknown, not that the event is absent from Grip.
The 2024 and 2023 World Summit AI editions exist (container ids `7509` and `6353`) under slugs other than `wsai24` and `wsai23`.

### Fields of a 200 answer

| Field                                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data.container.general.container_id`           | The looked-up container's own id (a reading still open, see below). **Verified live 2026-10-13**: `9840` for `wsai26`; the ended edition `wsai25` answered without this key (see the two reads below).                                                                                                                                                                                                                                                                                                       |
| `data.container.general.display_name`           | The event's display name, for example "World Summit AI Amsterdam 2026".                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `data.container.general.name`                   | The container name. The existing slug checker falls back to it when `display_name` is empty.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `data.container.general.active`                 | `1` while the edition is live, `0` once it has ended.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `data.application.general.application_name`     | The organiser's white-label application, for example "Inspired Minds".                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `data.application.general.application_id`       | Its numeric id, for example `165`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `data.application.general.token`                | The per-event application token. The login call needs it (see [login.md](login.md)). Never paste it anywhere.                                                                                                                                                                                                                                                                                                                                                                                                |
| `data.application.permissions.type_permissions` | The type permissions of the application. Use it to confirm a year's type set (see [attendees.md](attendees.md#types)). **Verified live 2026-10-13**: `data.application.permissions` was present for `wsai26` (an object; nothing beneath it was read) and absent for the ended edition `wsai25` (both in the key paths below). So confirm the type set while the edition is live. That condition rests on one ended read, which supports it but does not settle whether every ended edition lacks the block. |
| `data.application.login.default_container_id`   | The application's current default event, **not** the looked-up container's id. It was `9840` for every Inspired Minds slug on 2026-10-07. **Verified live 2026-10-13**, nesting included (see the two reads below).                                                                                                                                                                                                                                                                                          |

**Verified live 2026-10-13**, two config answers, both HTTP 200: `wsai26`, live, and `wsai25`, ended. Their `active` flags, `1` and `0`, are from the run of 2026-10-07 under § Example.
What the two reads established:

- In the `wsai26` answer exactly two key paths held `9840`: `data.container.general.container_id` and `data.application.login.default_container_id`. No other key path held or contained it.
- In the `wsai25` answer only `data.application.login.default_container_id` held `9840`. No key path held or contained `8869`, so nothing in that answer carries the container's id. Its `data.container.general` is a six-key block without `container_id`, and the live `wsai26` block lacks three of those six keys. Its `data.container` holds nothing beside `general` (both listed below). Whether the different key set follows from the edition having ended is not known from one ended read.
- `data.application.login.default_container_id` is the only `default_container_id` key in either answer.

Still open: whether `data.container.general.container_id` holds the looked-up container's own id rather than the application's default (see [not-verified.md](not-verified.md#containers)).

**Verified live 2026-10-13**: the key paths read, as names and types only.
This inventory is selective: it lists the members of `data` by name and type, `data.container.general` and `data.application.general` in full for both answers, the blocks beside them under `data.container` and under `data.application` by name and type, and `data.application.login` by its `default_container_id` key alone.
No other block or key is listed.

- Both answers have the envelope of [README.md](README.md#response-envelope); `data` holds `date_now` (number), `container` (object) and `application` (object).
- `data.container.general` for `wsai26`:
  - `container_id` (number)
  - `active` (number)
  - `name` (string)
  - `display_name` (string)
  - `search_disabled` (number)
  - `type` (string)
  - `website_url` (null)
  - `branch_url` (string)
  - `home_page_background_url` (string)
  - `external_venue_id` (null)
  - `is_launched` (number)
  - `container_contact_sharing` (string)
  - `contact_sharing_options` (array)
  - `show_userfeed_navigation` (number)
  - `allow_virtual_meeting_room` (number)
  - `format` (string)
  - `homefeed_blocks_available` (number)
  - `has_sessions` (number)
  - `allow_instant_meeting` (number)
  - `instant_time_data_lock` (number)
  - `virtual_meeting_room_mode` (string)
  - `virtual_meeting_room_provider` (string)
  - `virtual_meeting_room_provider_key` (null)
  - `pending_meeting_block` (number)
  - `allow_virtual_meeting_start_before` (number)
  - `allow_speed_networking` (number)
  - `allow_session_location_groupchat` (number)
  - `agenda_display_format` (string)
- Beside `general`, `data.container` for `wsai26` held `style`, `locale`, `search`, `login`, `hosted_buyer`, `right_navigation_menu` and `feature_control` (objects) and `user_agreements` and `help_links` (arrays).
- `data.container.general` for `wsai25`: only `active` (number), `default_locale` (string), `name` (string), `theme_primary_color` (string), `primary_color` (string) and `display_name` (string).
- `data.container` for `wsai25` held nothing beside `general`.
- `data.application` for `wsai26`: `general`, `sso`, `locale`, `login`, `style`, `tracker`, `notifications`, `floorplans`, `badge_scan`, `event_config`, `engagement_hub_settings` and `permissions` (objects), `registration`, `user_agreements` and `help_links` (arrays) and `is_public_library` (boolean). For `wsai25`: the same without `permissions`.
- `data.application.general`, the same in both answers: `token` (string, the application token: never paste it), `application_id` (number), `grip_cdp_token` (string, not read and not to be pasted either), `application_name` (string), `min_app_version` (null) and `domains` (array).
- `data.application.login`, the same keys in both answers: of them only `default_container_id` (number) is listed here.

### Example

```
$ python3 -I grip_slug_check.py wsai26 wsai25 wsai24 inspiredmindshub nosuchslug12345
wsai26	200	active=1	World Summit AI Amsterdam 2026	Inspired Minds	app=165
wsai25	200	active=0	World Summit AI Amsterdam 2025	Inspired Minds	app=165
wsai24	404	-	No results found for this container name	-	-
inspiredmindshub	200	active=1	InspiredMinds! Community Hub	Inspired Minds	app=165
nosuchslug12345	404	-	No results found for this container name	-	-
```

This run is from 2026-10-07.
The script sends one GET per slug and prints slug, HTTP status, active flag, display name, application name and application id.
It never prints the application token.

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
curl -sS -A "$UA" \
  -H 'Authorization: Bearer 8tnDoVVUeuFAGj4ztm9yuzYhG4vGznfz' \
  -H 'Accept: application/json' \
  'https://api-prod.grip.events/1/config?container_name=wsai26'
```

## The per-event application token

`data.application.general.token` from the config lookup is the per-event application token.
The login call sends it as `Authorization: Bearer <application_token>`, together with the attendee's `Basic` credentials (see [login.md](login.md)).
Treat it as a credential.

## Containers a session sees

**Verified live 2026-10-07**, with a `user_token` for container `9840`, GET requests only.
These calls send `X-Authorization` and the full header set from [README.md](README.md#headers-every-call-sends).

| Call                        | Result                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET container`             | 200. A list of the **active** containers of the token's application (`application_id` `165`, `application_name` "Inspired Minds"): `6700` InspiredMindsHub (`format` `engagement_hub`, `has_joined` `false`) and `9840` WSAI26. Ended editions are absent. |
| `GET container?search=WSAI` | 200. The same list, filtered by a substring of the name. `search=summit` returns `[]` because the names are `WSAI26` and `InspiredMindsHub`.                                                                                                               |
| `GET container?name=...`    | `name=` is not a filter.                                                                                                                                                                                                                                   |
| `GET container/6700`        | 200, although the user never joined container `6700`. Readability follows the application, not membership.                                                                                                                                                 |

Each container record carries `branch_url`, the deep link into the organiser's branded Grip app, for example `https://inspiredminds.app.link/WSAI26`.

Every `container` call answered 403 with an HTML page from the load balancer until the request carried `origin: https://matchmaking.grip.events` and `referer: https://matchmaking.grip.events/` along with the browser User-Agent.

## What a session cannot see

**Verified live 2026-10-07.**

| Call                                                                                | Result                                                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET container/8869` (WSAI25), `container/7509`, `container/6353`, `container/9841` | 404 `container not found`. Ended containers and other applications' containers are invisible to this token. |
| `GET application/165`, `GET application`, `GET user/account`                        | 404 `requested path not found`.                                                                             |

So the attendee API cannot list events across organisers.
It shows only the live events of the token's own application.
To check an event of another organiser, use the config lookup by slug above (see also [platform-landscape.md](platform-landscape.md#how-to-check-whether-an-event-runs-on-grip)).

## Containers shared with another attendee

`common_containers` on a per-person profile lists only the containers that person shares with the caller (see [attendees.md](attendees.md#the-per-person-profile)).
Across the 1,473 profiles fetched by 2026-10-07, it named WSAI26 (`9840`), WSAI25 (`8869`), World Summit AI Amsterdam 2024 (`7509`) and 2023 (`6353`), and nothing else.

## Scale of the platform

Container ids near 9,840 and application ids past 1,100 (seen on 2026-10-07) say the platform has hosted thousands of event containers.
