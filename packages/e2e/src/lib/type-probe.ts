// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The type probe of `20-attendees` (issue #18 § The nine files, item 4): which type id the one page is
 * read for. `GRIPEVENTSCTL_E2E_TYPE_ID` names it outright and skips the probe. Otherwise the file reads
 * `type_permissions` from `gripeventsctl_events_check` and probes the integer ids it finds there, at
 * most `TYPE_PROBE_BOUND`, one single-type search each, `TYPE_PROBE_PACE_MS` apart on the system clock,
 * stopping at the first result that is not an error. The pace is the dump's page pause
 * (`PAGE_PAUSE_MS` in core's `operations/attendees/dump.ts`).
 *
 * `docs/api/containers.md` records no key of `type_permissions`; until `10-events`' run records them,
 * `collectTypeIds()` takes every integer-valued field named `id`, `type_id` or `thing_type_id`, and
 * every all-digit key of a mapping, at any depth, in document order, each once.
 */

export const TYPE_PROBE_BOUND = 8;
export const TYPE_PROBE_PACE_MS = 1_500;
export const TYPE_ID_ENV = "GRIPEVENTSCTL_E2E_TYPE_ID";

const ID_KEYS = new Set(["id", "type_id", "thing_type_id"]);
const ALL_DIGITS = /^[1-9]\d*$/u;

function collectInto(value: unknown, found: number[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectInto(entry, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (ALL_DIGITS.test(key)) found.push(Number(key));
    if (ID_KEYS.has(key) && typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) found.push(entry);
    collectInto(entry, found);
  }
}

/** The candidate type ids of a `type_permissions` value, in document order, each once. */
export function collectTypeIds(typePermissions: unknown): number[] {
  const found: number[] = [];
  collectInto(typePermissions, found);
  return [...new Set(found)];
}

/** The type id `GRIPEVENTSCTL_E2E_TYPE_ID` names: `undefined` where unset, `null` where it is not a positive integer. */
export function configuredTypeId(env: NodeJS.ProcessEnv = process.env): number | null | undefined {
  const value = env[TYPE_ID_ENV];
  if (value === undefined || value === "") return undefined;
  return ALL_DIGITS.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
