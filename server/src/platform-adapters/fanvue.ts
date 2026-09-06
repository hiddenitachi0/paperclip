import type { PlatformAdapter, PlatformPublishRequest, PlatformPublishResult } from "./types.js";
import { PlatformPublishError } from "./types.js";

// DUR-134: Fanvue's documented public API (api.fanvue.com/docs/welcome).
// OAuth 2.0 + PKCE app registration is a human step (creator account with
// completed KYC, per Fanvue's API policy) -- this adapter only implements
// the publish call itself, against a token the operator obtains out of
// band and stores as a company secret (bound to the persona_accounts row
// via the standard secret-binding flow, resolved narrowly through
// GET .../persona-accounts/:accountId/publish-token). Exact request/response
// field names are per Fanvue's public docs as researched for this ticket;
// re-verify against the live API once a developer app exists to test
// against a real account (see the PR description's "deferred" list).
const FANVUE_API_BASE_URL = "https://api.fanvue.com";
const FANVUE_API_VERSION = "2025-06-26";

interface FanvueCreatePostResponse {
  id?: string;
  data?: { id?: string };
}

function appendDisclosure(caption: string, disclosureText: string | null): string {
  if (!disclosureText) return caption;
  return `${caption}\n\n${disclosureText}`;
}

export function fanvuePlatformAdapter(): PlatformAdapter {
  async function publish(request: PlatformPublishRequest): Promise<PlatformPublishResult> {
    const body: Record<string, unknown> = {
      caption: appendDisclosure(request.caption, request.disclosureText),
    };
    if (request.mediaUrl) {
      body.media = [{ url: request.mediaUrl }];
    }

    let response: Response;
    try {
      response = await fetch(`${FANVUE_API_BASE_URL}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.token}`,
          "X-Fanvue-API-Version": FANVUE_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new PlatformPublishError("Failed to reach Fanvue API", { retryable: true, cause: error });
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;
      throw new PlatformPublishError("Fanvue rate limit hit (100 req/60s)", {
        retryable: true,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 60,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new PlatformPublishError("Fanvue rejected the publish token (expired or insufficient scope)", {
        retryable: false,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PlatformPublishError(`Fanvue post creation failed (${response.status}): ${text.slice(0, 500)}`, {
        retryable: response.status >= 500,
      });
    }

    const parsed = (await response.json().catch(() => null)) as FanvueCreatePostResponse | null;
    const externalPostId = parsed?.id ?? parsed?.data?.id;
    if (!externalPostId) {
      throw new PlatformPublishError("Fanvue post creation returned no post id", { retryable: false });
    }

    return { externalPostId };
  }

  return { platform: "fanvue", publish };
}
