// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Self-tests for `scripts/check-oracles.ts`. Every case builds a temporary repository root holding
 * fake oracle files, a fake ledger and a fake vitest JSON result. No oracle file is run here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectFailureMessages,
  grade,
  isSubjectMissingMessage,
  listOracleFilesOnDisk,
  parseLedger,
  type FileGrade,
  type VitestFileResult,
  type VitestJsonResult,
} from "../check-oracles.js";

const FILE_A = "packages/core/src/__tests__/alpha.oracle.test.ts";
const FILE_B = "packages/core/src/__tests__/beta.oracle.test.ts";
const FILE_C = "packages/cli/src/__tests__/gamma.oracle.test.ts";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "check-oracles-test-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Creates an empty fake oracle file at a repository-relative path under the temporary root. */
function touch(file: string): void {
  const absolute = join(repoRoot, ...file.split("/"));
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, "", "utf8");
}

function subjectMissing(file: string): VitestFileResult {
  return {
    name: join(repoRoot, ...file.split("/")),
    status: "failed",
    message: "oracle subject missing: packages/core/src/lib/subject.ts",
    assertionResults: [],
  };
}

function passing(file: string): VitestFileResult {
  return {
    name: join(repoRoot, ...file.split("/")),
    status: "passed",
    message: "",
    assertionResults: [{ status: "passed", failureMessages: [] }],
  };
}

function failingCase(file: string, message = "AssertionError: expected 1 to be 2"): VitestFileResult {
  return {
    name: join(repoRoot, ...file.split("/")),
    status: "failed",
    message: "",
    assertionResults: [
      { status: "passed", failureMessages: [] },
      { status: "failed", failureMessages: [`${message}\n    at Object.<anonymous> (${file}:10:5)`] },
    ],
  };
}

function ledgerOf(...files: string[]): string[] {
  return parseLedger(["# header comment", "", ...files].join("\n"));
}

function result(...files: VitestFileResult[]): VitestJsonResult {
  return { testResults: files };
}

function failures(grades: FileGrade[]): FileGrade[] {
  return grades.filter((g) => !g.ok);
}

describe("parseLedger", () => {
  it("drops comments and blank lines, trims paths and removes duplicates", () => {
    const text = `# Oracle files whose subjects are not built yet.\n\n  ${FILE_A}  \n${FILE_B}\n${FILE_A}\n`;
    expect(parseLedger(text)).toEqual([FILE_A, FILE_B]);
  });
});

describe("isSubjectMissingMessage", () => {
  it("accepts the bare probe message and the message behind an Error prefix", () => {
    expect(isSubjectMissingMessage("oracle subject missing: packages/core/src/x.ts")).toBe(true);
    expect(isSubjectMissingMessage("Error: oracle subject missing: a, b\n    at file.ts:1:1")).toBe(true);
  });

  it("rejects any other failure", () => {
    expect(isSubjectMissingMessage("AssertionError: expected 1 to be 2")).toBe(false);
    expect(isSubjectMissingMessage("TypeError: oracle subject missing is not a function")).toBe(false);
    expect(isSubjectMissingMessage("")).toBe(false);
  });
});

describe("collectFailureMessages", () => {
  it("returns the collection error and every failed case's messages", () => {
    const collection = collectFailureMessages(subjectMissing(FILE_A));
    expect(collection).toEqual(["oracle subject missing: packages/core/src/lib/subject.ts"]);
    const cases = collectFailureMessages(failingCase(FILE_A));
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatch(/^AssertionError/u);
    expect(collectFailureMessages(passing(FILE_A))).toEqual([]);
  });

  it("records a failed file that carries no message so it never reads as a subject-missing failure", () => {
    const silent: VitestFileResult = { name: join(repoRoot, FILE_A), status: "failed", assertionResults: [] };
    expect(collectFailureMessages(silent)).toEqual(["(failed without a message)"]);
  });
});

