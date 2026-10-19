// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `liveServer()`: the real MCP server (`buildServer()` from `@gripeventsctl/mcp`) over a recording
 * dispatcher, linked with `linkMcp()` from `@gripeventsctl/testing`. The server loads the config per
 * call exactly as a host's server would, so the suite drives the product path: the real registry, the
 * real builders, the real gate, the real client. A file calls tools with `link.callTool(name, args)`
 * and reads `structuredContent`; an `isError` result carries `structuredContent.error.kind`.
 */

import { buildServer } from "@gripeventsctl/mcp";
import { type McpLink, linkMcp } from "@gripeventsctl/testing";

import { type Recorder, recordingDispatcher } from "./recorder.js";

export interface LiveServer {
  link: McpLink;
  recorder: Recorder;
  close(): Promise<void>;
}

export async function liveServer(opts: { recorder?: Recorder } = {}): Promise<LiveServer> {
  const recorder = opts.recorder ?? recordingDispatcher();
  const link = await linkMcp(buildServer(undefined, { dispatcher: recorder.dispatcher }));
  return {
    link,
    recorder,
    close: async () => {
      await link.close();
      await recorder.close();
    },
  };
}
