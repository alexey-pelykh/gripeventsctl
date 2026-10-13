// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export {
  JWT_PATTERN_SOURCE,
  REDACTED,
  SECRET_PATTERN_SOURCES,
  SESSION_TOKEN_PATTERN_SOURCE,
  UUID_PATTERN_SOURCE,
  redactString,
  registerSecret,
} from "./lib/redact.js";
export { type Clock, systemClock } from "./lib/clock.js";
export { ConfigError, GripError, NoSessionError } from "./transport/errors.js";
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
