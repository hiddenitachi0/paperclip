import { describe, expect, it } from "vitest";
import {
  formatTimeAgo,
  modelOptionStatus,
  modelReadiness,
  modelReadinessSummary,
  type ModelReadinessLine,
} from "./model-readiness.js";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const LOCAL = "http://office-pc:11434/v1";

function line(lines: ModelReadinessLine[], id: string): ModelReadinessLine {
  const found = lines.find((l) => l.id === id);
  if (!found) throw new Error(`no line ${id}: ${lines.map((l) => l.id).join(", ")}`);
  return found;
}

describe("formatTimeAgo", () => {
  it("says it in plain words", () => {
    expect(formatTimeAgo(minutesAgo(0), NOW)).toBe("just now");
    expect(formatTimeAgo(minutesAgo(1), NOW)).toBe("1 minute ago");
    expect(formatTimeAgo(minutesAgo(90), NOW)).toBe("2 hours ago");
    expect(formatTimeAgo(minutesAgo(60 * 72), NOW)).toBe("3 days ago");
    expect(formatTimeAgo(null, NOW)).toBe("never");
  });
});

describe("modelOptionStatus: local models", () => {
  const setup = { provider: "local", model: "qwen3:14b", baseUrl: LOCAL };

  it("Installed from a fresh health reading", () => {
    const s = modelOptionStatus(setup, { now: NOW, health: { status: "ready", lastCheckedAt: minutesAgo(5) } });
    expect(s).toMatchObject({ kind: "installed", label: "Installed", tone: "ok" });
    expect(s.detail).toBe("Installed on the model server (last checked 5 minutes ago).");
  });

  it("says when the reading is over an hour old", () => {
    const s = modelOptionStatus(setup, { now: NOW, health: { status: "ready", lastCheckedAt: minutesAgo(180) } });
    expect(s.detail).toMatch(/last checked 3 hours ago/);
  });

  it("Not installed, with the install command when known", () => {
    const s = modelOptionStatus(
      { ...setup, specs: { pullCommand: "ollama pull qwen3:14b" } },
      { now: NOW, health: { status: "model_missing", lastCheckedAt: minutesAgo(2) } },
    );
    expect(s).toMatchObject({ kind: "not_installed", label: "Not installed", tone: "fail" });
    expect(s.detail).toMatch(/ollama pull qwen3:14b/);
  });

  it("Offline when the server was last seen unreachable", () => {
    const s = modelOptionStatus(setup, { now: NOW, health: { status: "unreachable", lastCheckedAt: minutesAgo(10) } });
    expect(s).toMatchObject({ kind: "offline", label: "Offline", tone: "fail" });
    expect(s.detail).toMatch(/could not be reached \(last checked 10 minutes ago\)/);
  });

  it("Downloading wins over a not-installed reading", () => {
    const s = modelOptionStatus({ ...setup, availability: "downloading" }, { now: NOW, health: { status: "model_missing", lastCheckedAt: minutesAgo(1) } });
    expect(s.kind).toBe("downloading");
  });

  it("falls back to the saved availability, then Unknown", () => {
    expect(modelOptionStatus({ ...setup, availability: "installed" }, { now: NOW }).kind).toBe("installed");
    expect(modelOptionStatus({ ...setup, availability: "planned" }, { now: NOW }).kind).toBe("not_installed");
    expect(modelOptionStatus(setup, { now: NOW })).toMatchObject({ kind: "unknown", label: "Unknown" });
  });

  it("uses the company's model server address when the setup has none, and is broken without any", () => {
    expect(modelOptionStatus({ ...setup, baseUrl: null }, { now: NOW, companyLocalBaseUrl: LOCAL }).kind).toBe("unknown");
    expect(modelOptionStatus({ ...setup, baseUrl: null }, { now: NOW })).toMatchObject({ kind: "broken", label: "Can't run" });
  });

  it("archived setups say so", () => {
    expect(modelOptionStatus({ ...setup, archived: true }, { now: NOW }).label).toBe("Archived");
  });
});

