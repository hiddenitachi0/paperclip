// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { _buildPluginModuleBlobUrlForTests as buildBlobUrl } from "./slots";

/**
 * A plugin UI module is imported from a blob: URL, which cannot resolve
 * "./edit-tab.js" by itself. Media Studio's menu link and page silently fell
 * back to a dead placeholder on 2 Oct 2026 because of that. The loader now
 * loads relative imports itself and points them at their own blob URLs.
 */

const BASE = "https://paperclip.test/_plugins/p1/ui/";

function stubNetwork(files: Record<string, string>) {
  const blobs = new Map<string, Blob>();
  let n = 0;
  const fetchMock = vi.fn(async (url: string) => {
    const body = files[url];
    return body === undefined
      ? { ok: false, status: 404, statusText: "Not Found", text: async () => "" }
      : { ok: true, status: 200, statusText: "OK", text: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:test/${++n}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  return { fetchMock, read: (url: string) => blobs.get(url)!.text() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("plugin UI loader: relative imports", () => {
  it("loads a file imported by relative path and points the import at it", async () => {
    const { read } = stubNetwork({
      [`${BASE}index.js`]: 'import { jsx } from "react/jsx-runtime";\nimport { EditTab } from "./edit-tab.js";\nexport function SidebarLink() { return jsx("a", {}); }\n',
      [`${BASE}edit-tab.js`]: 'import { useState } from "react";\nexport function EditTab() { return null; }\n',
    });

    const entry = await buildBlobUrl(`${BASE}index.js`, new Map(), new Set(), []);
    const entrySource = await read(entry);
    const childUrl = /from "(blob:test\/\d+)";\nexport function SidebarLink/.exec(entrySource)?.[1];

    expect(childUrl).toBeTruthy();
    expect(entrySource).not.toContain("./edit-tab.js");
    expect(entrySource).not.toContain('"react/jsx-runtime"');
    const childSource = await read(childUrl!);
    expect(childSource).toContain("export function EditTab");
    expect(childSource).not.toContain('from "react"');
  });

  it("fetches a file imported by two others only once, and resolves ../ paths", async () => {
    const { fetchMock } = stubNetwork({
      [`${BASE}index.js`]: 'import "./a.js";\nimport { b } from "./sub/b.js";\n',
      [`${BASE}a.js`]: 'export { shared } from "./shared.js";\n',
      [`${BASE}sub/b.js`]: 'import { shared } from "../shared.js";\nexport const b = shared;\n',
      [`${BASE}shared.js`]: "export const shared = 1;\n",
    });

    await buildBlobUrl(`${BASE}index.js`, new Map(), new Set(), []);

    const fetched = fetchMock.mock.calls.map(([url]) => url);
    expect(fetched.filter((url) => url === `${BASE}shared.js`)).toHaveLength(1);
    expect(fetched).toContain(`${BASE}sub/b.js`);
  });

  it("refuses files that import each other in a loop instead of hanging", async () => {
    stubNetwork({
      [`${BASE}index.js`]: 'import "./a.js";\n',
      [`${BASE}a.js`]: 'import "./index.js";\n',
    });

    await expect(buildBlobUrl(`${BASE}index.js`, new Map(), new Set(), [])).rejects.toThrow(/loop/);
  });

  it("leaves a module without relative imports exactly as before (bare specifiers only)", async () => {
    const { read, fetchMock } = stubNetwork({
      [`${BASE}index.js`]: 'import { useState } from "react";\nexport const x = 1;\n',
    });

    const entry = await buildBlobUrl(`${BASE}index.js`, new Map(), new Set(), []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await read(entry)).toContain("export const x = 1;");
  });
});
