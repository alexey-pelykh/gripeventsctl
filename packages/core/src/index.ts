// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// The package entry exports what `main` exported before the transport item, under the same names, plus the issue's
// § Public interface and the types its signatures need; nothing else (issue #5 § Public interface). A later item that
// needs another name adds it with its own test (`__tests__/public-surface.test.ts`).

export {
  JWT_PATTERN_SOURCE,
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
} from "./transport/errors.js";
// The four address and version constants; the header builders stay inside the client, the one place the queue, the
// backoff, the timeout, the body cap and the redirect refusal are enforced, so no later package can build a Grip
// request around them.
export { API_ORIGIN, BASE_URL, GRIP_VERSION, USER_AGENT } from "./transport/headers.js";
export { type ConfigLookup } from "./transport/envelope.js";
export {
  type GetOptions,
  GripClient,
  type GripClientOptions,
  type LoginInput,
  type LoginResult,
  type PagesOptions,
  type PostOptions,
  type Query,
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
  OPERATIONS,
  type Operation,
  type OperationContext,
  type OperationKind,
  type RequestShape,
  defineOperation,
} from "./operations/index.js";
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
