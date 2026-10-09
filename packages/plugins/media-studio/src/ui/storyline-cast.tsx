import { useCallback, useMemo, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";

// Standalone ES module (see index.tsx's note): bare specifiers only outside
// this ui/ folder, so the helpers below are copies of
// packages/shared/src/video-storyline-cast.ts (a test checks they agree).
//
// Step 1's "Cast" section: the script's characters, each linked (or not) to
// one of the company's saved people (Media Studio identities). A linked
// character keeps the same face and body in every storyboard picture and
// every video clip they are in. The server checks every link belongs to this
// company; this section only offers the company's own saved people.

/** The plugin action that lists the company's saved people (the page calls it; anchor-helpers.ts keeps the same name). */
export const CAST_IDENTITIES_ACTION = "identities.list";

export interface CastMember {
  id: string;
  name: string;
  nickname: string | null;
  description: string | null;
  identityId: string | null;
}

export interface StorylineCast {
  members: CastMember[];
  shotCast: Record<string, string[]>;
}

/** What the section needs of a saved person (from the plugin's identities.list). */
export interface CastIdentityOption {
  id: string;
  name: string;
  nickname: string | null;
  thumbFileId: string | null;
  hasFace: boolean;
  /** Has a ready trained LoRA on Sogni. */
  hasSogniLora: boolean;
}

export interface CastShot {
  id: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
}

export const EMPTY_CAST: StorylineCast = { members: [], shotCast: {} };

// ─── Pure helpers (copies of the shared ones) ─────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function castNameMentioned(text: string, name: string | null | undefined): boolean {
  const n = name?.trim();
  if (!n || n.length < 2) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(n).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
  return pattern.test(text);
}

/** The cast members a shot's description names (their name, nickname, or the linked person's name or nickname). */
export function detectShotCast(text: string, members: readonly CastMember[], identities: readonly Pick<CastIdentityOption, "id" | "name" | "nickname">[]): string[] {
  return members
    .filter((m) => {
      const identity = m.identityId ? identities.find((i) => i.id === m.identityId) : undefined;
      return [m.name, m.nickname, identity?.name, identity?.nickname].some((n) => castNameMentioned(text, n));
    })
    .map((m) => m.id);
}

/** Who is in a shot: a person's own pick, else the names found in its description and camera notes. */
export function shotCastFor(
  shot: CastShot,
  cast: StorylineCast,
  identities: readonly Pick<CastIdentityOption, "id" | "name" | "nickname">[],
): { castIds: string[]; picked: boolean } {
  const picked = cast.shotCast[shot.id];
  if (picked) {
    const ids = new Set(cast.members.map((m) => m.id));
    return { castIds: picked.filter((id) => ids.has(id)), picked: true };
  }
  return { castIds: detectShotCast([shot.prompt, shot.cameraNotes ?? ""].join("\n"), cast.members, identities), picked: false };
}

/** Names in a scene's "Characters:" list (what a script import writes into scene 1's notes) that are not in the cast yet. */
export function scriptCharacterSuggestions(sceneNotes: ReadonlyArray<string | null>, members: readonly CastMember[]): Array<{ name: string; description: string | null }> {
  const known = new Set(members.flatMap((m) => [m.name.toLowerCase(), ...(m.nickname ? [m.nickname.toLowerCase()] : [])]));
  const out: Array<{ name: string; description: string | null }> = [];
  for (const notes of sceneNotes) {
    if (!notes) continue;
    const lines = notes.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "Characters:");
    if (start < 0) continue;
    for (const line of lines.slice(start + 1)) {
      const match = /^-\s*([^:]{1,60}):\s*(.*)$/.exec(line.trim());
      if (!match) break;
      const name = match[1]!.trim();
      if (!name || known.has(name.toLowerCase()) || out.some((o) => o.name.toLowerCase() === name.toLowerCase())) continue;
      out.push({ name, description: match[2]!.trim() || null });
    }
  }
  return out;
}

