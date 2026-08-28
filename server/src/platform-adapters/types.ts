import type { PersonaAccountPlatform } from "@paperclipai/shared";

// DUR-134: the interface every social/creator-platform publisher implements.
// Fanvue is the only platform shipped (23 August operator decision --
// Instagram/Meta dropped, Twitter/X not started); this interface exists so
// adding X/Meta later (mandatory human approval, see persona-publisher.ts's
// autonomy gate) is "write an adapter", not "change the publisher".
export interface PlatformPublishRequest {
  /** The narrowly-scoped publish credential resolved via the persona_account secret binding -- never a company-wide token. */
  token: string;
  /** The platform's own account/creator id for this persona_accounts row. */
  externalAccountId: string;
  caption: string;
  /** Pre-signed/fetchable URL for the post's image, or null for a text-only post. */
  mediaUrl: string | null;
  /**
   * The exact AI-disclosure text to append/attach, or null if the account's
   * aiDisclosureEnabled is false. Fanvue's own Acceptable Use Policy
   * requires AI-disclosure on AI-generated media (see DUR-134's ticket
   * body) -- adapters for platforms with a native disclosure flag/field
   * should prefer that over caption text; Fanvue's public API docs do not
   * document one, so the Fanvue adapter appends it to the caption.
   */
  disclosureText: string | null;
}

export interface PlatformPublishResult {
  /** The platform's own id for the created post. */
  externalPostId: string;
}

export class PlatformPublishError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, opts: { retryable: boolean; retryAfterSeconds?: number | null; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PlatformPublishError";
    this.retryable = opts.retryable;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

export interface PlatformAdapter {
  readonly platform: PersonaAccountPlatform;
  publish(request: PlatformPublishRequest): Promise<PlatformPublishResult>;
}
