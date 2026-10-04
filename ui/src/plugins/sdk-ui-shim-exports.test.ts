// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { describe, expect, it } from "vitest";
import { initPluginBridge } from "./bridge-init";

// Plugin UI modules import from "@paperclipai/plugin-sdk/ui", which the host
// rewrites to a generated shim module (slots.tsx, getShimBlobUrl "sdk-ui").
// A name the bridge provides but the shim does not export makes every plugin
// module that imports it fail to link, so the whole plugin page renders only
// its "Plugin: Slot" placeholder. That broke Media Studio on 3 Oct 2026 when
// PluginConfigForm was added to the bridge but not to the shim.
const here = dirname(fileURLToPath(import.meta.url));

function shimExports(): Set<string> {
  const source = readFileSync(join(here, "slots.tsx"), "utf8");
  const shim = source.slice(source.indexOf('case "sdk-ui":'));
  const start = shim.indexOf("export {") + "export {".length;
  const list = shim.slice(start, shim.indexOf("}", start));
  return new Set(list.split(",").map((name) => name.trim()).filter(Boolean));
}

describe("plugin sdk-ui shim", () => {
  it("exports every name the host bridge provides to plugin UI modules", () => {
    initPluginBridge(React, ReactDOM);
    const provided = Object.keys(globalThis.__paperclipPluginBridge__!.sdkUi);
    expect(provided).toContain("PluginConfigForm");
    const exported = shimExports();
    expect(provided.filter((name) => !exported.has(name))).toEqual([]);
  });
});