/** Plain labels per shot for step 2's tiles: "Maja (saved person)", "Bob". */
export function shotCastLabels(
  shots: readonly CastShot[],
  cast: StorylineCast,
  identities: readonly Pick<CastIdentityOption, "id" | "name" | "nickname">[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const shot of shots) {
    const { castIds } = shotCastFor(shot, cast, identities);
    const labels = castIds
      .map((id) => cast.members.find((m) => m.id === id))
      .filter((m): m is CastMember => !!m)
      .map((m) => (m.identityId && identities.some((i) => i.id === m.identityId) ? `${m.name} (saved person)` : m.name));
    if (labels.length > 0) out[shot.id] = labels;
  }
  return out;
}

/** The identities.list answer, reduced to what the Cast section shows. */
export function castIdentityOptions(raw: unknown): CastIdentityOption[] {
  const list = (raw as { identities?: unknown } | null)?.identities;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const i = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!i || typeof i.id !== "string" || typeof i.name !== "string") return [];
    const crops = Array.isArray(i.crops) ? (i.crops as Array<{ role?: unknown; fileId?: unknown }>) : [];
    const face = crops.find((c) => c.role === "face" && typeof c.fileId === "string")?.fileId as string | undefined;
    const canonical = typeof i.canonicalFileId === "string" ? i.canonicalFileId : null;
    const original = typeof i.originalFileId === "string" ? i.originalFileId : null;
    const trained = Array.isArray(i.trainedIdentities) ? (i.trainedIdentities as Array<{ provider?: unknown; status?: unknown }>) : [];
    return [
      {
        id: i.id,
        name: i.name,
        nickname: typeof i.nickname === "string" && i.nickname ? i.nickname : null,
        thumbFileId: face ?? canonical ?? original,
        hasFace: Boolean(face ?? canonical ?? original),
        hasSogniLora: trained.some((t) => t.provider === "sogni-lora" && (t.status === "ready" || t.status === "completed")),
      },
    ];
  });
}

function thumbPath(fileId: string): string {
  return `/api/attachments/${fileId}/thumbnail`;
}

