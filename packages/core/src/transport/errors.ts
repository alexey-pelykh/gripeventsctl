// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The errors GripEventsCtl reports to the user: the base class, the `config` kind and the
 * `no-session` kind. The transport item adds the other kinds. Every message and hint passes
 * through `redactString` when the error is built, so a token never travels inside an error.
 */

import { redactString } from "../lib/redact.js";

/**
 * The base class. `kind` names the class of failure and is what the CLI maps to an exit code;
 * `hint` says what to do next.
 */
export class GripError extends Error {
  readonly kind: string;
  readonly hint: string;

  constructor(kind: string, message: string, hint = "", options?: ErrorOptions) {
    super(redactString(message), options);
    this.name = new.target.name;
    this.kind = kind;
    this.hint = redactString(hint);
  }
}

/**
 * The config file cannot be found where it must be, read, parsed, validated, written or locked, or
 * an `op://` reference in it cannot be resolved. The auth commands item maps this kind to exit
 * code 8 in the CLI.
 */
export class ConfigError extends GripError {
  declare readonly kind: "config";

  constructor(message: string, hint = "", options?: ErrorOptions) {
    super("config", message, hint, options);
  }
}

/**
 * The config holds no session: the user has not signed in, or has signed out. The auth commands
 * item maps this kind to exit code 3 in the CLI.
 */
export class NoSessionError extends GripError {
  declare readonly kind: "no-session";

  constructor() {
    super("no-session", "no session", "gripeventsctl auth signin <slug>");
  }
}
