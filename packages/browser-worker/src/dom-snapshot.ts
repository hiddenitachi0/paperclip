/**
 * DUR-4078: builds the `AccessibilitySnapshot`/`ElementDescriptor` shapes
 * `@paperclipai/adapter-utils/browser-tools` expects, from a real page. There
 * is no public Playwright API that hands back a ref-annotated accessibility
 * tree directly (the old `page.accessibility.snapshot()` API is gone from
 * this Playwright version, and `locator.ariaSnapshot()` has no stable ref
 * scheme we can rely on across calls), so this builds one: a single
 * self-contained in-page function (`inPageRun`, passed to `frame.evaluate`)
 * walks the DOM, tags each interactive element it finds with a
 * `data-pc-ref="eN"` attribute, and returns a compact indented text tree plus
 * the raw field signals (autocomplete/name/id/type/placeholder/label) for
 * each one.
 *
 * Deliberately does NOT decide "is this a payment field" in-page -- that
 * would duplicate the security-relevant regex list in
 * `@paperclipai/adapter-utils/payment-detection.ts`. Instead this module
 * hands the raw signals back to Node and calls the real, already-tested
 * `looksLikePaymentField` here to compute `formHasPaymentField`, so there is
 * exactly one place in the whole codebase that decides that question.
 *
 * Runs once per frame (`page.frames()`), so a same-origin (or cross-origin --
 * Playwright's CDP-based evaluate is not subject to same-origin JS
 * restrictions) iframe's content is included in the tree and can be
 * interacted with, exactly like the top document.
 */

import { looksLikePaymentField, type PaymentFieldSignals } from "@paperclipai/adapter-utils/payment-detection";
import type { Frame, Locator, Page } from "playwright-core";
import type { AccessibilitySnapshot, ElementDescriptor } from "@paperclipai/adapter-utils/browser-tools";

/** Set on every element this module tags, cleared and reassigned on every fresh snapshot. */
const REF_ATTRIBUTE = "data-pc-ref";

/** ~30 KB cap per the design -- the tree is untrusted page content the caller hands to a model with a limited context budget. */
export const SNAPSHOT_TREE_BYTE_CAP = 30_000;

interface InPageFieldSignals {
  autocomplete: string | null;
  name: string | null;
  id: string | null;
  type: string | null;
  placeholder: string | null;
  label: string | null;
}

interface InPageElementInfo extends InPageFieldSignals {
  ref: string;
  role: string;
  isFormSubmit: boolean;
  formFieldSignals: InPageFieldSignals[];
}

type InPageRunArgs =
  | { kind: "snapshot"; startIndex: number; refAttribute: string }
  | { kind: "describe"; ref: string; refAttribute: string }
  | { kind: "focusedSubmitTarget"; startIndex: number; refAttribute: string };

type InPageRunResult =
  | { kind: "snapshot"; tree: string; elements: InPageElementInfo[]; nextIndex: number }
  | { kind: "describe"; element: InPageElementInfo | null }
  | { kind: "focusedSubmitTarget"; element: InPageElementInfo | null; nextIndex: number };

/**
 * The one function that ever runs inside a page (via `frame.evaluate`).
 * Fully self-contained on purpose: Playwright serializes this by calling
 * `.toString()` on it, so it must not close over anything from the outer
 * module scope -- only its own parameter and whatever the DOM itself exposes.
 */
