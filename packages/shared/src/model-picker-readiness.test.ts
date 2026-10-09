import { describe, expect, it } from "vitest";
import {
  modelPickerOptionText,
  modelPickerReadiness,
  modelServerName,
  sortByModelReadiness,
} from "./model-picker-readiness.js";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const local = { provider: "local", model: "qwen3:14b", baseUrl: "http://office-pc:11434/v1" };

describe("modelServerName", () => {
  it("names the computer from the address, never assuming one setup", () => {
    expect(modelServerName("http://office-pc:11434/v1")).toBe("office-pc");
    expect(modelServerName("http://192.168.1.20:11434")).toBe("192.168.1.20");
    expect(modelServerName("gpu-box.tailnet.ts.net:11434")).toBe("gpu-box.tailnet.ts.net");
    expect(modelServerName("http://localhost:11434")).toBe("the Paperclip server");
    expect(modelServerName("http://127.0.0.1:11434")).toBe("the Paperclip server");
    expect(modelServerName(null)).toBe("the model server");
    expect(modelServerName("   ")).toBe("the model server");
  });
});

describe("modelPickerReadiness: local models", () => {
  it("is ready when the last resync found it", () => {
    const r = modelPickerReadiness(local, { now: NOW, health: { status: "ready", lastCheckedAt: minutesAgo(5) } });
    expect(r).toMatchObject({ kind: "ready", ready: true, badge: "✅ Ready", runLabel: "Local — installed", warning: null, rank: 0 });
    expect(r.detail).toMatch(/Installed on office-pc \(checked 5 minutes ago\)/);
  });

  it("says not installed on which machine, and how to fix it", () => {
    const r = modelPickerReadiness(
      { ...local, specs: { pullCommand: "ollama pull qwen3:14b" } },
      { now: NOW, health: { status: "model_missing", lastCheckedAt: minutesAgo(10) } },
    );
    expect(r).toMatchObject({ kind: "not_installed", ready: false, badge: "⚠️ Not installed on office-pc", runLabel: "Local — not installed" });
    expect(r.warning).toMatch(/ollama pull qwen3:14b/);
    expect(r.warning).toMatch(/Refresh status on the Models page/);
  });

  it("uses the company's model server address when the saved model has none", () => {
    const r = modelPickerReadiness({ ...local, baseUrl: null, availability: "planned" }, { now: NOW, companyLocalBaseUrl: "http://studio-mac:11434" });
    expect(r.badge).toBe("⚠️ Not installed on studio-mac");
  });

  it("never checked is not the same as installed", () => {
    const r = modelPickerReadiness(local, { now: NOW });
    expect(r).toMatchObject({ kind: "never_checked", ready: false, badge: "⚠️ Never checked", runLabel: "Local — not checked yet" });
    expect(r.warning).toMatch(/Refresh status/);
  });

  it("offline and downloading", () => {
    expect(modelPickerReadiness(local, { now: NOW, health: { status: "unreachable", lastCheckedAt: minutesAgo(3) } })).toMatchObject({
      kind: "offline",
      badge: "⚠️ office-pc is offline",
    });
    expect(modelPickerReadiness({ ...local, availability: "downloading" }, { now: NOW }).kind).toBe("downloading");
  });

  it("a failed Check this setup wins over an old 'installed'", () => {
    const r = modelPickerReadiness(local, {
      now: NOW,
      health: { status: "ready", lastCheckedAt: minutesAgo(5) },
      lastCheck: { ok: false, checkedAt: minutesAgo(1), summary: "The model never called the tool." },
    });
    expect(r).toMatchObject({ kind: "check_failed", badge: "❌ Check failed", tone: "fail" });
    expect(r.warning).toMatch(/never called the tool/);
  });
});

describe("modelPickerReadiness: hosted models", () => {
  const or = { provider: "openrouter", model: "mistralai/mistral-small-3.2-24b-instruct" };
  it("depends on the key", () => {
    expect(modelPickerReadiness(or, { key: "set" })).toMatchObject({ kind: "ready", badge: "✅ Ready", runLabel: null });
    const missing = modelPickerReadiness(or, { key: "missing" });
    expect(missing).toMatchObject({ kind: "needs_key", badge: "❌ Needs a key", fix: { href: "/company/settings/connections" } });
    expect(missing.warning).toBeTruthy();
    expect(modelPickerReadiness(or, {})).toMatchObject({ kind: "key_per_use", ready: false, rank: 1 });
  });
});

describe("option text and order", () => {
  it("puts the badge first", () => {
    const r = modelPickerReadiness(local, { now: NOW, health: { status: "ready", lastCheckedAt: minutesAgo(5) } });
    expect(modelPickerOptionText("14B · Local — installed (qwen3:14b)", r)).toBe("✅ Ready · 14B · Local — installed (qwen3:14b)");
    expect(modelPickerOptionText("x", null)).toBe("x");
  });

  it("sorts ready first and keeps the order otherwise", () => {
    const items = [
      { id: "a", r: modelPickerReadiness(local, { now: NOW }) },
      { id: "b", r: modelPickerReadiness(local, { now: NOW, health: { status: "ready", lastCheckedAt: minutesAgo(1) } }) },
      { id: "c", r: modelPickerReadiness({ provider: "openrouter", model: "x/y" }, { key: "missing" }) },
      { id: "d", r: modelPickerReadiness({ provider: "openrouter", model: "x/y" }, { key: "set" }) },
    ];
    expect(sortByModelReadiness(items, (i) => i.r).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });
});
