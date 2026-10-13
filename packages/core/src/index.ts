// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export {
  APPLICATION_TOKEN_PATTERN_SOURCE,
  BASIC_PATTERN_SOURCE,
  BEARER_PATTERN_SOURCE,
  JWT_PATTERN_SOURCE,
  LOGIN_AUTHORIZATION_PATTERN_SOURCE,
  MIN_REGISTERED_SECRET_LENGTH,
  REDACTED,
  RUNTIME_ONLY_PATTERN_SOURCES,
  SECRET_PATTERN_SOURCES,
  SESSION_TOKEN_PATTERN_SOURCE,
  UUID_PATTERN_SOURCE,
  redactString,
  registerSecret,
} from "./lib/redact.js";
export { type Clock, systemClock } from "./lib/clock.js";
export {
  ApiError,
  AuthFailedError,
  BODY_EXCERPT_LENGTH,
  ConfigError,
  ConflictError,
  GatedTypeError,
  GripError,
  type GripErrorKind,
  type GripErrorOptions,
  LoadBalancerRejectedError,
  ModePhaseError,
  NetworkError,
  NoSessionError,
  SwipeCapError,
  ThrottledError,
  UnknownSlugError,
  UsageError,
  WriteRefusedError,
  isGripError,
} from "./transport/errors.js";
// The issue's § Public interface names the four address and version constants; the header builders
// stay inside the client, the one place the queue, the backoff, the timeout, the body cap and the
// redirect refusal are enforced, so no later package can build a Grip request around them.
export { API_ORIGIN, BASE_URL, GRIP_VERSION, USER_AGENT } from "./transport/headers.js";
export { MAX_RETRIES, RETRY_AFTER_CAP_S, SCHEDULE_S } from "./transport/backoff.js";
export {
  type ConfigLookup,
  type Envelope,
  type LoginAnswer,
  MODE_PHASE_REASON,
  SWIPE_CAP_REASON,
  THROTTLING_REASON,
  UNKNOWN_SLUG_REASON,
} from "./transport/envelope.js";
export {
  BODY_CAP_BYTES,
  type GetOptions,
  GripClient,
  type GripClientOptions,
  type LoginInput,
  type LoginResult,
  PROFILE_SPACING_MS,
  type PagesOptions,
  type PostOptions,
  type Query,
  REQUEST_TIMEOUT_MS,
} from "./transport/client.js";
export {
  CONFIG_VERSION,
  type Config,
  type Session,
  emptyConfig,
  parseConfig,
  validateConfig,
} from "./config/schema.js";
export {
  CONFIG_FILE_ENV,
  DEFAULT_CONFIG_FILE_NAME,
  type DerivedPaths,
  configPath,
  derivedPaths,
  insideGitWorkTree,
  workTreeWarnings,
} from "./config/paths.js";
export {
  CONFIG_FILE_MODE,
  type ConfigStore,
  type LoadResult,
  type ResolveSessionTokenOptions,
  type SessionOptions,
  type StoreOptions,
  clearSession,
  createConfigStore,
  loadConfig,
  recordAuthFailure,
  resolveSessionToken,
  saveConfig,
  saveSession,
} from "./config/store.js";
export {
  type ExecFileLike,
  OP_NOT_FOUND_MESSAGE,
  type OpReference,
  isFieldReference,
  isItemReference,
  opEnvironment,
  opItemEditArgs,
  opItemGetArgs,
  opRead,
  opReadArgs,
  parseOpReference,
  validateOpReference,
} from "./config/op.js";
