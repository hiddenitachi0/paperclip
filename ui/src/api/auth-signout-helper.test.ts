// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "./auth";
import { instanceSecurityApi } from "./instanceSecurity";

/** Signing out must not leave one person's Ask conversations for the next person on the tab. */
describe("sign-out clears the Ask panel's saved conversations", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  function seed() {
    window.sessionStorage.setItem("paperclip.helper.session.v1:u1:c1", JSON.stringify({ turns: [{ role: "user", content: "q" }] }));
    window.sessionStorage.setItem("paperclip.helper.session.v1:u1:c2", "{}");
    window.sessionStorage.setItem("paperclip.helper.open.v1", "1");
    window.sessionStorage.setItem("other", "kept");
  }

  it("on Sign out (every menu uses authApi.signOut), even if the server call fails", async () => {
    seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await authApi.signOut().catch(() => undefined);
    expect(Object.keys(window.sessionStorage)).toEqual(["other"]);
  });

  it("on Sign out everywhere", async () => {
    seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revoked: 1 }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await instanceSecurityApi.signOutEverywhere("me");
    expect(Object.keys(window.sessionStorage)).toEqual(["other"]);
  });
});
