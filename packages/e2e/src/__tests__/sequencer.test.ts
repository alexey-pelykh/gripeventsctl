// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";

import { PathSequencer, sortByPath } from "../lib/sequencer.js";

const GIVEN = ["70-mcp-stdio", "05-auth-probe", "20-attendees", "00-session", "60-write"];
const SORTED = ["00-session", "05-auth-probe", "20-attendees", "60-write", "70-mcp-stdio"];

function specification(stem: string): TestSpecification {
  return { moduleId: `/repo/packages/e2e/src/${stem}.e2e.test.ts` } as unknown as TestSpecification;
}

function stems(specifications: readonly TestSpecification[]): string[] {
  return specifications.map((spec) => spec.moduleId.split("/").at(-1)?.replace(".e2e.test.ts", "") ?? "");
}

describe("[CAP-E2E] PathSequencer", () => {
  it("sorts the specifications by moduleId, by code units, whatever order they came in", async () => {
    const sequencer = new PathSequencer({} as Vitest);
    expect(stems(await sequencer.sort(GIVEN.map(specification)))).toEqual(SORTED);
    expect(stems(await sequencer.sort(SORTED.map(specification)))).toEqual(SORTED);
  });

  it("leaves the given array as it was and keeps the inherited shard()", async () => {
    const given = GIVEN.map(specification);
    await new PathSequencer({} as Vitest).sort(given);
    expect(stems(given)).toEqual(GIVEN);
    expect(Object.hasOwn(PathSequencer.prototype, "shard")).toBe(false);
    expect(typeof new PathSequencer({} as Vitest).shard).toBe("function");
  });

  it("compares code units, not locale order", () => {
    const sorted = sortByPath([{ moduleId: "b" }, { moduleId: "B" }, { moduleId: "a" }, { moduleId: "10" }]);
    expect(sorted.map((spec) => spec.moduleId)).toEqual(["10", "B", "a", "b"]);
  });
});