function inPageRun(args: InPageRunArgs): InPageRunResult {
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "svg"]);
  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary"]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "textbox",
    "combobox",
    "switch",
    "tab",
    "menuitem",
    "slider",
  ]);

  function isVisible(el: Element): boolean {
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && style.position !== "fixed") return false;
    return true;
  }

  function labelFor(el: Element): string | null {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter((text) => text.length > 0);
      if (parts.length) return parts.join(" ");
    }
    const id = el.getAttribute("id");
    if (id) {
      const labelEl = document.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
      const text = labelEl?.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
      const text = clone.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return null;
  }

  function fieldSignals(el: Element): InPageFieldSignals {
    return {
      autocomplete: el.getAttribute("autocomplete"),
      name: el.getAttribute("name"),
      id: el.getAttribute("id"),
      type: el.getAttribute("type"),
      placeholder: el.getAttribute("placeholder"),
      label: labelFor(el),
    };
  }

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return null;
  }

  function accessibleName(el: Element, role: string): string {
    if (role === "textbox" || role === "combobox") {
      return labelFor(el) || el.getAttribute("placeholder") || el.getAttribute("name") || "";
    }
    if (role === "checkbox" || role === "radio") {
      return labelFor(el) || el.getAttribute("value") || el.getAttribute("name") || "";
    }
    const text = el.textContent?.replace(/\s+/g, " ").trim();
    if (text) return text;
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;
    const value = el.getAttribute("value");
    if (value) return value;
    return "";
  }

  function isFormSubmit(el: Element): boolean {
    const form = el.closest("form");
    if (!form) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return (el.getAttribute("type") || "").toLowerCase() === "submit";
    if (tag === "button") return (el.getAttribute("type") || "submit").toLowerCase() === "submit";
    return false;
  }

  function formFieldsOf(el: Element): InPageFieldSignals[] {
    const form = el.closest("form");
    if (!form) return [];
    return Array.from(form.querySelectorAll("input,select,textarea")).map((f) => fieldSignals(f));
  }

  function isInteractive(el: Element): boolean {
    const role = el.getAttribute("role");
    if (role) return INTERACTIVE_ROLES.has(role);
    return INTERACTIVE_TAGS.has(el.tagName.toLowerCase());
  }

  function describe(el: Element, ref: string): InPageElementInfo {
    const role = roleOf(el) ?? "generic";
    return {
      ref,
      role,
      ...fieldSignals(el),
      isFormSubmit: isFormSubmit(el),
      formFieldSignals: formFieldsOf(el),
    };
  }

  if (args.kind === "describe") {
    const el = document.querySelector(`[${args.refAttribute}="${args.ref}"]`);
    return { kind: "describe", element: el ? describe(el, args.ref) : null };
  }

  if (args.kind === "focusedSubmitTarget") {
    const active = document.activeElement;
    if (!active || active === document.body) return { kind: "focusedSubmitTarget", element: null, nextIndex: args.startIndex };
    const form = active.closest("form");
    if (!form) return { kind: "focusedSubmitTarget", element: null, nextIndex: args.startIndex };
    const submit = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]');
    if (!submit || !isVisible(submit)) return { kind: "focusedSubmitTarget", element: null, nextIndex: args.startIndex };
    const existingRef = submit.getAttribute(args.refAttribute);
    const ref = existingRef ?? `e${args.startIndex}`;
    if (!existingRef) submit.setAttribute(args.refAttribute, ref);
    return {
      kind: "focusedSubmitTarget",
      element: describe(submit, ref),
      nextIndex: existingRef ? args.startIndex : args.startIndex + 1,
    };
  }

  // kind === "snapshot"
  document.querySelectorAll(`[${args.refAttribute}]`).forEach((el) => el.removeAttribute(args.refAttribute));
  let counter = args.startIndex;
  const elements: InPageElementInfo[] = [];
  const lines: string[] = [];

  function walk(node: Node, depth: number): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (text) lines.push(`${"  ".repeat(depth)}${text}`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (!isVisible(el)) return;

    if (isInteractive(el)) {
      const role = roleOf(el);
      if (!role) return;
      const ref = `e${counter++}`;
      el.setAttribute(args.refAttribute, ref);
      const info = describe(el, ref);
      elements.push(info);
      const name = accessibleName(el, role).replace(/"/g, "'");
      lines.push(`${"  ".repeat(depth)}[ref=${ref}] ${role} "${name}"`);
      return;
    }

    for (const child of Array.from(el.childNodes)) walk(child, depth + 1);
  }

  walk(document.body, 0);
  return { kind: "snapshot", tree: lines.join("\n"), elements, nextIndex: counter };
}

/**
 * Owns the ref numbering across frames and remembers which frame each ref
 * belongs to (needed since `performClick`/`performType`/etc. take only a
 * bare ref string -- this is the only place that knows which frame to
 * resolve it against). Re-created (or `reset()`) on every fresh snapshot;
 * stale refs from before a navigate/snapshot resolve to nothing, matching
 * `BrowserToolHandler`'s "take a fresh browser_snapshot" contract.
 */
export class DomSnapshotter {
  private refToFrame = new Map<string, Frame>();

