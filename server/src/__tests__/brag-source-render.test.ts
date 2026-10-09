import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { estimateBragCostCents, isBragOverrun, updateBragSceneSchema, createBragJobSchema } from "@paperclipai/shared";
import { extractPageMaterial, fetchWebsiteMaterial, readWorkspaceMaterial } from "../services/brag-source.js";
import { buildClipArgs, buildStillArgs, wrapCardText } from "../services/brag-render.js";

describe("brag estimate + validators (DUR-4520)", () => {
  it("estimates planning only without music, and adds audio cost with music", () => {
    const base = estimateBragCostCents({ lengthSeconds: 20, music: false });
    expect(base.sceneCount).toBe(5);
    expect(base.musicCents).toBe(0);
    expect(estimateBragCostCents({ lengthSeconds: 20, music: true }).estimatedCostCents).toBeGreaterThan(base.estimatedCostCents);
  });
  it("overrun aborts strictly above 2x", () => {
    expect(isBragOverrun(100, 200)).toBe(false);
    expect(isBragOverrun(100, 201)).toBe(true);
  });
  it("requires https source and a description for edit", () => {
    expect(createBragJobSchema.safeParse({ projectId: crypto.randomUUID(), sourceUrl: "http://x.com" }).success).toBe(false);
    expect(createBragJobSchema.safeParse({ projectId: crypto.randomUUID(), sourceUrl: "https://x.com" }).success).toBe(true);
    expect(updateBragSceneSchema.safeParse({ action: "edit" }).success).toBe(false);
    expect(updateBragSceneSchema.safeParse({ action: "leave_out" }).success).toBe(true);
  });
});

describe("brag website source (DUR-4520)", () => {
  it("fetches only through the supplied guarded fetch and redacts page text", async () => {
    const html = `<html><title>Acme</title><body><script>var k="sk_live_zzzzzzzzzzzzzz"</script><h1>Ship faster with Acme</h1><p>Our API_KEY=supersecretvalue9 is shown here by mistake.</p></body></html>`;
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const m = await fetchWebsiteMaterial("https://acme.example.com/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(m.title).toBe("Acme");
    expect(m.snippets.join(" ")).toContain("Ship faster");
    expect(m.snippets.join(" ")).not.toContain("supersecretvalue9");
    expect(m.snippets.join(" ")).not.toContain("sk_live_");
  });
  it("surfaces a refusal from the guard instead of falling back to a plain fetch", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("host_not_allowed"); }) as unknown as typeof fetch;
    await expect(fetchWebsiteMaterial("https://10.0.0.1/", fetchImpl)).rejects.toThrow("host_not_allowed");
  });
  it("extracts blocks and ignores scripts", () => {
    expect(extractPageMaterial("<title>T</title><script>alert(1)</script><p>A reasonably long paragraph.</p>").snippets).toEqual(["A reasonably long paragraph."]);
  });
});

describe("brag workspace source (DUR-4520)", () => {
  it("skips .env and key files, never follows symlinks, and masks secrets in docs", async () => {
    const root = await mkdtemp(join(tmpdir(), "brag-ws-"));
    try {
      await writeFile(join(root, "README.md"), "# Acme\n\nAcme builds rockets for everyone. Set TOKEN=abcd1234efgh5678ijkl to deploy.\n");
      await writeFile(join(root, ".env"), "DB_PASSWORD=leakleakleak\n");
      await mkdir(join(root, "certs"));
      await writeFile(join(root, "certs", "server.pem"), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
      await symlink("/etc/passwd", join(root, "link.md"));
      const m = await readWorkspaceMaterial(root, "Acme");
      const all = JSON.stringify(m);
      expect(all).not.toContain("leakleakleak");
      expect(all).not.toContain("AAAA");
      expect(all).not.toContain("abcd1234efgh5678ijkl");
      expect(all).not.toContain("root:");
      expect(m.skipped).toEqual(expect.arrayContaining([".env", "certs/server.pem"]));
      expect(m.snippets[0]).toContain("rockets");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("brag render args (DUR-4520)", () => {
  it("puts card text in a file, not in the filter string", () => {
    const args = buildStillArgs({ width: 1920, height: 1080, textFile: "/tmp/x/card.txt", out: "/tmp/x/o.png" });
    expect(args.join(" ")).toContain("textfile=/tmp/x/card.txt");
  });
  it("builds a clip of the right length", () => {
    expect(buildClipArgs({ width: 1080, height: 1080, seconds: 4, still: "a.png", out: "b.mp4" })).toContain("4");
  });
  it("redacts and wraps card text", () => {
    const out = wrapCardText("Deploy with PASSWORD=hunter2hunter2 now and enjoy a very long line of copy here");
    expect(out).not.toContain("hunter2hunter2");
    expect(Math.max(...out.split("\n").map((l) => l.length))).toBeLessThanOrEqual(40);
  });
});
