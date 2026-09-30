/**
 * DUR-4078: launches one hardened Chromium process per browser session, per
 * the design in the ticket (proxy forced to browser-egress, QUIC/WebRTC-leak
 * prevention, autofill/password-manager/payment-handler off, service workers
 * blocked, downloads refused, nb-NO/Europe/Oslo locale). Uses
 * `launchPersistentContext` (not `browser.newContext()`) specifically so
 * "one process per session" is literal: each session gets its own Chromium
 * process rooted at its own `userDataDir`, and closing the context kills that
 * process outright (see session-manager.ts, which also wipes the
 * `userDataDir` -- normally on the container's tmpfs -- after close).
 *
 * Autofill/saved-passwords/payment-handler cannot be fully disabled via
 * launch args alone (some are profile prefs, not CLI switches), so this also
 * seeds a `Default/Preferences` file in the fresh `userDataDir` before
 * Chromium starts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

export const EGRESS_PROXY_URL = process.env.PAPERCLIP_BROWSER_EGRESS_URL?.trim() || "http://browser-egress:3128";

const CHROMIUM_ARGS = [
  // Prevents Chromium from ever attempting a direct QUIC (UDP/443)
  // connection, which would bypass the HTTP proxy the sandbox depends on
  // for all egress filtering.
  "--disable-quic",
  // WebRTC's own ICE/STUN candidate gathering can reveal the container's
  // real (internal) IP over UDP even behind an HTTP proxy; this policy
  // forces WebRTC to either not gather non-proxied candidates or drop them.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--enforce-webrtc-ip-permission-check",
  // Chromium features that must stay off regardless of what a site's own
  // page JS requests: native payment sheets, autofill telemetry/sync, the
  // password-manager onboarding nudge, and background network chatter that
  // is not part of any action Maja actually took.
  "--disable-features=PaymentHandler,PaymentRequest,AutofillServerCommunication,AutofillEnableAccountWalletStorage,PasswordManagerOnboarding,TranslateUI,MediaRouter",
  "--disable-save-password-bubble",
  "--disable-notifications",
  "--disable-background-networking",
  "--no-first-run",
];

/**
 * Chromium prefs that are not exposed as launch args at all. Written into a
 * fresh `userDataDir` before launch -- keys taken from Chromium's own
 * `chrome/common/pref_names.cc` naming, only `false`-ing out the ones the
 * design calls for (autofill, saved passwords, payment methods); everything
 * else is left at Chromium's default.
 */
function preferencesFileContents(): string {
  return JSON.stringify({
    autofill: { profile_enabled: false, credit_card_enabled: false },
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: {
      password_manager_enabled: false,
      default_content_setting_values: { notifications: 2 },
    },
  });
}

async function seedProfilePreferences(userDataDir: string): Promise<void> {
  const defaultDir = join(userDataDir, "Default");
  await mkdir(defaultDir, { recursive: true });
  await writeFile(join(defaultDir, "Preferences"), preferencesFileContents(), "utf8");
}

export interface LaunchHardenedContextOptions {
  /** Root of this session's own tmpfs directory; wiped by the caller on session close. */
  userDataDir: string;
  headless?: boolean;
  /**
   * Test-only override: `null` launches with no proxy at all, so the
   * integration test can drive the local fixture server directly without
   * needing a real `browser-egress` on the network. Production code never
   * sets this -- it always goes through `EGRESS_PROXY_URL`.
   */
  proxyUrl?: string | null;
}

/**
 * One Chromium process, one fresh context, hardened per the design. Callers
 * own the returned context's lifecycle (close it, then wipe `userDataDir`).
 */
export async function launchHardenedContext(options: LaunchHardenedContextOptions): Promise<BrowserContext> {
  await seedProfilePreferences(options.userDataDir);
  const proxyUrl = options.proxyUrl === undefined ? EGRESS_PROXY_URL : options.proxyUrl;

  return chromium.launchPersistentContext(options.userDataDir, {
    headless: options.headless ?? true,
    args: CHROMIUM_ARGS,
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
    // Locale/timezone per the design: Maja's sessions present as a browser
    // in Norway regardless of where the container itself physically runs.
    locale: "nb-NO",
    timezoneId: "Europe/Oslo",
    viewport: { width: 1280, height: 900 },
    // Service workers are blocked outright -- nothing about Maja's browsing
    // needs offline/background page behaviour, and a service worker is an
    // easy place for a page to stash state that outlives what the
    // accessibility snapshot shows.
    serviceWorkers: "block",
    // Downloads are refused outright (design: "downloads refused"). Belt and
    // suspenders: acceptDownloads:false makes Playwright cancel the download
    // itself; session-manager.ts's own `page.on("download", ...)` handler
    // (wired per page) is the second layer in case a future Playwright
    // version changes that default behaviour.
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
  });
}