describe("modelOptionStatus: hosted models and this agent's keys", () => {
  const or = { provider: "openrouter", model: "qwen/qwen3-14b" };
  it("Key set / Needs a key / wrong address", () => {
    expect(modelOptionStatus(or, { key: "set" })).toMatchObject({ kind: "key_set", label: "Key set" });
    expect(modelOptionStatus(or, { key: "missing" })).toMatchObject({ kind: "needs_key", label: "Needs a key", tone: "fail" });
    expect(modelOptionStatus(or, { key: "wrong_address" }).detail).toMatch(/different address/);
  });
  it("Claude on Paperclip's key, or nothing", () => {
    const claude = { provider: "anthropic", model: "claude-sonnet-5" };
    expect(modelOptionStatus(claude, { key: "paperclip" }).label).toBe("Paperclip's key");
    expect(modelOptionStatus(claude, { key: "paperclip_missing" }).label).toBe("Needs a key");
  });
  it("a model id the provider does not offer cannot run", () => {
    expect(modelOptionStatus({ provider: "anthropic", model: "gpt-9" }, { key: "set" }).kind).toBe("broken");
  });
  it("without an agent it says each agent needs its own key", () => {
    expect(modelOptionStatus(or, {}).detail).toMatch(/Each agent that uses it needs its own OpenRouter key/);
  });
});

