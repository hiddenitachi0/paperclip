import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * "Ask Paperclip" → "Apply to <field>".
 *
 * A text field opts in twice: its markup carries `data-helper-apply="<label>"`
 * (so the capture knows the person marked it), and its component registers a
 * setter with useHelperApplyTarget(label, setValue). Applying calls that
 * setter, the same React state update typing would make, so nothing is
 * written into the DOM behind React's back and nothing is saved: the person
 * still presses the page's own Save.
 *
 * Add-ons (plugins) cannot import this hook. For them the fallback is an
 * event: when no setter is registered for a label, the matching
 * `[data-helper-apply="<label>"]` element receives a HELPER_APPLY_EVENT
 * CustomEvent whose detail is { label, value, handled }; the add-on's own
 * listener calls its own state setter and sets `handled = true`.
 */

export const HELPER_APPLY_EVENT = "paperclip:helper-apply";

export interface HelperApplyEventDetail {
  label: string;
  value: string;
  handled: boolean;
}

type Setter = (value: string) => void;

const registry = new Map<string, Setter[]>();
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function emit() {
  snapshot = [...registry.keys()].sort();
  for (const listener of listeners) listener();
}

/** Registers a setter for a label; returns the unregister function. The latest registration wins. */
export function registerHelperApplyTarget(label: string, setter: Setter): () => void {
  const list = registry.get(label) ?? [];
  list.push(setter);
  registry.set(label, list);
  emit();
  return () => {
    const current = registry.get(label);
    if (!current) return;
    const index = current.lastIndexOf(setter);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) registry.delete(label);
    emit();
  };
}

/** Labels that have a registered setter right now. */
export function listHelperApplyTargets(): readonly string[] {
  return snapshot;
}

/** True when `label` can receive an answer now (a registered setter, or an add-on field on the page). */
export function canApplyHelperAnswer(label: string, root: ParentNode | null = typeof document !== "undefined" ? document : null): boolean {
  if (registry.has(label)) return true;
  return Boolean(root?.querySelector(`[data-helper-apply="${cssEscape(label)}"]`));
}

/**
 * Sets the field's value. Returns true when a field took it.
 * Never touches `.value` directly.
 */
export function applyHelperAnswer(
  label: string,
  value: string,
  root: ParentNode | null = typeof document !== "undefined" ? document : null,
): boolean {
  const list = registry.get(label);
  const setter = list?.[list.length - 1];
  if (setter) {
    setter(value);
    return true;
  }
  if (!root) return false;
  const el = root.querySelector(`[data-helper-apply="${cssEscape(label)}"]`);
  if (!el) return false;
  const detail: HelperApplyEventDetail = { label, value, handled: false };
  el.dispatchEvent(new CustomEvent<HelperApplyEventDetail>(HELPER_APPLY_EVENT, { detail, bubbles: false }));
  return detail.handled;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** Test hook. */
export function resetHelperApplyRegistryForTests() {
  registry.clear();
  emit();
}

/**
 * Lets the helper fill this field. `setValue` is the field's ordinary state
 * setter. Pass `enabled: false` (e.g. read-only) to opt out.
 */
export function useHelperApplyTarget(label: string, setValue: Setter, enabled = true) {
  const ref = useRef(setValue);
  ref.current = setValue;
  useEffect(() => {
    if (!enabled) return;
    return registerHelperApplyTarget(label, (value) => ref.current(value));
  }, [label, enabled]);
}

/** The registered labels, kept current. */
export function useHelperApplyTargets(): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

/**
 * The part of an answer to put in a field: the first fenced block when the
 * answer has one (the helper is told to give paste-ready text that way),
 * otherwise the whole answer.
 */
export function extractApplicableText(answer: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(answer);
  if (fenced && fenced[1]!.trim()) return fenced[1]!.replace(/\n$/, "");
  return answer.trim();
}
