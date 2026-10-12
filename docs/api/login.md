<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Login

The login call turns an attendee's email and password into a `user_token` for one container.
Conventions, headers and labels are in [README.md](README.md).

## Before you log in

The login call needs two values you get from the config lookup first (see [containers.md](containers.md)):

- the container id. The 2026 id (`9840`) was found through the config lookup for the event's slug. The field of the config response that carries the looked-up container's id is not recorded in the sources (not verified). Do not use `default_container_id`: it names the application's current default event, not the looked-up container.
- the per-event application token, `data.application.general.token` of the same config.

## Request

```
POST https://api-prod.grip.events/1/user/account/login
Authorization: Bearer <application_token>, Basic <base64(email:password)>
Content-Type: application/json

{"container_id": <container_id>}
```

- `Authorization` carries two schemes in one header, separated by a comma: the per-event application token as a `Bearer`, then the attendee's credentials as `Basic`.
- `<base64(email:password)>` is the Base64 encoding of the attendee's email, a colon, and their password.
- The body names the container to log in to.
- Send a desktop browser `User-Agent`, as on every call (see [README.md](README.md#user-agent-rule)).

**Verified live 2026-10-06:** this call produced a working `user_token` at 21:09 on 2026-10-06 for container `9840`.
Which other headers the login call needs (`login-source`, `X-Grip-Version`, `origin`, `referer`) is not verified.

## Response

**Verified live 2026-10-06**, from the login response the maintainer's sign-in script recorded that evening. The values are not kept here; the shape is.

```json
{
  "success": true,
  "data": {
    "first_login": false,
    "user_token": "<session token: a 36-character UUID>",
    "chat_token": {
      "IdentityId": "eu-west-1:<identity id>",
      "Token": "<AWS Cognito token: a JWT about 1,000 characters long>",
      "$metadata": { "httpStatusCode": 200, "requestId": "<id>", "attempts": 1, "totalRetryDelay": 0 }
    }
  }
}
```

- `data.user_token` is the session token that every later call sends as `X-Authorization`.
- `data.chat_token` is an AWS Cognito identity token for the chat service. The 2024 mobile login returned the same two fields. Nothing in this project uses the chat token yet. It is a secret and is redacted like the session token.

## Example

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
BASIC=$(printf '%s:%s' "$GRIPEVENTSCTL_EMAIL" "$GRIPEVENTSCTL_PASSWORD" | base64)

curl -sS -A "$UA" -X POST \
  -H "Authorization: Bearer $GRIPEVENTSCTL_APP_TOKEN, Basic $BASIC" \
  -H 'Content-Type: application/json' \
  -d '{"container_id": 9840}' \
  'https://api-prod.grip.events/1/user/account/login'
```

## Token lifetime

The token lifetime is not stated anywhere and is not verified.
What was observed:

- a token written at 21:09 on 2026-10-06 still worked at 22:35 the same evening;
- the same token still worked at 07:39 on 2026-10-07, and all that morning.

What the API answers to an expired or invalid `user_token` is not verified.
The existing profile fetcher treats HTTP 401 as an auth failure; the directory dumper treats 401 and 403 as auth failures.

## Handling credentials

The `Basic` part carries the attendee's own password.
Send it only to `https://api-prod.grip.events/1/user/account/login`.
Never write the password, the `Basic` value, the application token or the `user_token` into a log, a file or an issue.
