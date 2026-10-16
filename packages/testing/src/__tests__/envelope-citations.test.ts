// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Every exported builder under `src/envelopes/` carries a comment naming the `docs/api/` page and
 * the section heading it mirrors, and that heading exists on that page. A citation reads
 * `docs/api/<page>.md § <Heading>`; a later `§ <Heading>` on the same line cites the same page.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../stdio-harness.js";

const ENVELOPES = fileURLToPath(new URL("../envelopes", import.meta.url));
const DOCS = join(repositoryRoot(), "docs", "api");

/** The headings of a page, without their `#` marks. */
function headingsOf(page: string): string[] {
  const text = readFileSync(join(DOCS, page), "utf8");
  return text
    .split("\n")
    .filter((line) => /^#{1,6} /u.test(line))
    .map((line) => line.replace(/^#{1,6} /u, "").trim());
}

interface Citation {
  file: string;
  line: number;
  page: string;
  /** The text after `§ `, up to the end of the line. */
  rest: string;
}

/** Every `§` citation in `text`, each bound to the nearest `docs/api/<page>` before it. */
function citationsOf(file: string, text: string): Citation[] {
  const citations: Citation[] = [];
  let page: string | undefined;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    // A heading wrapped onto the next comment line continues after its ` * ` prefix.
    const continuation = (lines[index + 1] ?? "").replace(/^\s*\*\s?/u, "");
    let offset = 0;
    for (;;) {
      const pageAt = line.indexOf("docs/api/", offset);
      const sectionAt = line.indexOf("§ ", offset);
      if (sectionAt === -1) break;
      if (pageAt !== -1 && pageAt < sectionAt) {
        const match = /docs\/api\/([\w-]+\.md)/u.exec(line.slice(pageAt));
        page = match?.[1];
        offset = pageAt + "docs/api/".length;
        continue;
      }
      if (page === undefined) throw new Error(`${file}:${String(index + 1)}: a § citation before any docs/api/ page`);
      citations.push({ file, line: index + 1, page, rest: `${line.slice(sectionAt + 2)} ${continuation}` });
      offset = sectionAt + 2;
    }
  });
  return citations;
}

/** The exported function names of a builder file, each with the comment block right above it. */
function exportedBuilders(text: string): { name: string; comment: string }[] {
  const builders: { name: string; comment: string }[] = [];
  const pattern = /(\/\*\*[\s\S]*?\*\/\s*)?^export function (\w+)\(/gmu;
  for (const match of text.matchAll(pattern)) {
    builders.push({ name: match[2] ?? "", comment: match[1] ?? "" });
  }
  return builders;
}

describe("[CAP-TEST-TOOLING] every envelope builder cites a docs/api/ page and a heading that exists", () => {
  const files = readdirSync(ENVELOPES)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .sort();

  it("finds the builder files", () => {
    expect(files).toContain("containers.ts");
    expect(files).toContain("chat-and-meetings.ts");
  });

  for (const name of files) {
    const text = readFileSync(join(ENVELOPES, name), "utf8");

    it(`${name}: every exported builder has a comment naming a docs/api/ page and section`, () => {
      const builders = exportedBuilders(text).filter(
        (builder) => !/^(?:chatThreadEntry|chatMessageEntry|scheduleEntry)$/u.test(builder.name),
      );
      expect(builders.length).toBeGreaterThan(0);
      for (const builder of builders) {
        expect(builder.comment, `${name}: ${builder.name}`).toMatch(/docs\/api\/[\w-]+\.md § /u);
      }
    });

    it(`${name}: every cited heading exists on the cited page`, () => {
      const citations = citationsOf(name, text);
      expect(citations.length).toBeGreaterThan(0);
      const missing: string[] = [];
      for (const citation of citations) {
        const headings = headingsOf(citation.page);
        if (!headings.some((heading) => citation.rest.startsWith(heading))) {
          missing.push(`${citation.file}:${String(citation.line)}: ${citation.page} § ${citation.rest}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
