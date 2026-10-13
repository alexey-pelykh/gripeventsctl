<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Attendees

Attendee records are things.
Each thing belongs to a type, the attendee category.
Conventions, headers and labels are in [README.md](README.md).
Every call on this page sends the full header set with `X-Authorization: <user_token>`.

## Directory search

**Verified live 2026-10-06:** the World Summit AI 2026 directory dump used this call.

```
GET https://api-prod.grip.events/1/container/<container_id>/search/?page=<n>&sort=name&type_id=<type_ids>
```

| Parameter | Value                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| `page`    | Page number, starting at `1`.                                                   |
| `sort`    | `name`.                                                                         |
| `type_id` | One type id or several, comma-separated, for example `5956,5957,5959,1031,415`. |

Rules recorded for the 2026 edition (the source gives no separate date for each, see [not-verified.md](not-verified.md#claims-the-sources-do-not-date)):

- The trailing slash after `search` matters. A request with `type_id` and no slash after `search` answers HTTP 400.
- A page holds 20 entries. No parameter overrides the page size.
- Page until `data` is an empty array.
- Each entry carries the thing id in `id`. The thing id is the key for the profile, interest and chat calls.
- A type set that includes any gated type id answers 403 for the whole call (see [Types](#types)).

The 2026 dump paused 1.5 seconds between pages.
That pause is the client's choice; the source records no limit on search paging.

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
H=(-H "X-Authorization: $GRIPEVENTSCTL_TOKEN" -H 'login-source: web' -H 'X-Grip-Version: Web/54.0.2'
   -H 'Accept: application/json' -H 'origin: https://matchmaking.grip.events' -H 'referer: https://matchmaking.grip.events/')

curl -sS -A "$UA" "${H[@]}" \
  'https://api-prod.grip.events/1/container/9840/search/?page=1&sort=name&type_id=5956,5957,5959,1031,415'
```

## Types

The type set can differ from one edition to the next: confirm it for each edition.
The ids below are those of World Summit AI 2026 (container `9840`).
The source does not date the probe that sorted them; the directory dump it fed ran on 2026-10-06.

### Listable for a normal attendee token (HTTP 200)

| Type id | Type       |
| ------- | ---------- |
| `5956`  | Subscriber |
| `5959`  | Speaker    |
| `5957`  | VIP        |
| `1031`  | Press      |
| `415`   | Team       |
| `453`   | Partner    |

Together these six types held 4,506 attendees in the 2026 edition (the source gives no date for this count).

### Gated for a normal attendee token (HTTP 403)

| Type id | Note                                  |
| ------- | ------------------------------------- |
| `5919`  | sponsor, exhibitor or organiser staff |
| `5930`  | sponsor, exhibitor or organiser staff |
| `5958`  | sponsor, exhibitor or organiser staff |
| `6107`  | sponsor, exhibitor or organiser staff |
| `6109`  | sponsor, exhibitor or organiser staff |
| `1630`  | sponsor, exhibitor or organiser staff |

A gated type answers 403 `thing N not authorized`.
Its attendees cannot be pulled through the directory search.
The source names the group (sponsor, exhibitor and organiser staff) but does not map each id to one of them.

### How to confirm a year's type set

1. Read `data.application.permissions.type_permissions` from the config lookup (see [containers.md](containers.md#fields-of-a-200-answer)). **Verified live 2026-10-13**: the config answer for the ended edition `wsai25` had no `data.application.permissions` at all, so run this step while the edition is live.
2. Probe each type id alone with the directory search. A 200 means listable; a 403 means gated.

Do not use the global catalog `GET thing/type`: it lists the types of the whole platform, not the container's set.

## Search payload versus the per-person profile

The search payload omits the rich Grip fields.
Seniority, sector and intent are not in it.
They live on the per-person profile and in the facets.

## The per-person profile

**Verified live 2026-10-06.**

```
GET https://api-prod.grip.events/1/container/<container_id>/thing/<thing_id>
```

The answer carries the thing in `data`, with `data.id` equal to the requested `<thing_id>`.
Fields the search payload lacks:

| Field                      | Content                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `rtm`, `rtm_raw`           | The rich Grip profile fields, for example LinkedIn Profile link, Company Type, Company Type Interested, Investment status, Job Level. |
| `sessions.speaker[]`       | The sessions the attendee speaks at: `session_name`, `description`, `track`, `location`, `date_start` (epoch).                        |
| `common_containers`        | Past events both the attendee and the caller attended. It lists only containers shared with the caller.                               |
| `common_connections_count` | The count of common connections.                                                                                                      |
| `rtm_score`                | Grip's own match score.                                                                                                               |

`GET container/<container_id>/thing/user_id` returns the caller's own record.
It was verified live by 2026-10-07, the date the source was written; the source gives no separate date for this check.

```bash
curl -sS -A "$UA" "${H[@]}" "https://api-prod.grip.events/1/container/9840/thing/$THING_ID"
```

## Profile fetch rate

**Measured 2026-10-06** on container `9840`.

The profile endpoint is slow and serialised per session:

- One call alone returns in about 1 second.
- Two, three or ten parallel workers all yield only 0.3 to 1 profile per second.
- 800 profiles take 15 to 30 minutes.

Parallel workers do not help.
Start a large profile fetch first and order the thing ids by priority.
The existing fetcher runs two workers with 0.1 seconds between calls, skips ids already on disk, and stops on an auth error or after twelve consecutive failures.
It backs off on HTTP 429; whether the profile endpoint throttles is not recorded.

## Facets

Facet counts for the whole container come from the facet endpoint:

```
GET .../search/facet/value
```

The source gives the path only as `/search/facet/value`.
Its full prefix and its parameters are not recorded (not verified).
The saved answer has this shape:

```json
{
  "data": [
    {
      "name": "<facet label>",
      "facet": "<facet key>",
      "type_id": "<type id>",
      "values": [{ "value": "<option>", "count": 0 }]
    }
  ]
}
```

In the 2026 edition, 554 attendees ticked "Consultancy AI" and 562 ticked "IT Services and software" under Company Type Interested (the source gives no date for these counts).

## Thing ids persist across events

**Checked 2026-10-09.**

Grip thing ids persist across years and containers.
Your own thing id appears in both the 2024 and the 2026 World Summit AI directory dumps.
The first 4,000 attendance records of each of those years share 124 thing ids.
A thing id is therefore a valid key for one person across events, where a name is not.
