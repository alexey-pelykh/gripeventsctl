// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** Env var that opts a run into the live suite. Unset: `pnpm test:e2e` collects nothing. */
export const E2E_ENV_VAR = "GRIPEVENTSCTL_E2E";

export function isE2EEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[E2E_ENV_VAR] === "1";
}

// The harness library (issue #18 § Public interface): private to this package's own files.
export { PathSequencer, sortByPath } from "./lib/sequencer.js";
export { type LiveSession, NO_SESSION_MESSAGE, liveSession } from "./lib/session.js";
export { type ProbeStore, probeStore } from "./lib/probe-store.js";
export { type RecordedCall, type Recorder, recordingDispatcher, stripQuery } from "./lib/recorder.js";
export { type LiveServer, liveServer } from "./lib/server.js";
export {
  type Classification,
  type Concluder,
  type FieldType,
  INCONCLUSIVE_KINDS,
  type Outcome,
  classify,
  conclude,
  drift,
  elementMismatches,
  errorKind,
  fieldAt,
  hasType,
  inconclusive,
  isPositiveInteger,
  isRecord,
  requireArray,
  requireRecord,
  typeMismatches,
} from "./lib/outcome.js";
export { SUMMARY_PREFIX, runDate, summaryLine, templatePath } from "./lib/summary.js";
export { V1_TOOL_NAMES, WRITE_KIND_NAMES, WRITE_TOOL_NAMES } from "./lib/write-operations.js";
export {
  TYPE_ID_ENV,
  TYPE_PROBE_BOUND,
  TYPE_PROBE_PACE_MS,
  collectTypeIds,
  configuredTypeId,
} from "./lib/type-probe.js";
export {
  type Live,
  type LiveFixture,
  type ToolCall,
  UNMATCHED_TEMPLATE,
  callLive,
  checkedCall,
  openLive,
  report,
  requestShapes,
  summaryLines,
} from "./lib/live-check.js";
export {
  LIVE_DIR,
  LIVE_FILE_NAMES,
  WORKFLOWS_DIR,
  WRITE_FILE,
  isLiveFile,
  shapeFindings,
  withoutHeader,
} from "./lib/suite-shape.js";