describe("modelReadiness: local checklist", () => {
  const base = { provider: "local", model: "qwen3:14b", baseUrl: LOCAL, lane: "quick" as const, temperature: 0.4 };

  it("a well set up local model is all green apart from the real check", () => {
    const lines = modelReadiness(base, { now: NOW, gpuVramGb: 16, health: { status: "ready", lastCheckedAt: minutesAgo(3) } });
    expect(lines.map((l) => l.id)).toEqual(["installed", "address", "gpu", "context", "tools", "lane", "thinking", "temperature", "last_check"]);
    expect(lines.filter((l) => l.status !== "ok").map((l) => l.id)).toEqual(["last_check"]);
    expect(line(lines, "context").reason).toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it("flags graphics card fit, missing memory setting and an address with no server", () => {
    expect(line(modelReadiness(base, { now: NOW, gpuVramGb: 6 }), "gpu").status).toBe("fail");
    expect(line(modelReadiness(base, { now: NOW, gpuVramGb: 11 }), "gpu").status).toBe("warn");
    const unset = line(modelReadiness(base, { now: NOW }), "gpu");
    expect(unset).toMatchObject({ status: "unknown", fix: { label: "Set your graphics card memory" } });
    const noAddress = line(modelReadiness({ ...base, baseUrl: null }, { now: NOW }), "address");
    expect(noAddress).toMatchObject({ status: "fail", fix: { label: "Set the model server address" } });
  });

  it("reachability: offline fails, an old reading warns, none is unknown", () => {
    expect(line(modelReadiness(base, { now: NOW, health: { status: "unreachable", lastCheckedAt: minutesAgo(5) } }), "address").status).toBe("fail");
    expect(line(modelReadiness(base, { now: NOW, health: { status: "ready", lastCheckedAt: minutesAgo(300) } }), "address").status).toBe("warn");
    expect(line(modelReadiness(base, { now: NOW }), "address").status).toBe("unknown");
  });

  it("thinking: off on an always-thinking model, on for a model that cannot think", () => {
    const r1 = modelReadiness({ ...base, model: "deepseek-r1:8b", thinking: "off" }, { now: NOW });
    expect(line(r1, "thinking")).toMatchObject({ status: "warn", reason: expect.stringMatching(/always thinks/) });
    expect(line(r1, "tools").status).toBe("fail");
    const llama = modelReadiness({ ...base, model: "llama3.2:3b", thinking: "on" }, { now: NOW });
    expect(line(llama, "thinking").reason).toMatch(/cannot think/);
    expect(line(llama, "tools").status).toBe("warn");
  });

  it("creativity unset is amber for a local model", () => {
    expect(line(modelReadiness({ ...base, temperature: null }, { now: NOW }), "temperature").status).toBe("warn");
  });

  it("vision only shows when the agent's tools need pictures in", () => {
    expect(modelReadiness(base, { now: NOW }).some((l) => l.id === "vision")).toBe(false);
    expect(line(modelReadiness(base, { now: NOW, needsVision: true }), "vision").status).toBe("warn");
  });

  it("a real check result overrides what is known about tools", () => {
    const lines = modelReadiness(base, { now: NOW, lastCheck: { ok: false, checkedAt: minutesAgo(1), toolCalling: "not_supported" } });
    expect(line(lines, "tools").status).toBe("fail");
    expect(line(lines, "last_check")).toMatchObject({ status: "fail", reason: expect.stringMatching(/^Failed 1 minute ago/) });
  });

  it("a short context fails", () => {
    expect(line(modelReadiness({ ...base, model: "tiny", specs: { contextTokens: 4096 } }, { now: NOW }), "context").status).toBe("fail");
  });
});

describe("modelReadiness: OpenRouter checklist", () => {
  const base = { provider: "openrouter", model: "qwen/qwen3-14b", lane: "both" as const };

  it("key, model, hosts, price from what Paperclip knows", () => {
    const lines = modelReadiness(base, { key: "set", now: NOW });
    expect(line(lines, "key").status).toBe("ok");
    expect(line(lines, "address").reason).toMatch(/OpenRouter's own address/);
    expect(line(lines, "exists").status).toBe("ok");
    expect(line(lines, "tool_hosts").status).toBe("ok");
    expect(line(lines, "price").reason).toBe("About $0.12 in / $0.24 out per million tokens.");
  });

  it("missing key fails with a fix link", () => {
    expect(line(modelReadiness(base, { key: "missing" }), "key")).toMatchObject({ status: "fail", fix: { href: "/company/settings/connections" } });
  });

  it("company blocked hosts can leave no host at all", () => {
    const lines = modelReadiness(base, { key: "set", blockedHosts: ["deepinfra", "alibaba"] });
    expect(line(lines, "hosts_left").status).toBe("fail");
    expect(line(lines, "tool_hosts").status).toBe("fail");
  });

  it("live hosts: no allowed host with tools fails; the cheapest allowed host gives the price", () => {
    const hosts = [
      { slug: "a", supportsTools: false, priceInPerM: 0.1, priceOutPerM: 0.2, supportsReasoning: false },
      { slug: "b", supportsTools: true, priceInPerM: 0.5, priceOutPerM: 1, supportsReasoning: false },
    ];
    const pinned = modelReadiness({ ...base, providerRouting: { only: ["a"] }, thinking: "off" }, { key: "set", openrouterHosts: hosts });
    expect(line(pinned, "tool_hosts").status).toBe("fail");
    expect(line(pinned, "price").reason).toMatch(/\$0\.10 in/);
    expect(line(pinned, "thinking")).toMatchObject({ status: "warn", reason: expect.stringMatching(/None of the allowed hosts/) });
    expect(line(modelReadiness(base, { key: "set", openrouterHosts: [] }), "exists").status).toBe("fail");
  });

  it("an unknown model with no host data is unknown, not failed", () => {
    const lines = modelReadiness({ provider: "openrouter", model: "someone/new-model" }, { key: "set" });
    expect(line(lines, "exists").status).toBe("unknown");
    expect(line(lines, "price").status).toBe("unknown");
  });

  it("a fixed-catalogue provider shows its price and that the model is known", () => {
    const lines = modelReadiness({ provider: "anthropic", model: "claude-haiku-4-5" }, { key: "paperclip" });
    expect(line(lines, "exists").status).toBe("ok");
    expect(line(lines, "price").reason).toBe("About $1.00 in / $5.00 out per million tokens.");
  });
});

describe("modelReadinessSummary", () => {
  it("the worst line wins", () => {
    expect(modelReadinessSummary([{ id: "a", status: "ok", label: "", reason: "" }, { id: "b", status: "fail", label: "", reason: "" }])).toEqual({ status: "fail", label: "Not ready (1 to fix)" });
    expect(modelReadinessSummary([{ id: "a", status: "ok", label: "", reason: "" }, { id: "b", status: "warn", label: "", reason: "" }]).status).toBe("warn");
    expect(modelReadinessSummary([{ id: "a", status: "ok", label: "", reason: "" }, { id: "b", status: "unknown", label: "", reason: "" }])).toEqual({ status: "ok", label: "Ready" });
    expect(modelReadinessSummary([{ id: "b", status: "unknown", label: "", reason: "" }]).label).toBe("Not checked");
  });
});
