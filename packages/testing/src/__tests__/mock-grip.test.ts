// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The harness's own check (`mock-grip.ts`): an interceptor a test declares and never reaches fails that test, through
 * the after-each check `mockGrip()` registers. The hooks are captured here, so the check runs on demand.
 */

import { request } from "undici";
import { describe, expect, it } from "vitest";

import { MOCK_API_ORIGIN, type MockGripHooks, gripPool, mockGrip } from "../mock-grip.js";

describe("[CAP-TEST-TOOLING] mockGrip()", () => {
  it("registers an after-each check that throws while a declared interceptor was never reached, and passes once it was", async () => {
    let afterEachCheck: (() => void) | undefined;
    let afterAllClose: (() => Promise<void>) | undefined;
    const hooks: MockGripHooks = {
      afterEach: (check) => {
        afterEachCheck = check;
      },
      afterAll: (close) => {
        afterAllClose = close;
      },
    };
    const agent = mockGrip(hooks);
    try {
      const check = afterEachCheck;
      if (check === undefined) throw new Error("mockGrip() registered no after-each check");
      expect(check).not.toThrow();

      gripPool(agent).intercept({ path: "/1/container", method: "GET" }).reply(200, "{}");
      expect(check).toThrow(/pending/);

      const answer = await request(`${MOCK_API_ORIGIN}/1/container`, { dispatcher: agent });
      expect(await answer.body.text()).toBe("{}");
      expect(check).not.toThrow();
    } finally {
      await afterAllClose?.();
    }
  });
});
