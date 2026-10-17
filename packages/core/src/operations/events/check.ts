// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `events check <slug>` (issue #10 § `events check <slug>`): the config lookup by slug, with no session
 * (`docs/api/containers.md` § Config by slug). The output is an explicit projection of the 200 answer: whether the
 * slug is known, the display name (falling back to the container name when the display name is empty), the container
 * name, the active flag as a boolean, the application name, the container id (`data.container.general.container_id`,
 * the field the page names for the looked-up container's own id; a live run of 2026-10-13 recorded the key present for
 * a live edition and absent for an ended one, and whether its value is the looked-up container's rather than the
 * application's default is listed as not verified on `docs/api/not-verified.md` § Containers; `null` where the answer
 * carries no such key; `default_container_id` is never read, because it names the application's default event) and
 * the type set (`data.application.permissions.type_permissions`, kept as the API sends it: no page records its keys
 * yet).
 * The per-event application token in the answer is not a field of the output schema, so no output form carries it;
 * the transport registers it as a secret the moment it is parsed, the redaction backstop behind the projection.
 *
 * The documented 404 (`unknown-slug`) is an outcome, not an error: `slug_found: false` with every other field `null`
 * and exit code 0. Only that error class is caught; every other kind propagates with the transport's exit code. The
 * slug is sent exactly as given: the platform's lookup is case-insensitive, and a slug may be published in mixed case.
 *
 * The human form is the operation's own (`render.human`): the key-value block in output order, with `null` written
 * out and the type set as compact JSON, or, for an unknown slug, the one line `slug_found: false` followed by the
 * sentence that says only this slug is unknown. The output never says the event is not on Grip: it may run under
 * another slug.
 */

import { z } from "zod";

import type { ConfigLookup } from "../../transport/envelope.js";
import { UnknownSlugError } from "../../transport/errors.js";
import { WEB_APP_ORIGIN } from "../../transport/headers.js";
import { defineOperation } from "../operation.js";

export const eventsCheckInput = z.object({ slug: z.string().min(1) });

export const eventsCheckOutput = z.object({
  slug_found: z.boolean(),
  /** `data.container.general.display_name`, falling back to `data.container.general.name` when empty. */
  display_name: z.string().nullable(),
  /** `data.container.general.name`. */
  name: z.string().nullable(),
  /** `data.container.general.active`, `1` as `true` and `0` as `false`. */
  active: z.boolean().nullable(),
  /** `data.application.general.application_name`. */
  application_name: z.string().nullable(),
  /** `data.container.general.container_id`, the field the page names for the container's own id, where the answer carries it. */
  container_id: z.number().int().nullable(),
  /** `data.application.permissions.type_permissions`, as the API sends it. */
  type_permissions: z.unknown().nullable(),
});

export type EventsCheckOutput = z.infer<typeof eventsCheckOutput>;

/** The output keys in the order the human form prints them: the schema's own. */
export const EVENTS_CHECK_KEYS = Object.keys(eventsCheckOutput.shape) as readonly (keyof EventsCheckOutput)[];

/** What the human form says after `slug_found: false`: the slug is unknown, the event may still run under another. */
export const UNKNOWN_SLUG_SENTENCE = `only this slug is unknown; a slug is the last part of the event's web address ${WEB_APP_ORIGIN}/<slug>`;

/** The output of a documented 404: the slug is unknown, every other field `null`. */
export const UNKNOWN_SLUG_OUTPUT: Readonly<EventsCheckOutput> = Object.freeze({
  slug_found: false,
  display_name: null,
  name: null,
  active: null,
  application_name: null,
  container_id: null,
  type_permissions: null,
});

/** The projection of a 200 answer (`docs/api/containers.md` § Fields of a 200 answer). */
export function projectConfigLookup(answer: ConfigLookup): EventsCheckOutput {
  const general = answer.container.general;
  return {
    slug_found: true,
    display_name: general.display_name === "" ? general.name : general.display_name,
    name: general.name,
    active: general.active === 1,
    application_name: answer.application.general.application_name,
    container_id: general.container_id ?? null,
    type_permissions: answer.application.permissions?.type_permissions ?? null,
  };
}

/**
 * One value of the human form: `null` written out, a string as it is, a number or a boolean as its digits or word, and
 * `type_permissions` as compact JSON whatever its shape, a string included, so the type set reads as the API sent it.
 */
function humanValue(key: keyof EventsCheckOutput, value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (key === "type_permissions") return JSON.stringify(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * The human form: the key-value block in output order, the type set last as compact JSON until its keys are
 * recorded; or, for an unknown slug, one line and the sentence.
 */
export function renderEventsCheck(output: EventsCheckOutput): string {
  if (!output.slug_found) return `slug_found: false\n${UNKNOWN_SLUG_SENTENCE}`;
  return EVENTS_CHECK_KEYS.map((key) => `${key}: ${humanValue(key, output[key])}`).join("\n");
}

export const eventsCheck = defineOperation({
  group: "events",
  verb: "check",
  kind: "read",
  description: "Check whether an event slug runs on Grip and show its type set",
  needsSession: false,
  input: eventsCheckInput,
  output: eventsCheckOutput,
  requests: [
    { method: "GET", pathTemplate: "config?container_name=<slug>", page: "containers.md", section: "Config by slug" },
  ],
  cli: { positional: ["slug"] },
  render: { human: renderEventsCheck },
  async run(ctx, input): Promise<EventsCheckOutput> {
    try {
      return projectConfigLookup(await ctx.client.lookupConfig(input.slug));
    } catch (error: unknown) {
      if (error instanceof UnknownSlugError) return { ...UNKNOWN_SLUG_OUTPUT };
      throw error;
    }
  },
});
