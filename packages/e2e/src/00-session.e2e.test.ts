// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 00-session (issue #18 § The nine files, item 1): the session the maintainer signed in is there, the
 * config file is private, and the local `writes status` read names the loaded path. Nothing is sent.
 */

import { stat } from "node:fs/promises";

import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, checkedCall, openLive } from "./lib/live-check.js";
import { drift, isPositiveInteger } from "./lib/outcome.js";

const FILE = "00-session";

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 00-session: the signed-in session", () => {
  it("finds a session with a positive container id and a non-empty slug, and prints neither", (ctx) => {
    const { session } = fixture.ready(ctx);
    const problems: string[] = [];
    if (!isPositiveInteger(session.containerId)) problems.push("container_id");
    if (session.slug === "") problems.push("slug");
    if (problems.length > 0) drift(`the stored session's ${problems.join(", ")} is not as documented`);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the config file at mode 600, octal (POSIX only: skipped on Windows, where the profile's access control list applies)",
    async (ctx) => {
      const { session } = fixture.ready(ctx);
      const mode = (await stat(session.configPath)).mode & 0o777;
      if (mode !== 0o600) drift(`the config file mode is ${mode.toString(8)}, not 600`);
    },
  );

  it("answers writes status with the loaded config path: a local read, no request", async (ctx) => {
    const { session, server } = fixture.ready(ctx);
    const { call, content } = await checkedCall(ctx, FILE, server, "gripeventsctl_writes_status", {}, [
      "writes_enabled",
      "send_log",
      "go_aheads_pending",
      "config_path",
    ]);
    if (call.calls.length > 0) drift("writes status sent a request; it reads local state only");
    if (content["config_path"] !== session.configPath) drift("config_path differs from the loaded config path");
    if (content["writes_enabled"] !== session.writesEnabled) drift("writes_enabled differs from the loaded config");
    if (content["send_log"] !== session.sendLogPath) drift("send_log differs from the path derived from the config");
  });
});
