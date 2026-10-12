import { HELPER_CONTEXT_MAX_CHARS, HELPER_MASK, capHelperText, maskSecretLikeText } from "@paperclipai/shared";

/**
 * "Ask Paperclip": turn a marked area of the page into STRUCTURED TEXT the
 * helper can read. No pixels are ever taken.
 *
 * What is collected, in page order, from elements that overlap the marked
 * rectangle (or the whole root when no rectangle is given): headings, visible
 * text (labels, help texts, card text), form fields as "label: value"
 * (select → chosen option, checkbox → on/off), plus the record ids of
 * `data-helper-entity="<type>:<id>"` containers around what was marked and
 * the `data-helper-apply` fields inside it.
 *
 * Never collected: password inputs (and anything autocomplete marks as a
 * password), fields whose name/label says key/token/secret/password, any
 * subtree marked `data-helper-private` (the secret pickers carry it), the
 * helper's own UI (`data-helper-ignore`), hidden subtrees, scripts and
 * styles. Everything else is passed through maskSecretLikeText, and the
 * whole is capped at HELPER_CONTEXT_MAX_CHARS.
 */

export interface HelperRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HelperCaptureInput {
  /** Where to look. Defaults to document.body. */
  root?: Element | null;
  /** The marked area in viewport coordinates; null/absent = everything under root. */
  rect?: HelperRect | null;
  route?: string | null;
  pageTitle?: string | null;
  companyName?: string | null;
  maxChars?: number;
}

export interface HelperCapture {
  text: string;
  truncated: boolean;
  /** `<type>:<id>` of the records around/inside the marked area. */
  entities: string[];
  /** Labels of opted-in text fields inside the marked area (`data-helper-apply`). */
  applyTargets: string[];
  /** How many lines of page content were collected (0 = nothing found in the area). */
  itemCount: number;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "VIDEO", "AUDIO", "IMG"]);
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const SECRET_FIELD_RE = /(pass(word|wd|ord)?\b|\bpwd\b|secret|token|api[-_ ]?key|private[-_ ]?key|credential|\bcvc\b|\bcvv\b|card[-_ ]?number)/i;
const BLOCK_SELECTOR = "p,li,td,th,dt,dd,label,legend,summary,h1,h2,h3,h4,h5,h6,button,a,option,div,section,article,header,footer,span";

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function intersects(el: Element, rect: HelperRect): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return r.left < rect.left + rect.width && r.left + r.width > rect.left && r.top < rect.top + rect.height && r.top + r.height > rect.top;
}

/** True when this element (not its ancestors) must never be read. */
function isExcludedElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.hasAttribute("data-helper-private") || el.hasAttribute("data-helper-ignore")) return true;
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") return true;
  }
  return false;
}

