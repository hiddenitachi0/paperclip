import { useEffect, useState } from "react";
import { storylineFetchJson } from "./storyline-api.js";

// What a film may show: a small "Safe for work" / "Mature" badge on every film,
// and, for the people allowed to change it, a switch with a plain confirmation
// before a film becomes mature. The server decides who may switch (a film's
// owner; a company admin may only switch back to safe); this file only hides
// the buttons that would be refused and shows the server's own words if a
// switch is refused anyway.

export type FilmContentRating = "sfw" | "mature";

/** A missing or unreadable rating means safe for work, the same rule the server uses. */
export function readFilmRating(value: unknown): FilmContentRating {
  return value === "mature" ? "mature" : "sfw";
}

export interface FilmRatingAccess {
  ready: boolean;
  /** May switch a film to Mature (the company's owner, or an administrator of the whole instance). */
  canMakeMature: boolean;
  /** May switch a film back to Safe for work (also company admins). */
  canMakeSafe: boolean;
}

/**
 * Who may change a film's rating, for this standalone plugin bundle. UX only:
 * the server is the real gate. With no sign-in (a single-user Paperclip) the
 * local board is the owner.
 */
export function useFilmRatingAccess(companyId: string | null | undefined, userId: string | null | undefined): FilmRatingAccess {
  const [state, setState] = useState<FilmRatingAccess>({ ready: false, canMakeMature: false, canMakeSafe: false });
  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setState({ ready: true, canMakeMature: true, canMakeSafe: true });
      return;
    }
    storylineFetchJson<{ isInstanceAdmin?: boolean; memberships?: Array<{ companyId: string; membershipRole: string | null; status: string }> }>("/api/cli-auth/me")
      .then((res) => {
        if (cancelled) return;
        const membership = companyId ? (res.memberships ?? []).find((m) => m.companyId === companyId && m.status === "active") : undefined;
        const role = membership?.membershipRole ?? null;
        const owner = res.isInstanceAdmin === true || role === "owner";
        setState({ ready: true, canMakeMature: owner, canMakeSafe: owner || role === "admin" });
      })
      .catch(() => {
        if (!cancelled) setState({ ready: true, canMakeMature: false, canMakeSafe: false });
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, userId]);
  return state;
}

const badgeBase: React.CSSProperties = { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, border: "1px solid transparent", whiteSpace: "nowrap" };
const badgeSafe: React.CSSProperties = { ...badgeBase, background: "#e6fcf5", color: "#087f5b", borderColor: "#96f2d7" };
const badgeMature: React.CSSProperties = { ...badgeBase, background: "#fff4e6", color: "#d9480f", borderColor: "#ffc078" };

export function ratingLabel(rating: FilmContentRating): string {
  return rating === "mature" ? "Mature" : "Safe for work";
}

/** The small label on a film. Anyone who can see the film sees it. */
export function ContentRatingBadge({ rating }: { rating: unknown }) {
  const value = readFilmRating(rating);
  return (
    <span style={value === "mature" ? badgeMature : badgeSafe} data-testid="content-rating-badge" data-rating={value}>
      {ratingLabel(value)}
    </span>
  );
}

const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const matureBtn: React.CSSProperties = { ...baseBtn, background: "#d9480f", color: "#fff" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 };
const dialogBox: React.CSSProperties = { background: "#fff", color: "#212529", borderRadius: 12, padding: 18, maxWidth: 460, width: "100%", display: "flex", flexDirection: "column", gap: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.3)" };

/**
 * The switch in a film's header. Owners see both directions; a company admin
 * can only switch a Mature film back; everyone else sees nothing here (the
 * badge is enough). Switching to Mature asks first; switching back does not.
 */
export function ContentRatingSwitch(props: {
  /** /api/companies/:companyId/video-storylines/:storylineId */
  base: string;
  rating: unknown;
  access: FilmRatingAccess;
  /** Another change to the film is being saved, so wait. */
  disabled?: boolean;
  /** Called after the server accepted the change, so the page can reload the film. */
  onChanged: () => void | Promise<void>;
}) {
  const rating = readFilmRating(props.rating);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = rating === "mature" ? props.access.canMakeSafe : props.access.canMakeMature;
  if (!props.access.ready) return null;
  // Everyone else sees the badge only.
  if (!allowed) return null;

  const change = async (next: FilmContentRating) => {
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(
        `${props.base}/content-rating`,
        { method: "PUT", body: JSON.stringify(next === "mature" ? { contentRating: next, confirmed: true } : { contentRating: next }) },
        "changing what the film may show",
      );
      setConfirming(false);
      await props.onChanged();
    } catch (e) {
      // Keep the server's own sentence when it refuses; it already says who can do this.
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }} data-testid="content-rating-switch">
      {rating === "mature" ? (
        <button type="button" style={ghostBtn} disabled={busy || props.disabled} onClick={() => void change("sfw")}>
          Switch back to Safe for work
        </button>
      ) : (
        <button
          type="button"
          style={ghostBtn}
          disabled={busy || props.disabled}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Switch to Mature…
        </button>
      )}
      {error && !confirming && (
        <div style={errorBox} role="alert" data-testid="content-rating-error">
          {error}
        </div>
      )}
      {confirming && (
        <div style={overlay} data-testid="content-rating-confirm">
          <div style={dialogBox} role="dialog" aria-modal="true" aria-labelledby="content-rating-confirm-title">
            <strong id="content-rating-confirm-title" style={{ fontSize: 15 }}>
              Allow mature content in this film?
            </strong>
            <p style={{ fontSize: 13, margin: 0 }}>This film is Safe for work now. If you switch it to Mature:</p>
            <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
              <li>The safety filters are only turned off for looks that were saved as mature. Other looks stay filtered.</li>
              <li>Some models that are blocked in a Safe for work film can be used.</li>
              <li>Nothing else changes. You can switch back to Safe for work at any time.</li>
            </ul>
            {error && (
              <div style={errorBox} role="alert" data-testid="content-rating-error">
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" style={ghostBtn} disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" style={matureBtn} disabled={busy} onClick={() => void change("mature")}>
                {busy ? "Saving…" : "Yes, make it Mature"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The server's own refusal sentence. A 403 comes back as "You don't have access to do that: <server sentence>", so the sentence after the colon is kept. */
export function refusalText(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  const prefix = "You don't have access to do that: ";
  if (message.startsWith(prefix)) return message.slice(prefix.length);
  return message || "The change was not saved. Please try again.";
}
