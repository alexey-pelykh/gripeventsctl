// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { type Clock, FAKE_CLOCK_START, type FakeClock, fakeClock } from "./fake-clock.js";
export { FIXTURE_EMAIL, type FixtureSecrets, fixtureSecrets } from "./fixture-secrets.js";
export { type OpCall, type OpStub, STUB_OP_SUPPORTED, stubOp } from "./stub-op.js";
export { CONFIG_FILE_NAME, type GuardedPaths, guardedPaths } from "./guarded-paths.js";
export { guardMessage, isInside, outsideTempHome } from "./setup-guard.js";
export {
  HOME_ENV_NAMES,
  type TempHome,
  createTempHome,
  removeTempHome,
  restoreHomeEnv,
  saveHomeEnv,
  withTempHome,
} from "./temp-home.js";
export { MOCK_API_ORIGIN, type MockGripHooks, type StderrSink, gripPool, mockGrip, stderrSink } from "./mock-grip.js";
export {
  type FakeTerminal,
  type FakeTerminalOptions,
  type OutputStream,
  type Terminal,
  fakeTerminal,
} from "./terminal.js";
export { type RunCliIo, type RunCliResult, runCli } from "./cli-harness.js";
export { type CapturedOutput, captureProcessOutput } from "./capture-output.js";
export { MCP_TEST_CLIENT, type McpLink, linkMcp } from "./mcp-harness.js";
export {
  type SpawnMcpStdioOptions,
  type StdioLink,
  repositoryRoot,
  spawnMcpStdio,
  umbrellaBinary,
} from "./stdio-harness.js";
export { GO_MESSAGE, READY_MESSAGE, type Worker, barrier, forkWorker, killAtIntercept } from "./child.js";
export * from "./envelopes/index.js";
