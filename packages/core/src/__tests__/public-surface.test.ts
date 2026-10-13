// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The public surface of `@gripeventsctl/core`: the value exports of the package entry (the issue's
 * § Public interface, every name that existed before the transport item, the option and result types'
 * companions, and the policy constants) and the production dependency set (AC-18). A name a later item
 * adds to the entry lands here too, so the surface never grows unnoticed.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as core from "../index.js";

/**
 * The value exports, sorted. Types are erased at run time and cannot be listed here; the entry also
 * exports these types: `Clock`, `Config`, `ConfigLookup`, `ConfigStore`, `DerivedPaths`, `Envelope`,
 * `ExecFileLike`, `GetOptions`, `GripClientOptions`, `GripErrorKind`, `GripErrorOptions`, `LoadResult`,
 * `LoginAnswer`, `LoginInput`, `LoginResult`, `OpReference`, `PagesOptions`, `PostOptions`, `Query`,
 * `ResolveSessionTokenOptions`, `Session`, `SessionOptions`, `StoreOptions`.
 */
const VALUE_EXPORTS = [
  // lib/redact.ts
  "APPLICATION_TOKEN_PATTERN_SOURCE",
  "BASIC_PATTERN_SOURCE",
  "BEARER_PATTERN_SOURCE",
  "JWT_PATTERN_SOURCE",
  "LOGIN_AUTHORIZATION_PATTERN_SOURCE",
  "MIN_REGISTERED_SECRET_LENGTH",
  "REDACTED",
  "RUNTIME_ONLY_PATTERN_SOURCES",
  "SECRET_PATTERN_SOURCES",
  "SESSION_TOKEN_PATTERN_SOURCE",
  "UUID_PATTERN_SOURCE",
  "redactString",
  "registerSecret",
  // lib/clock.ts
  "systemClock",
  // transport/errors.ts
  "ApiError",
  "AuthFailedError",
  "BODY_EXCERPT_LENGTH",
  "ConfigError",
  "ConflictError",
  "GatedTypeError",
  "GripError",
  "LoadBalancerRejectedError",
  "ModePhaseError",
  "NetworkError",
  "NoSessionError",
  "SwipeCapError",
  "ThrottledError",
  "UnknownSlugError",
  "UsageError",
  "WriteRefusedError",
  "isGripError",
  // transport/headers.ts: the four constants only; the header builders stay inside the client, the one
  // place the queue, the backoff, the timeout, the body cap and the redirect refusal are enforced.
  "API_ORIGIN",
  "BASE_URL",
  "GRIP_VERSION",
  "USER_AGENT",
  // transport/backoff.ts: the policy constants, not the schedule function.
  "MAX_RETRIES",
  "RETRY_AFTER_CAP_S",
  "SCHEDULE_S",
  // transport/envelope.ts: the documented reasons, not the schemas.
  "MODE_PHASE_REASON",
  "SWIPE_CAP_REASON",
  "THROTTLING_REASON",
  "UNKNOWN_SLUG_REASON",
  // transport/client.ts: the client and its three policy constants, not the path predicates.
  "BODY_CAP_BYTES",
  "GripClient",
  "PROFILE_SPACING_MS",
  "REQUEST_TIMEOUT_MS",
  // config/schema.ts
  "CONFIG_VERSION",
  "emptyConfig",
  "parseConfig",
  "validateConfig",
  // config/paths.ts
  "CONFIG_FILE_ENV",
  "DEFAULT_CONFIG_FILE_NAME",
  "configPath",
  "derivedPaths",
  "insideGitWorkTree",
  "workTreeWarnings",
  // config/store.ts
  "CONFIG_FILE_MODE",
  "clearSession",
  "createConfigStore",
  "loadConfig",
  "recordAuthFailure",
  "resolveSessionToken",
  "saveConfig",
  "saveSession",
  // config/op.ts
  "OP_NOT_FOUND_MESSAGE",
  "isFieldReference",
  "isItemReference",
  "opEnvironment",
  "opItemEditArgs",
  "opItemGetArgs",
  "opRead",
  "opReadArgs",
  "parseOpReference",
  "validateOpReference",
].sort();

describe("[CAP-CLIENT] the public surface of @gripeventsctl/core (issue #5 § Public interface, AC-18, AC-21)", () => {
  it("exports exactly the listed values from the package entry", () => {
    expect(Object.keys(core).sort()).toEqual(VALUE_EXPORTS);
  });

  it("AC-18: the production dependency set is exactly proper-lockfile, undici, yaml and zod", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@gripeventsctl/core");
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["proper-lockfile", "undici", "yaml", "zod"]);
  });
});