describe("grade", () => {
  it("passes when every listed file fails only because its subject is missing", () => {
    touch(FILE_A);
    touch(FILE_B);
    const grades = grade(repoRoot, ledgerOf(FILE_A, FILE_B), result(subjectMissing(FILE_A), subjectMissing(FILE_B)));
    expect(grades.map((g) => [g.file, g.state, g.ok])).toEqual([
      [FILE_A, "pending, subject missing", true],
      [FILE_B, "pending, subject missing", true],
    ]);
  });

  it("passes an unlisted file whose cases pass", () => {
    touch(FILE_A);
    touch(FILE_B);
    const grades = grade(repoRoot, ledgerOf(FILE_B), result(passing(FILE_A), subjectMissing(FILE_B)));
    expect(failures(grades)).toEqual([]);
    expect(grades.find((g) => g.file === FILE_A)?.state).toBe("passing");
  });

  it("fails an unlisted file that fails", () => {
    touch(FILE_A);
    touch(FILE_B);
    const grades = grade(repoRoot, ledgerOf(FILE_B), result(failingCase(FILE_A), subjectMissing(FILE_B)));
    expect(failures(grades).map((g) => g.file)).toEqual([FILE_A]);
    expect(failures(grades)[0]?.state).toBe("failing");
  });

  it("fails an unlisted file whose subject is missing and names the ledger", () => {
    touch(FILE_A);
    const grades = grade(repoRoot, ledgerOf(), result(subjectMissing(FILE_A)));
    expect(failures(grades).map((g) => [g.file, g.state])).toEqual([
      [FILE_A, "subject missing and not listed in oracles.pending"],
    ]);
  });

  it("fails a listed file whose cases pass and names it", () => {
    touch(FILE_A);
    touch(FILE_B);
    const grades = grade(repoRoot, ledgerOf(FILE_A, FILE_B), result(passing(FILE_A), subjectMissing(FILE_B)));
    const failed = failures(grades);
    expect(failed.map((g) => g.file)).toEqual([FILE_A]);
    expect(failed[0]?.state).toBe("listed in oracles.pending but its cases pass: remove it from the ledger");
  });

  it("fails a listed file that fails for another reason", () => {
    touch(FILE_A);
    const grades = grade(repoRoot, ledgerOf(FILE_A), result(failingCase(FILE_A)));
    expect(failures(grades).map((g) => [g.file, g.state])).toEqual([
      [FILE_A, "listed in oracles.pending but fails for another reason"],
    ]);
  });

  it("fails a listed file whose subject is missing and whose other cases also fail", () => {
    touch(FILE_A);
    const mixed = failingCase(FILE_A);
    mixed.message = "oracle subject missing: packages/core/src/lib/subject.ts";
    const grades = grade(repoRoot, ledgerOf(FILE_A), result(mixed));
    expect(failures(grades).map((g) => g.state)).toEqual(["listed in oracles.pending but fails for another reason"]);
  });

  it("fails a ledger line naming a file that does not exist", () => {
    touch(FILE_A);
    const grades = grade(repoRoot, ledgerOf(FILE_A, FILE_C), result(subjectMissing(FILE_A)));
    expect(failures(grades).map((g) => [g.file, g.state])).toEqual([
      [FILE_C, "listed in oracles.pending but does not exist"],
    ]);
  });

  it("fails a listed file that exists but the strict run did not report", () => {
    touch(FILE_A);
    touch(FILE_B);
    const grades = grade(repoRoot, ledgerOf(FILE_A, FILE_B), result(subjectMissing(FILE_A)));
    expect(failures(grades).map((g) => [g.file, g.state])).toEqual([
      [FILE_B, "listed in oracles.pending but the strict run did not report it"],
    ]);
  });

  it("fails an oracle file on disk that is neither listed nor reported", () => {
    touch(FILE_A);
    touch(FILE_C);
    const grades = grade(repoRoot, ledgerOf(FILE_A), result(subjectMissing(FILE_A)));
    expect(failures(grades).map((g) => [g.file, g.state])).toEqual([
      [FILE_C, "on disk but the strict run did not report it"],
    ]);
  });

  it("sorts the report by file and keeps one line per file", () => {
    touch(FILE_A);
    touch(FILE_B);
    touch(FILE_C);
    const grades = grade(
      repoRoot,
      ledgerOf(FILE_B, FILE_A, FILE_C),
      result(subjectMissing(FILE_B), subjectMissing(FILE_C), subjectMissing(FILE_A)),
    );
    expect(grades.map((g) => g.file)).toEqual([FILE_C, FILE_A, FILE_B]);
  });
});

describe("listOracleFilesOnDisk", () => {
  it("finds oracle files under each package's src and skips dist and node_modules", () => {
    touch(FILE_A);
    touch(FILE_C);
    touch("packages/core/src/__tests__/unit.test.ts");
    touch("packages/core/dist/__tests__/built.oracle.test.ts");
    touch("packages/core/src/node_modules/dep/x.oracle.test.ts");
    touch("packages/e2e/README.md");
    expect(listOracleFilesOnDisk(repoRoot)).toEqual([FILE_C, FILE_A]);
  });

  it("returns nothing when there is no packages directory", () => {
    expect(listOracleFilesOnDisk(repoRoot)).toEqual([]);
  });
});
