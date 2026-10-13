// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { failure, success200 } from "./envelope.js";
import type { GripReply } from "./reply.js";

export interface ConfigLookupOptions {
  /** The container's slug, also its `name`. */
  slug: string;
  displayName?: string;
  /** `1` while the edition is live, `0` once it has ended. */
  active?: 0 | 1;
  applicationName?: string;
  applicationId?: number;
  /** The per-event application token: from `fixtureSecrets()`. */
  applicationToken: string;
  /** Kept as sent; `{}` by default. */
  typePermissions?: unknown;
}

/**
 * docs/api/containers.md § Config by slug and § Fields of a 200 answer: the 200 answer to
 * `GET config?container_name=<slug>`. Field names from the page; every value synthetic.
 */
export function configLookup200(options: ConfigLookupOptions): GripReply {
  return success200({
    container: {
      general: { display_name: options.displayName ?? "Test Event 1", name: options.slug, active: options.active ?? 1 },
    },
    application: {
      general: {
        application_name: options.applicationName ?? "Example Org 1",
        application_id: options.applicationId ?? 1,
        token: options.applicationToken,
      },
      permissions: { type_permissions: options.typePermissions ?? {} },
    },
  });
}

/** docs/api/containers.md § Answers: 404 with `data` `No results found for this container name`. */
export function configLookup404(): GripReply {
  return failure("No results found for this container name", 404);
}

export interface ContainerEntry {
  id: number;
  name: string;
  format: string;
  has_joined: boolean;
  branch_url: string;
}

/** docs/api/containers.md § Containers a session sees (`GET container`): the active containers of the token's application. */
export function containerList200(
  entries: ContainerEntry[] = [
    { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
  ],
): GripReply {
  return success200(entries);
}
