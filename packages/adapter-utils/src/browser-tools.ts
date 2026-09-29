/**
 * DUR-4013: the plain browser tools (open/navigate/snapshot/read_text/click/
 * type/select/check/press_key/screenshot/wait/back/close/hand_over), each
 * routed through the safety checks from final-action-matcher.ts and
 * payment-detection.ts before it is allowed to reach a real page. This file
 * defines the `BrowserDriver` interface every tool is implemented against
 * and the `BrowserToolHandler` that applies the gate -- it does not itself
 * talk to Chromium (see playwright-driver.ts for that), so the gating logic
 * is fully unit-testable with an in-memory fake driver.
 *
 * Gated tools (request_booking, request_purchase, check_clearance,
 * fill_payment_details, confirm_final_step, wait_for_outcome,
 * report_outcome) are server-side (step 3/4/6) and are not implemented
 * here -- this worker holds no clearance state and makes no booking/
 * purchase decision, per the design's core rule.
 */

import { evaluateFinalActionRisk, type FinalActionRefusal } from "./final-action-matcher.js";
import { evaluateTypeSafety, type PaymentFieldSignals, type TypeRefusal } from "./payment-detection.js";

export interface ElementRef {
  /** Stable id assigned at snapshot time; the only way a tool call names an element. */
  ref: string;
  role: string;
  name: string;
}

export interface AccessibilitySnapshot {
  /** Compact textual tree, refs inline like "[ref=e3] button \"Confirm\"". Framed as untrusted page content by the caller. */
  tree: string;
  url: string;
  title: string;
}

export interface ElementDescriptor extends PaymentFieldSignals {
  ref: string;
  role: string;
  /** True for a submit button, or Enter pressed while focus is inside a form. */
  isFormSubmit?: boolean;
  /** True when the enclosing form contains a field that looks like a payment field. */
  formHasPaymentField?: boolean;
}

/**
 * The driver contract every plain tool is implemented against. A real
 * implementation wraps a single Playwright page (playwright-driver.ts); a
 * fake implementation backs the unit tests for the gate itself.
 */
export interface BrowserDriver {
  navigate(url: string): Promise<AccessibilitySnapshot>;
  snapshot(): Promise<AccessibilitySnapshot>;
  readText(): Promise<string>;
  describeElement(ref: string): Promise<ElementDescriptor | null>;
  /** Performs the click. Only called after the gate has cleared it. */
  performClick(ref: string): Promise<AccessibilitySnapshot>;
  performType(ref: string, text: string): Promise<AccessibilitySnapshot>;
  performSelect(ref: string, value: string): Promise<AccessibilitySnapshot>;
  performCheck(ref: string, checked: boolean): Promise<AccessibilitySnapshot>;
  /** Returns the ref of the currently focused element's enclosing form submit target, if any, for the Enter-key final-action check. */
  focusedFormSubmitTarget(): Promise<ElementDescriptor | null>;
  performPressKey(key: string): Promise<AccessibilitySnapshot>;
  screenshot(): Promise<Uint8Array>;
  wait(ms: number): Promise<void>;
  back(): Promise<AccessibilitySnapshot>;
  close(): Promise<void>;
}

export type ToolRefusal = FinalActionRefusal | TypeRefusal;

export interface ToolResult<T> {
  ok: true;
  value: T;
}
export interface ToolRefused {
  ok: false;
  refusal: ToolRefusal;
}
export type ToolOutcome<T> = ToolResult<T> | ToolRefused;

function ok<T>(value: T): ToolOutcome<T> {
  return { ok: true, value };
}
function refused<T>(refusal: ToolRefusal): ToolOutcome<T> {
  return { ok: false, refusal };
}

/** `label`/`name` are `string | null` on the wire; the risk evaluators want `string | undefined`. */
function elementText(el: Pick<ElementDescriptor, "label" | "name">): string | undefined {
  return el.label ?? el.name ?? undefined;
}

/**
 * Wires a BrowserDriver into the gated tool surface. Every method here
 * corresponds 1:1 to a plain tool from the design; nothing here decides
 * bookings/purchases, it only decides whether a *generic* interaction may
 * proceed.
 */
export class BrowserToolHandler {
  constructor(private readonly driver: BrowserDriver) {}

  async navigate(url: string): Promise<AccessibilitySnapshot> {
    if (!/^https:\/\//i.test(url)) {
      throw new Error("browser_navigate only accepts https:// URLs");
    }
    return this.driver.navigate(url);
  }

  snapshot(): Promise<AccessibilitySnapshot> {
    return this.driver.snapshot();
  }

  readText(): Promise<string> {
    return this.driver.readText();
  }

  /**
   * A ref that does not resolve to a real element (stale from an earlier
   * snapshot, or never existed) is a caller error, not a safety refusal --
   * it must throw rather than fall through to "no risky signal found" and
   * let the click proceed unverified.
   */
  async click(ref: string, _why: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const el = await this.driver.describeElement(ref);
    if (!el) throw new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);
    const risk = evaluateFinalActionRisk({
      text: elementText(el),
      isFormSubmit: el.isFormSubmit,
      formHasPaymentField: el.formHasPaymentField,
    });
    if (risk) return refused(risk);
    return ok(await this.driver.performClick(ref));
  }

  async type(ref: string, text: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const el = await this.driver.describeElement(ref);
    if (!el) throw new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);
    const risk = evaluateTypeSafety(text, el);
    if (risk) return refused(risk);
    return ok(await this.driver.performType(ref, text));
  }

  select(ref: string, value: string): Promise<AccessibilitySnapshot> {
    return this.driver.performSelect(ref, value);
  }

  check(ref: string, checked: boolean): Promise<AccessibilitySnapshot> {
    return this.driver.performCheck(ref, checked);
  }

  /**
   * Enter inside a form is treated as a submit action, per the design ("Enter
   * = submit -> same final-button check"), so it runs through the identical
   * evaluateFinalActionRisk() gate as a click on the form's submit control.
   */
  async pressKey(key: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    if (key === "Enter") {
      const target = await this.driver.focusedFormSubmitTarget();
      if (target) {
        const risk = evaluateFinalActionRisk({
          text: elementText(target),
          isFormSubmit: true,
          formHasPaymentField: target.formHasPaymentField,
        });
        if (risk) return refused(risk);
      }
    }
    return ok(await this.driver.performPressKey(key));
  }

  screenshot(): Promise<Uint8Array> {
    return this.driver.screenshot();
  }

  wait(ms: number): Promise<void> {
    return this.driver.wait(ms);
  }

  back(): Promise<AccessibilitySnapshot> {
    return this.driver.back();
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}
