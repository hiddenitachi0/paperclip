import { beforeEach, describe, expect, it } from "vitest";
import { resolveBrowserMcpServerEntry, _resetBrowserMcpEntryCacheForTests } from "./browser-mcp-entry.js";

describe("resolveBrowserMcpServerEntry", () => {
  beforeEach(() => {
    _resetBrowserMcpEntryCacheForTests();
  });

  it("adds nothing when browserAccess is off (the default)", () => {
    expect(resolveBrowserMcpServerEntry({ adapterConfig: { laneA: { browserAccess: "off" } } })).toBeNull();
  });

  it("adds nothing when browserAccess is unset", () => {
    expect(resolveBrowserMcpServerEntry({})).toBeNull();
  });

  it("adds a stdio entry pointed at the browser MCP server's built entrypoint when the switch is on", () => {
    const entry = resolveBrowserMcpServerEntry({ adapterConfig: { laneA: { browserAccess: "browse_and_forms" } } });
    expect(entry).toMatchObject({ name: "paperclip-browser", transport: "stdio", command: "node" });
    expect(Array.isArray(entry?.args)).toBe(true);
    expect(String((entry?.args as string[])[0])).toMatch(/browser-stdio\.js$/);
  });

  it("also offers the tool at book_and_buy (this phase only serves browse-and-forms tools regardless of level)", () => {
    expect(resolveBrowserMcpServerEntry({ adapterConfig: { laneA: { browserAccess: "book_and_buy" } } })).not.toBeNull();
  });

  // DUR-4070: a "limited"-trust agent must never get the browser tool
  // offered, no matter what its own browserAccess switch says.
  it("adds nothing for a limited-trust agent even at book_and_buy", () => {
    expect(
      resolveBrowserMcpServerEntry({
        adapterConfig: { laneA: { browserAccess: "book_and_buy" } },
        laneATrustLevel: "limited",
      }),
    ).toBeNull();
  });

  it("still offers the tool for standard/full trust, unchanged", () => {
    for (const trust of ["standard", "full", null, undefined] as const) {
      expect(
        resolveBrowserMcpServerEntry({
          adapterConfig: { laneA: { browserAccess: "book_and_buy" } },
          laneATrustLevel: trust,
        }),
      ).not.toBeNull();
    }
  });
});
