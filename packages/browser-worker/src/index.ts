// The click/type gating logic (final-action refusal, payment-field refusal,
// BrowserToolHandler) lives in @paperclipai/adapter-utils, not here: it is
// pure driver-agnostic TypeScript with no Playwright dependency, and the
// server (published to npm as @paperclipai/server) needs it too. This
// package is private (never published), so a real npm "dependencies" edge
// from server onto it would break `npm install @paperclipai/server` -- see
// the release-package-manifest.json unpublishable-workspace-edge check.
// Re-exported here so this package's own entrypoints/fixtures can keep
// importing from "@paperclipai/browser-worker" unchanged.
export {
  evaluateFinalActionRisk,
  matchFinalActionWording,
  FINAL_ACTION_TERMS,
  INVOICE_TERMS,
} from "@paperclipai/adapter-utils/final-action-matcher";
export type {
  FinalActionLanguage,
  FinalActionTerm,
  FinalActionMatch,
  FinalActionRefusalReason,
  FinalActionRefusal,
  EvaluateFinalActionInput,
} from "@paperclipai/adapter-utils/final-action-matcher";
export {
  isLuhnValid,
  findLuhnValidRuns,
  containsCardNumber,
  looksLikePaymentField,
  evaluateTypeSafety,
} from "@paperclipai/adapter-utils/payment-detection";
export type {
  PaymentFieldSignals,
  TypeRefusalReason,
  TypeRefusal,
} from "@paperclipai/adapter-utils/payment-detection";
export {
  checkHostAllowed,
  createEgressProxyServer,
  parseAbsoluteHttpTarget,
  parseConnectTarget,
  ALLOWED_PROXY_PORTS,
} from "./egress-proxy.js";
export type {
  DnsLookupResult,
  DnsLookupAll,
  EgressRefusalReason,
  EgressLogEntry,
  EgressProxyOptions,
  HostCheckResult,
} from "./egress-proxy.js";
export { BrowserToolHandler } from "@paperclipai/adapter-utils/browser-tools";
export type {
  ElementRef,
  AccessibilitySnapshot,
  ElementDescriptor,
  BrowserDriver,
  ToolRefusal,
  ToolResult,
  ToolRefused,
  ToolOutcome,
} from "@paperclipai/adapter-utils/browser-tools";