  reset(): void {
    this.refToFrame.clear();
  }

  private toDescriptor(info: InPageElementInfo): ElementDescriptor {
    const formHasPaymentField = info.formFieldSignals.some((f) => looksLikePaymentField(f as PaymentFieldSignals));
    return {
      ref: info.ref,
      role: info.role,
      autocomplete: info.autocomplete,
      name: info.name,
      id: info.id,
      type: info.type,
      placeholder: info.placeholder,
      label: info.label,
      isFormSubmit: info.isFormSubmit,
      formHasPaymentField,
    };
  }

  async capture(page: Page): Promise<AccessibilitySnapshot> {
    this.reset();
    let nextIndex = 0;
    const treeParts: string[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      let result: InPageRunResult;
      try {
        result = await frame.evaluate(inPageRun, { kind: "snapshot", startIndex: nextIndex, refAttribute: REF_ATTRIBUTE } as const);
      } catch {
        // A cross-origin frame mid-navigation (or already gone) can throw;
        // skip it rather than fail the whole snapshot over one frame.
        continue;
      }
      if (result.kind !== "snapshot") continue;
      for (const info of result.elements) this.refToFrame.set(info.ref, frame);
      nextIndex = result.nextIndex;
      if (result.tree) treeParts.push(result.tree);
    }
    const tree = capTreeSize(treeParts.join("\n"));
    return { tree, url: page.url(), title: await page.title() };
  }

  async describeElement(ref: string): Promise<ElementDescriptor | null> {
    const frame = this.refToFrame.get(ref);
    if (!frame || frame.isDetached()) return null;
    const result = await frame.evaluate(inPageRun, { kind: "describe", ref, refAttribute: REF_ATTRIBUTE } as const);
    if (result.kind !== "describe" || !result.element) return null;
    return this.toDescriptor(result.element);
  }

  async focusedFormSubmitTarget(page: Page): Promise<ElementDescriptor | null> {
    let nextIndex = Math.max(0, ...[...this.refToFrame.keys()].map((r) => Number(r.slice(1)) + 1), 0);
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      let result: InPageRunResult;
      try {
        result = await frame.evaluate(inPageRun, { kind: "focusedSubmitTarget", startIndex: nextIndex, refAttribute: REF_ATTRIBUTE } as const);
      } catch {
        continue;
      }
      if (result.kind !== "focusedSubmitTarget") continue;
      nextIndex = result.nextIndex;
      if (result.element) {
        this.refToFrame.set(result.element.ref, frame);
        return this.toDescriptor(result.element);
      }
    }
    return null;
  }

  /** Resolves a ref (from the last snapshot/describe call) to a Locator scoped to its frame, or null if the ref is stale. */
  locatorFor(ref: string): Locator | null {
    const frame = this.refToFrame.get(ref);
    if (!frame || frame.isDetached()) return null;
    return frame.locator(`[${REF_ATTRIBUTE}="${ref}"]`);
  }

  /** Every currently-tagged ref whose own field signals look like a payment field -- used to mask screenshots. Cheap to recompute: it just re-describes already-known refs. */
  async paymentFieldRefs(): Promise<string[]> {
    const refs: string[] = [];
    for (const ref of this.refToFrame.keys()) {
      const descriptor = await this.describeElement(ref);
      if (descriptor && looksLikePaymentField(descriptor)) refs.push(ref);
    }
    return refs;
  }
}

function capTreeSize(tree: string): string {
  if (Buffer.byteLength(tree, "utf8") <= SNAPSHOT_TREE_BYTE_CAP) return tree;
  let truncated = tree;
  while (Buffer.byteLength(truncated, "utf8") > SNAPSHOT_TREE_BYTE_CAP) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return `${truncated}\n… (truncated; page had more content than fits in one snapshot)`;
}

/** `browser_read_text`: the same tree, with the `[ref=...] role` markup stripped down to just the quoted text/label. */
export function treeToPlainText(tree: string): string {
  return tree
    .split("\n")
    .map((line) => {
      const match = /^\s*\[ref=\S+\]\s+\S+\s+"(.*)"$/.exec(line);
      return match ? match[1].trim() : line.trim();
    })
    .filter((line) => line.length > 0)
    .join("\n");
}
