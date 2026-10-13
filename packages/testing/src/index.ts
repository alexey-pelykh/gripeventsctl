// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { type Clock, FAKE_CLOCK_START, type FakeClock, fakeClock } from "./fake-clock.js";
export { FIXTURE_EMAIL, type FixtureSecrets, fixtureSecrets } from "./fixture-secrets.js";
export { type OpCall, type OpStub, STUB_OP_SUPPORTED, stubOp } from "./stub-op.js";
export { CONFIG_FILE_NAME, type GuardedPaths, guardedPaths } from "./guarded-paths.js";
export {
  HOME_ENV_NAMES,
  type TempHome,
  createTempHome,
  removeTempHome,
  restoreHomeEnv,
  saveHomeEnv,
  withTempHome,
} from "./temp-home.js";
export { GRIP_API_ORIGIN, type StderrSink, gripPool, mockGrip, stderrSink } from "./mock-grip.js";
export * from "./envelopes/index.js";
