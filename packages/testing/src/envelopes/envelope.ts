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

/** docs/api/README.md § User-Agent rule: the load balancer answers HTTP 403 with an HTML page, not JSON. */
export function loadBalancer403(): GripReply {
  return {
    statusCode: 403,
    data: "<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n</body>\n</html>\n",
    responseOptions: { headers: { "content-type": "text/html" } },
  };
}
