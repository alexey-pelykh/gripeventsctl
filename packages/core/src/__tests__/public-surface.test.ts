// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The public surface of `@gripeventsctl/core`: the value and type exports of the package entry, and the production
 * dependency set (AC-18). The entry exports what `main` exported before the transport item, under the same names, plus the
 * issue's § Public interface (the client, the four address and version constants, the fifteen error classes, the two
 * pattern lists and the two redaction functions) and the types their signatures need; nothing else (issue #5
 * § Public interface). A later item that needs another name adds it here with its own test, so the surface never
 * grows unnoticed.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as core from "../index.js";

/**
 * The type exports, sorted: erased at run time, so the compiler lists them (`exportedNames`). The types main
 * exported, and the ones the § Public interface signatures need (the client's options, inputs and results, the error
 * base's kind and options, the config lookup's answer).
 */
const TYPE_EXPORTS = [
  "Clock",
  "Config",
  "ConfigLookup",
  "ConfigStore",
  "DerivedPaths",
  "ExecFileLike",
  "GetOptions",
  "GripClientOptions",
  "GripErrorKind",
  "GripErrorOptions",
  "LoadResult",
  "LoginInput",
  "LoginResult",
  "OpReference",
  "PagesOptions",
  "PostOptions",
  "Query",
  "ResolveSessionTokenOptions",
  "Session",
  "SessionOptions",
  "StoreOptions",
].sort();

/** The value exports, sorted. */
const VALUE_EXPORTS = [
  // lib/redact.ts: what main exported, plus the two pattern lists of § Public interface; the single pattern sources
  // the transport item added and the registry's minimum length stay inside the module.
  "JWT_PATTERN_SOURCE",
  "REDACTED",
  "RUNTIME_ONLY_PATTERN_SOURCES",
  "SECRET_PATTERN_SOURCES",
  "SESSION_TOKEN_PATTERN_SOURCE",
  "UUID_PATTERN_SOURCE",
  "redactString",
  "registerSecret",
  // lib/clock.ts
  "systemClock",
  // transport/errors.ts: the fifteen error classes; the excerpt length and the escaping helpers stay inside the module.
  "ApiError",
  "AuthFailedError",
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
  // transport/headers.ts: the four constants only; the header builders stay inside the client, the one
  // place the queue, the backoff, the timeout, the body cap and the redirect refusal are enforced.
  "API_ORIGIN",
  "BASE_URL",
  "GRIP_VERSION",
  "USER_AGENT",
  // transport/client.ts: the client; its policy constants, the path predicates, the backoff schedule and the
  // documented reasons stay inside their modules.
  "GripClient",
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

/**
 * The names the package entry exports, as the TypeScript compiler reads `src/index.ts` under the package's own
 * tsconfig: `values` for every export with a value meaning (a class, a function, a constant), `types` for every
 * export with none (an interface, a type alias), each sorted.
 */
function exportedNames(): { values: string[]; types: string[] } {
  const configFile = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configFile,
    { composite: false, noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (parsed === undefined) throw new Error(`cannot read ${configFile}`);
  const program = ts.createProgram({ rootNames: [entry], options: parsed.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const entryModule = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (entryModule === undefined) throw new Error(`the compiler found no module at ${entry}`);
  const values: string[] = [];
  const types: string[] = [];
  for (const symbol of checker.getExportsOfModule(entryModule)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    (target.flags & ts.SymbolFlags.Value ? values : types).push(symbol.name);
  }
  return { values: values.sort(), types: types.sort() };
}

describe("[CAP-CLIENT] the public surface of @gripeventsctl/core (issue #5 § Public interface, AC-18, AC-21)", () => {
  it("exports exactly the listed values from the package entry at run time", () => {
    expect(Object.keys(core).sort()).toEqual(VALUE_EXPORTS);
  });

  it("exports exactly the listed types and values as the compiler reads the package entry, so a type removed or added fails here", () => {
    const { values, types } = exportedNames();
    expect(types).toEqual(TYPE_EXPORTS);
    // The compiler's value exports are the run-time ones: the split between the two lists is the compiler's own.
    expect(values).toEqual(VALUE_EXPORTS);
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
