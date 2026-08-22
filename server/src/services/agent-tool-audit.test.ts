import { describe, expect, it } from "vitest";
import { describeToolCapability, diffMcpServers, listMcpServers, summarizeMcpServer } from "./agent-tool-audit.js";

describe("summarizeMcpServer", () => {
  it("summarizes a command-based (stdio) server", () => {
    expect(summarizeMcpServer({ name: "shell", command: "bash", args: ["-c", "whoami"] })).toEqual({
      name: "shell",
      kind: "command",
      target: "bash",
    });
  });

  it("summarizes a url-based server", () => {
    expect(summarizeMcpServer({ name: "search", url: "https://search.example.com/mcp" })).toEqual({
      name: "search",
      kind: "web_address",
      target: "https://search.example.com/mcp",
    });
  });

  it("returns null for entries with no name", () => {
    expect(summarizeMcpServer({ command: "bash" })).toBeNull();
    expect(summarizeMcpServer(null)).toBeNull();
    expect(summarizeMcpServer("nope")).toBeNull();
  });
});

describe("listMcpServers / diffMcpServers", () => {
  it("lists every named server on an adapterConfig", () => {
    const adapterConfig = {
      mcpServers: [
        { name: "shell", command: "bash" },
        { name: "search", url: "https://search.example.com" },
        { command: "no-name-here" },
      ],
    };
    expect(listMcpServers(adapterConfig)).toEqual([
      { name: "shell", kind: "command", target: "bash" },
      { name: "search", kind: "web_address", target: "https://search.example.com" },
    ]);
  });

  it("returns an empty list when adapterConfig has no mcpServers", () => {
    expect(listMcpServers({})).toEqual([]);
    expect(listMcpServers(null)).toEqual([]);
  });

  it("detects an added tool connection", () => {
    const before = {};
    const after = { mcpServers: [{ name: "shell", command: "bash" }] };
    const { added, removed } = diffMcpServers(before, after);
    expect(added).toEqual([{ name: "shell", kind: "command", target: "bash" }]);
    expect(removed).toEqual([]);
  });

  it("detects a removed tool connection", () => {
    const before = { mcpServers: [{ name: "shell", command: "bash" }] };
    const after = {};
    const { added, removed } = diffMcpServers(before, after);
    expect(added).toEqual([]);
    expect(removed).toEqual([{ name: "shell", kind: "command", target: "bash" }]);
  });

  it("does not report a server as changed when it is unchanged", () => {
    const config = { mcpServers: [{ name: "shell", command: "bash" }] };
    const { added, removed } = diffMcpServers(config, config);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("detects both an addition and a removal in the same diff", () => {
    const before = { mcpServers: [{ name: "shell", command: "bash" }] };
    const after = { mcpServers: [{ name: "search", url: "https://search.example.com" }] };
    const { added, removed } = diffMcpServers(before, after);
    expect(added).toEqual([{ name: "search", kind: "web_address", target: "https://search.example.com" }]);
    expect(removed).toEqual([{ name: "shell", kind: "command", target: "bash" }]);
  });
});

describe("describeToolCapability", () => {
  it("describes a command-based tool as running on the execution box", () => {
    const text = describeToolCapability({ name: "shell", kind: "command", target: "bash -c whoami" });
    expect(text).toContain("Runs the command");
    expect(text).toContain("bash -c whoami");
    expect(text).toContain("box the agent's work executes on");
  });

  it("describes a url-based tool as reaching a web address", () => {
    const text = describeToolCapability({
      name: "search",
      kind: "web_address",
      target: "https://search.example.com/mcp",
    });
    expect(text).toContain("Connects to the web address");
    expect(text).toContain("https://search.example.com/mcp");
  });
});