// ─── Styles (small local copies, see the note at the top) ────────────────────

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const input: React.CSSProperties = { padding: 6, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const noticeBox: React.CSSProperties = { background: "#fff9db", color: "#7f5f01", padding: "8px 10px", borderRadius: 8, fontSize: 12 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };
const thumb: React.CSSProperties = { width: 32, height: 32, borderRadius: 6, objectFit: "cover", background: "rgba(128,128,128,0.15)", flex: "0 0 auto" };

// ─── The person picker (a list with thumbnails) ──────────────────────────────

function IdentityPicker(props: {
  member: CastMember;
  identities: CastIdentityOption[];
  disabled: boolean;
  onPick: (identityId: string | null) => void;
}) {
  const { member, identities } = props;
  const [open, setOpen] = useState(false);
  const current = identities.find((i) => i.id === member.identityId) ?? null;
  const missing = member.identityId !== null && !current;
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 4 }}>
      <button
        type="button"
        style={{ ...ghostBtn, display: "flex", alignItems: "center", gap: 6, textAlign: "left" }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Saved person for ${member.name}`}
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
        data-testid={`cast-picker-${member.id}`}
      >
        {current?.thumbFileId ? <img src={thumbPath(current.thumbFileId)} alt="" style={thumb} /> : <span style={thumb} />}
        <span>{current ? current.name : missing ? "Saved person no longer exists" : "Not linked"}</span>
      </button>
      {open && (
        <div role="listbox" aria-label={`Pick a saved person for ${member.name}`} style={{ ...card, position: "absolute", top: "100%", left: 0, zIndex: 5, background: "var(--background, #fff)", minWidth: 240, maxHeight: 280, overflowY: "auto", padding: 6, gap: 4 }}>
          <button
            type="button"
            role="option"
            aria-selected={member.identityId === null}
            style={{ ...ghostBtn, textAlign: "left" }}
            onClick={() => {
              setOpen(false);
              props.onPick(null);
            }}
          >
            Not linked (made from the description only)
          </button>
          {identities.map((i) => (
            <button
              key={i.id}
              type="button"
              role="option"
              aria-selected={member.identityId === i.id}
              style={{ ...ghostBtn, display: "flex", alignItems: "center", gap: 6, textAlign: "left", opacity: i.hasFace ? 1 : 0.6 }}
              onClick={() => {
                setOpen(false);
                props.onPick(i.id);
              }}
            >
              {i.thumbFileId ? <img src={thumbPath(i.thumbFileId)} alt="" style={thumb} /> : <span style={thumb} />}
              <span>
                {i.name}
                {i.nickname ? ` ("${i.nickname}")` : ""}
                {!i.hasFace ? " -- no face picture yet" : ""}
              </span>
            </button>
          ))}
          {identities.length === 0 && <p style={muted}>No saved people yet. Add one on Media Studio's Identities tab.</p>}
        </div>
      )}
    </div>
  );
}

// ─── The section ─────────────────────────────────────────────────────────────

export function StorylineCastSection(props: {
  /** /api/companies/:companyId/video-storylines/:storylineId */
  base: string;
  cast: StorylineCast;
  shots: CastShot[];
  sceneNotes: Array<string | null>;
  editable: boolean;
  /** Called with the storyline the server sent back after a change. */
  onSaved: (storyline: unknown) => void | Promise<void>;
  /** The company's saved people (the page loads them with identities.list). */
  identities: CastIdentityOption[];
  /** Why the saved people could not be loaded, if they could not. */
  identityError?: string | null;
}) {
  const { base, cast, shots, editable, identities } = props;
  const identityError = props.identityError ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newNickname, setNewNickname] = useState("");

  const suggestions = useMemo(() => scriptCharacterSuggestions(props.sceneNotes, cast.members), [props.sceneNotes, cast.members]);

  const saveMembers = useCallback(
    async (members: Array<Omit<CastMember, "id"> & { id?: string }>) => {
      setBusy(true);
      setError(null);
      try {
        const saved = await storylineFetchJson(`${base}/cast`, { method: "PUT", body: JSON.stringify({ members }) }, "saving the cast");
        await props.onSaved(saved);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, props.onSaved],
  );

  const saveShot = useCallback(
    async (shotId: string, castIds: string[] | null) => {
      setBusy(true);
      setError(null);
      try {
        const saved = await storylineFetchJson(`${base}/shots/${shotId}/cast`, { method: "PUT", body: JSON.stringify({ castIds }) }, "saving who is in the shot");
        await props.onSaved(saved);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, props.onSaved],
  );

  const disabled = busy || !editable;
  const sortedShots = shots.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const linked = cast.members.filter((m) => m.identityId && identities.some((i) => i.id === m.identityId));
  const example = linked[0]?.name ?? cast.members[0]?.name ?? "Maja";
  const crowded = sortedShots.filter((shot) => {
    const { castIds } = shotCastFor(shot, cast, identities);
    return castIds.filter((id) => linked.some((m) => m.id === id)).length > 1;
  });

  return (
    <div style={card} data-testid="cast-section">
      <div>
        <strong style={{ fontSize: 13 }}>Cast</strong>
        <p style={muted}>
          The people in your story. Linking {example} to a saved person keeps {example}'s face and body the same in every picture and every shot. Saved people
          are made on Media Studio's Identities tab. A character you do not link is drawn from the script's description only, so they may look a little different
          from shot to shot.
        </p>
      </div>
      {identityError && <div style={errorBox}>{identityError}</div>}
      {error && <div style={errorBox} role="alert">{error}</div>}
      {!editable && <p style={muted}>The cast cannot be changed while the video is rendering.</p>}

      {cast.members.length === 0 && <p style={muted}>No characters yet. Import a script with a "characters" list, or add a character below.</p>}
      {cast.members.map((member) => {
        const identity = identities.find((i) => i.id === member.identityId);
        return (
          <div key={member.id} data-testid={`cast-member-${member.id}`} style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", borderTop: "1px solid rgba(128,128,128,0.15)", paddingTop: 6 }}>
            <div style={{ flex: "1 1 180px", minWidth: 0, fontSize: 12 }}>
              <strong>{member.name}</strong>
              {member.nickname ? <span style={{ color: "#868e96" }}> (also called {member.nickname})</span> : null}
              {member.description ? <div style={{ color: "#868e96" }}>{member.description}</div> : null}
              {identity && !identity.hasFace && (
                <div style={{ color: "#b45309" }}>This saved person has no face picture yet, so pictures cannot keep the face. Add a face crop on the Identities tab.</div>
              )}
              {identity?.hasSogniLora && <div style={{ color: "#868e96" }}>Has a trained LoRA: used on Sogni pictures when a look allows it.</div>}
            </div>
            <IdentityPicker
              member={member}
              identities={identities}
              disabled={disabled}
              onPick={(identityId) => void saveMembers(cast.members.map((m) => (m.id === member.id ? { ...m, identityId } : m)))}
            />
            <button type="button" style={ghostBtn} disabled={disabled} onClick={() => void saveMembers(cast.members.filter((m) => m.id !== member.id))}>
              Remove
            </button>
          </div>
        );
      })}

      {suggestions.length > 0 && (
        <div style={noticeBox} data-testid="cast-suggestions">
          Found in the script but not in the cast yet: {suggestions.map((s) => s.name).join(", ")}.{" "}
          <button
            type="button"
            style={secondaryBtn}
            disabled={disabled}
            onClick={() => void saveMembers([...cast.members, ...suggestions.map((s) => ({ name: s.name, nickname: null, description: s.description, identityId: null }))])}
          >
            Add them
          </button>
        </div>
      )}

      {editable && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input style={{ ...input, flex: "1 1 140px" }} placeholder="Character name, e.g. Maja" aria-label="New character name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input
            style={{ ...input, flex: "1 1 140px" }}
            placeholder="Other name in the script (optional)"
            aria-label="Other name for the new character"
            value={newNickname}
            onChange={(e) => setNewNickname(e.target.value)}
          />
          <button
            type="button"
            style={secondaryBtn}
            disabled={disabled || !newName.trim()}
            onClick={() =>
              void saveMembers([...cast.members, { name: newName.trim(), nickname: newNickname.trim() || null, description: null, identityId: null }]).then(() => {
                setNewName("");
                setNewNickname("");
              })
            }
          >
            Add character
          </button>
        </div>
      )}

      {cast.members.length > 0 && sortedShots.length > 0 && (
        <details data-testid="shot-cast">
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Who is in each shot</summary>
          <p style={muted}>
            Found from the names in each shot's description. Tick or untick to change it; "Use the description" goes back to finding them by name.
          </p>
          {crowded.length > 0 && (
            <div style={noticeBox}>
              {crowded.length === 1 ? "One shot has" : `${crowded.length} shots have`} more than one saved person. Picture models find that harder: both faces are sent
              first, but check those pictures closely, and pick a picture model with more slots if a face is left out.
            </div>
          )}
          {sortedShots.map((shot) => {
            const { castIds, picked } = shotCastFor(shot, cast, identities);
            return (
              <div key={shot.id} data-testid={`shot-cast-row-${shot.id}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, borderTop: "1px solid rgba(128,128,128,0.15)", paddingTop: 4 }}>
                <span style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <strong>Shot {shot.orderIndex + 1}.</strong> {shot.prompt.length > 90 ? `${shot.prompt.slice(0, 90)}...` : shot.prompt}
                </span>
                {cast.members.map((m) => (
                  <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <input
                      type="checkbox"
                      checked={castIds.includes(m.id)}
                      disabled={disabled}
                      aria-label={`${m.name} is in shot ${shot.orderIndex + 1}`}
                      onChange={(e) => {
                        const next = e.target.checked ? [...castIds, m.id] : castIds.filter((id) => id !== m.id);
                        void saveShot(shot.id, next);
                      }}
                    />
                    {m.name}
                  </label>
                ))}
                {picked ? (
                  <button type="button" style={ghostBtn} disabled={disabled} onClick={() => void saveShot(shot.id, null)}>
                    Use the description
                  </button>
                ) : (
                  <span style={{ color: "#868e96" }}>{castIds.length > 0 ? "found by name" : "nobody named"}</span>
                )}
              </div>
            );
          })}
        </details>
      )}
    </div>
  );
}
