import { beforeEach, describe, expect, it } from "vitest";
import { resolveBrowserMcpServerEntry, _resetBrowserMcpEntryCacheForTests } from "./browser-mcp-entry.js";

describe("resolveBrowserMcpServerEntry", () => {
  beforeEach(() => {
    _resetBrowserMcpEntryCacheForTests();
  });

  it("adds nothing when browserAccess is off (the default)", () => {
    expect(resolveBrowserMcpServerEntry({ browserAccess: "off" })).toBeNull();
  });

  it("adds nothing when browserAccess is unset", () => {
    expect(resolveBrowserMcpServerEntry({})).toBeNull();
  });

  it("adds a stdio entry pointed at the browser MCP server's built entrypoint when the switch is on", () => {
    const entry = resolveBrowserMcpServerEntry({ browserAccess: "browse_and_forms" });
    expect(entry).toMatchObject({ name: "paperclip-browser", transport: "stdio", command: "node" });
    expect(Array.isArray(entry?.args)).toBe(true);
    expect(String((entry?.args as string[])[0])).toMatch(/browser-stdio\.js$/);
  });

  it("also offers the tool at book_and_buy (this phase only serves browse-and-forms tools regardless of level)", () => {
    expect(resolveBrowserMcpServerEntry({ browserAccess: "book_and_buy" })).not.toBeNull();
  });
});