function labelTextFor(el: HTMLElement): string {
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => clean(el.ownerDocument.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const id = el.getAttribute("id");
  if (id) {
    const forLabel = Array.from(el.ownerDocument.getElementsByTagName("label")).find((l) => l.htmlFor === id);
    const text = clean(forLabel?.textContent);
    if (text) return text;
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as Element;
    clone.querySelectorAll("input,textarea,select").forEach((n) => n.remove());
    const text = clean(clone.textContent);
    if (text) return text;
  }
  return clean(el.getAttribute("placeholder")) || clean(el.getAttribute("name")) || clean(id) || "field";
}

function isSecretField(el: HTMLElement, label: string): boolean {
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (autocomplete.includes("password") || autocomplete.startsWith("cc-")) return true;
  return [label, el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("data-testid")].some(
    (v) => typeof v === "string" && SECRET_FIELD_RE.test(v),
  );
}

function describeField(el: HTMLElement): string | null {
  const label = labelTextFor(el);
  if (isSecretField(el, label)) return `[Field] ${label}: ${HELPER_MASK}`;
  if (el instanceof HTMLSelectElement) {
    const chosen = Array.from(el.selectedOptions ?? []).map((o) => clean(o.textContent)).filter(Boolean);
    return `[Choice] ${label}: ${chosen.length ? chosen.join(", ") : "(nothing chosen)"}`;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    return `[${el.type === "checkbox" ? "Checkbox" : "Option"}] ${label}: ${el.checked ? "on" : "off"}`;
  }
  const value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
  const shown = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  return `[Field] ${label}: ${shown.trim() ? shown : "(empty)"}`;
}

/** Captures the structured text the helper will see. Pure DOM reads; changes nothing. */
export function captureHelperContext(input: HelperCaptureInput = {}): HelperCapture {
  const doc = typeof document !== "undefined" ? document : null;
  const root = input.root ?? doc?.body ?? null;
  const header: string[] = [];
  if (input.pageTitle) header.push(`Page title: ${clean(input.pageTitle)}`);
  if (input.route) header.push(`Page address: ${input.route}`);
  if (input.companyName) header.push(`Company: ${clean(input.companyName)}`);
  header.push(input.rect ? "Area: the part of the page the person marked" : "Area: the visible page");

  const lines: string[] = [];
  const entities = new Set<string>();
  const applyTargets = new Set<string>();
  const rect = input.rect ?? null;

  if (root) {
    let pendingKey: Element | null = null;
    let pendingText: string[] = [];
    const flush = () => {
      if (pendingText.length > 0 && pendingKey) {
        const text = clean(pendingText.join(" "));
        if (text) {
          const heading = /^H[1-6]$/.test(pendingKey.tagName) ? "## " : "";
          const line = `${heading}${text}`;
          if (lines[lines.length - 1] !== line) lines.push(line);
        }
      }
      pendingKey = null;
      pendingText = [];
    };
    const noteEntity = (el: Element) => {
      const owner = el.closest("[data-helper-entity]");
      const value = owner?.getAttribute("data-helper-entity");
      if (value) entities.add(clean(value));
    };

    const visit = (el: Element) => {
      if (isExcludedElement(el)) return;
      if (rect && !intersects(el, rect) && el !== root) {
        // A child may still overlap even when the parent box does not (e.g.
        // a zero-height wrapper), so only skip leaf-ish elements here.
        if (el.children.length === 0) return;
      }
      if (FIELD_TAGS.has(el.tagName)) {
        flush();
        const line = describeField(el as HTMLElement);
        if (line) lines.push(maskSecretLikeText(line));
        noteEntity(el);
        const apply = el.closest("[data-helper-apply]")?.getAttribute("data-helper-apply");
        if (apply) applyTargets.add(apply);
        return;
      }
      const apply = el.getAttribute("data-helper-apply");
      if (apply && (!rect || intersects(el, rect))) applyTargets.add(apply);
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3 /* text */) {
          const text = clean(child.textContent);
          if (!text) continue;
          if (rect && !intersects(el, rect)) continue;
          const key = el.closest(BLOCK_SELECTOR) ?? el;
          if (key !== pendingKey) flush();
          pendingKey = key;
          pendingText.push(maskSecretLikeText(text));
          noteEntity(el);
        } else if (child.nodeType === 1) {
          const childEl = child as Element;
          const isBlock = childEl.matches(BLOCK_SELECTOR) && childEl.tagName !== "SPAN" && childEl.tagName !== "A";
          if (isBlock) flush();
          visit(childEl);
          if (isBlock) flush();
        }
      }
    };
    visit(root);
    flush();
    if (entities.size === 0 && rect) {
      // Nothing inside carried an id: use the record around the marked area's middle, if any.
      const probe = doc?.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const owner = probe?.closest?.("[data-helper-entity]")?.getAttribute("data-helper-entity");
      if (owner) entities.add(clean(owner));
    }
  }

  const parts = [...header];
  if (entities.size > 0) parts.push(`Records: ${[...entities].join(", ")}`);
  parts.push("", lines.length > 0 ? lines.join("\n") : "(Nothing readable was found in this area.)");
  const capped = capHelperText(parts.join("\n"), input.maxChars ?? HELPER_CONTEXT_MAX_CHARS);
  return {
    text: capped.text,
    truncated: capped.truncated,
    entities: [...entities],
    applyTargets: [...applyTargets],
    itemCount: lines.length,
  };
}

/** The viewport as a rect (the default area when nothing is marked). */
export function viewportRect(): HelperRect {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/** Normalises a drag from (x1,y1) to (x2,y2) into a rect. */
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): HelperRect {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
