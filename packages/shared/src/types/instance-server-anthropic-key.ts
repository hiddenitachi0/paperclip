// DUR-3995: Paperclip's own Claude key — the Anthropic API key the SERVER
// uses for the things it does itself (quick answers, deciding who a request
// goes to, the quality check before a task is marked done, the business-data
// trial). Not the credential agents run on.
//
// Nothing in this file ever carries the key. `hint` is the last four
// characters, `fingerprint` a short prefix of its sha256 so the settings page
// can say "the same key as before" / "a different key".

export type ServerAnthropicKeySource =
  /** Set from the settings page and stored encrypted in the database. */
  | "stored"
  /** Still coming from PAPERCLIP_SERVER_ANTHROPIC_API_KEY on the server. */
  | "environment";

export interface InstanceServerAnthropicKeyStatus {
  /** True when the server has a key from either source. */
  configured: boolean;
  /** Where the key in use right now comes from, or null when there is none. */
  source: ServerAnthropicKeySource | null;
  /** Plain-language one-liner for the settings page. */
  headline: string;
  /** Last four characters of the stored key, e.g. "…8Xa2". Null for an environment key. */
  hint: string | null;
  fingerprint: string | null;
  savedAt: string | null;
  savedByUserId: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

/** What the "Test" button reports back. Never carries the key. */
export interface InstanceServerAnthropicKeyTestResult {
  ok: boolean;
  /** Either "Claude answered." or the exact error Claude gave, in plain words. */
  message: string;
  status: InstanceServerAnthropicKeyStatus;
}
