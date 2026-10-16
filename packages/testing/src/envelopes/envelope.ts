// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { type GripReply, jsonReply } from "./reply.js";

/** docs/api/README.md § Response envelope: `{ "success": true, "data": <object, array or string> }` on HTTP 200. */
export function success200(data: unknown): GripReply {
  return jsonReply(200, { success: true, data });
}

/** docs/api/README.md § Response envelope: an error answers `"success": false` with `data` carrying the reason. */
export function failure(reason: string, statusCode: number): GripReply {
  return jsonReply(statusCode, { success: false, data: reason });
}

/**
 * docs/api/README.md § Response envelope: `{ "success": false, "data": <data> }` on any status, 200 by default, for an
 * answer whose `data` is not a plain reason string (an array, an object) or whose status the page does not record.
 */
export function apiFailure(data: unknown, statusCode = 200): GripReply {
  return jsonReply(statusCode, { success: false, data });
}

/**
 * docs/api/not-verified.md § Login and session: what the API answers to an expired or invalid `user_token` is not
 * verified; the client in `@gripeventsctl/core` reads HTTP 401 as an auth failure. This builder exists for that
 * documented 401 branch: HTTP 401 with `{ "success": false, "data": "<reason>" }`, the reason a fixture value.
 */
export function unauthorized401(reason = "unauthorized"): GripReply {
  return failure(reason, 401);
}

/** docs/api/README.md § User-Agent rule: the load balancer answers HTTP 403 with an HTML page, not JSON. */
export function loadBalancer403(): GripReply {
  return {
    statusCode: 403,
    data: "<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n</body>\n</html>\n",
    responseOptions: { headers: { "content-type": "text/html" } },
  };
}
