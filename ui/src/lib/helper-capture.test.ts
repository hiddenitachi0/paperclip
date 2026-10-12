// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_CONTEXT_MAX_CHARS } from "@paperclipai/shared";
import { captureHelperContext, rectFromPoints } from "./helper-capture";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

/** jsdom has no layout: give elements a box by their data-box="left,top,width,height". */
function layout(root: Element) {
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    const own = el.getAttribute("data-box");
    const boxed = own ? el : el.closest("[data-box]");
    const [left, top, width, height] = (boxed?.getAttribute("data-box") ?? "0,0,0,0").split(",").map(Number);
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("captureHelperContext", () => {
  it("collects headings, labels, help text and field values with the page header", () => {
    const root = mount(`
      <section data-helper-entity="agent:abc-1">
        <h2>Quick agent</h2>
        <p>Tell the quick agent who it is.</p>
        <label for="ins">Instructions</label>
        <textarea id="ins">You are the front desk.</textarea>
        <label>Model <select><option value="a">Small</option><option value="b" selected>Large</option></select></label>
        <label><input type="checkbox" checked /> Can search the web</label>
        <button aria-label="Save">Save</button>
      </section>`);
    const result = captureHelperContext({ root, route: "/ACM/agents/x/configuration", pageTitle: "Front desk", companyName: "Acme" });
    expect(result.text).toContain("Page title: Front desk");
    expect(result.text).toContain("Page address: /ACM/agents/x/configuration");
    expect(result.text).toContain("Company: Acme");
    expect(result.text).toContain("## Quick agent");
    expect(result.text).toContain("Tell the quick agent who it is.");
    expect(result.text).toContain("[Field] Instructions: You are the front desk.");
    expect(result.text).toContain("[Choice] Model: Large");
    expect(result.text).toContain("[Checkbox] Can search the web: on");
    expect(result.entities).toEqual(["agent:abc-1"]);
    expect(result.text).toContain("Records: agent:abc-1");
  });

  it("never captures passwords, private subtrees, secret-named fields or the helper's own UI, and masks key-shaped text", () => {
    const root = mount(`
      <div>
        <label for="pw">Password</label><input id="pw" type="password" value="hunter2-very-secret" />
        <input autocomplete="current-password" aria-label="Login" value="also-secret-1" />
        <input aria-label="API key" value="plainvalue" />
        <div data-helper-private><span>Secret picker shows MY_SECRET_NAME</span><select><option selected>OpenRouter key</option></select></div>
        <div data-helper-ignore>Helper panel text</div>
        <p>Token in text: sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123</p>
        <input aria-label="Note" value="password: Tr0ub4dor&3xyz" />
        <p>Record 3f2a1b4c-1111-4222-8333-444455556666 stays</p>
      </div>`);
    const result = captureHelperContext({ root });
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("also-secret-1");
    expect(result.text).not.toContain("plainvalue");
    expect(result.text).toContain("[Field] API key: [hidden]");
    expect(result.text).not.toContain("MY_SECRET_NAME");
    expect(result.text).not.toContain("OpenRouter key");
    expect(result.text).not.toContain("Helper panel text");
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(result.text).not.toContain("Tr0ub4dor");
    expect(result.text).toContain("3f2a1b4c-1111-4222-8333-444455556666");
  });

  it("keeps only what overlaps the marked rectangle, and lists opted-in fields inside it", () => {
    const root = mount(`
      <div data-box="0,0,1000,1000">
        <div data-box="0,0,500,100" data-helper-entity="approval:ap-1"><p data-box="0,0,500,40">Deploy the shop</p></div>
        <div data-box="0,600,500,100"><p data-box="0,600,500,40">Far away text</p>
          <div data-helper-apply="Quick agent instructions" data-box="0,650,500,40"><textarea aria-label="Instructions" data-box="0,650,500,40">x</textarea></div>
        </div>
      </div>`);
    layout(root);
    const top = captureHelperContext({ root, rect: rectFromPoints(10, 10, 200, 50) });
    expect(top.text).toContain("Deploy the shop");
    expect(top.text).not.toContain("Far away text");
    expect(top.entities).toEqual(["approval:ap-1"]);
    expect(top.applyTargets).toEqual([]);

    const bottom = captureHelperContext({ root, rect: rectFromPoints(10, 640, 300, 700) });
    expect(bottom.text).not.toContain("Deploy the shop");
    expect(bottom.applyTargets).toEqual(["Quick agent instructions"]);
    expect(bottom.text).toContain("[Field] Instructions: x");
  });

  it("caps the text", () => {
    const root = mount(`<p>${"word ".repeat(10_000)}</p>`);
    const result = captureHelperContext({ root });
    expect(result.text.length).toBeLessThanOrEqual(HELPER_CONTEXT_MAX_CHARS);
    expect(result.truncated).toBe(true);
    expect(captureHelperContext({ root, maxChars: 500 }).text.length).toBeLessThanOrEqual(500);
  });

  it("normalises a drag in any direction", () => {
    expect(rectFromPoints(100, 80, 20, 10)).toEqual({ left: 20, top: 10, width: 80, height: 70 });
  });
});
