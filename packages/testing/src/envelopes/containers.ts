// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { failure, success200 } from "./envelope.js";
import type { GripReply } from "./reply.js";

export interface ConfigLookupOptions {
  /**
   * The container's slug. The builder reuses it as `name`; the page records `name` only as "The container name"
   * (`WSAI26` beside the slug `wsai26`), so the equality is a fixture convenience, not a platform fact.
   */
  slug: string;
  /**
   * `container.general.container_id`, the looked-up container's own id, where given: a live run of 2026-10-13 recorded
   * it for the live edition and absent for the ended one (`docs/api/containers.md` § Fields of a 200 answer, through #6).
   */
  containerId?: number;
  displayName?: string;
  /** `1` while the edition is live, `0` once it has ended. */
  active?: 0 | 1;
  applicationName?: string;
  applicationId?: number;
  /** The per-event application token: from `fixtureSecrets()`. */
  applicationToken: string;
  /**
   * The `grip_cdp_token` beside the application token, where given: a further credential under `application.general`,
   * recorded by a live run of 2026-10-13 (issue #5, its Redaction section, through #6) and never typed by the client. A per-run
   * synthetic value, never a real one.
   */
  gripCdpToken?: string;
  /** Kept as sent; `{}` by default. The page records no key of `type_permissions`. */
  typePermissions?: unknown;
  /** Further keys merged into `data`, for tests of unknown-field handling. */
  extra?: Record<string, unknown>;
}

/**
 * docs/api/containers.md § Config by slug and § Fields of a 200 answer: the 200 answer to
 * `GET config?container_name=<slug>`. Field names from the page; every value synthetic.
 */
export function configLookup200(options: ConfigLookupOptions): GripReply {
  return success200({
    container: {
      general: {
        ...(options.containerId === undefined ? {} : { container_id: options.containerId }),
        display_name: options.displayName ?? "Test Event 1",
        name: options.slug,
        active: options.active ?? 1,
      },
    },
    application: {
      general: {
        application_name: options.applicationName ?? "Example Org 1",
        application_id: options.applicationId ?? 1,
        token: options.applicationToken,
        ...(options.gripCdpToken === undefined ? {} : { grip_cdp_token: options.gripCdpToken }),
      },
      permissions: { type_permissions: options.typePermissions ?? {} },
    },
    ...options.extra,
  });
}

/** docs/api/containers.md § Answers: 404 with `data` `No results found for this container name`. */
export function configLookup404(): GripReply {
  return failure("No results found for this container name", 404);
}

/**
 * docs/api/containers.md § What a session cannot see: `GET container/<id>` of an ended container or another
 * application's container answers 404 `container not found`.
 */
export function containerNotFound404(): GripReply {
  return failure("container not found", 404);
}

export interface ContainerEntry {
  id: number;
  name: string;
  format: string;
  has_joined: boolean;
  branch_url: string;
}

/**
 * docs/api/containers.md § Containers a session sees (`GET container`): the active containers of the token's
 * application. `format: "event"` is a fixture value: the page records `format` only for another container, as
 * `engagement_hub`.
 */
export function containerList200(
  entries: ContainerEntry[] = [
    { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
  ],
): GripReply {
  return success200(entries);
}
