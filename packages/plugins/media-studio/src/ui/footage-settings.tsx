import { useEffect, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";

// Storyline Phase 2 (design 2.5): this company's rules for its own photos and
// videos -- the storage limit, upload limits, clean-up days, and "Never send
// uploaded footage to Sogni" (on by default). Everyone in the company sees
// them; only the owner or an admin can change them (the server enforces it).
// D18: "Largest film or saved video" is the per-file limit for finished
// films (2 GB by default, under the server's ceiling), and for videos kept on
// tasks or in Files when the server's operator has allowed large videos there.

type Settings = {
  storageQuotaBytes: number;
  maxVideoMb: number;
  maxPhotoMb: number;
  maxVideoSeconds: number;
  maxVideoFileMb: number;
  cleanupDays: number;
  neverSendUploadsToSogni: boolean;
};
type Response = { settings: Settings; usedBytes: number; explanations: Record<keyof Settings, string>; hardLimits: Record<string, number> };

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const input: React.CSSProperties = { padding: 6, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit", width: 110 };
const help: React.CSSProperties = { fontSize: 12, opacity: 0.75, margin: 0 };
const primaryBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 13, fontWeight: 600, background: "#1971c2", color: "#fff", alignSelf: "flex-start" };

const GB = 1024 ** 3;

export function FootageSettingsPanel({ companyId }: { companyId: string }) {
  const base = `/api/companies/${companyId}/video-storylines/settings/footage`;
  const [data, setData] = useState<Response | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    storylineFetchJson<Response>(base, undefined, "loading the footage settings")
      .then((res) => {
        setData(res);
        setDraft(res.settings);
      })
      .catch((e) => setMessage({ ok: false, text: errorText(e) }));
  }, [base]);

  if (!data || !draft) {
    return (
      <div style={card} aria-label="Your own photos and videos">
        <strong>Your own photos and videos</strong>
        {message ? <p style={help}>{message.text}</p> : <p style={help}>Loading…</p>}
      </div>
    );
  }
  const number = (key: keyof Settings, label: string, scale = 1) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
      {label}
      <input
        style={input}
        type="number"
        min={0}
        value={Math.round((draft[key] as number) / scale)}
        onChange={(e) => setDraft({ ...draft, [key]: Math.round(Number(e.target.value) * scale) })}
        aria-label={label}
      />
      <span style={help}>{data.explanations[key]}</span>
    </label>
  );
  return (
    <div style={card} aria-label="Your own photos and videos" data-testid="footage-settings">
      <strong>Your own photos and videos (Storylines)</strong>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
        <input
          type="checkbox"
          checked={draft.neverSendUploadsToSogni}
          onChange={(e) => setDraft({ ...draft, neverSendUploadsToSogni: e.target.checked })}
          data-testid="footage-never-sogni"
        />
        <span>
          <strong>Never send uploaded footage to Sogni</strong>
          <br />
          <span style={help}>{data.explanations.neverSendUploadsToSogni}</span>
        </span>
      </label>
      <p style={help}>This company uses {(data.usedBytes / GB).toFixed(2)} GB for uploads right now.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {number("storageQuotaBytes", "Storage limit (GB)", GB)}
        {number("maxVideoMb", "Largest video (MB)")}
        {number("maxPhotoMb", "Largest photo (MB)")}
        {number("maxVideoSeconds", "Longest video (seconds)")}
        {typeof draft.maxVideoFileMb === "number" && number("maxVideoFileMb", "Largest film or saved video (MB)")}
        {number("cleanupDays", "Clean up unused after (days)")}
      </div>
      <button
        type="button"
        style={primaryBtn}
        onClick={() =>
          void storylineFetchJson<Response>(base, { method: "PATCH", body: JSON.stringify(draft) }, "saving the footage settings")
            .then((res) => {
              setData(res);
              setDraft(res.settings);
              setMessage({ ok: true, text: "Saved." });
            })
            .catch((e) => setMessage({ ok: false, text: errorText(e) }))
        }
      >
        Save
      </button>
      {message && <p style={{ ...help, color: message.ok ? "#087f5b" : "#a61e4d", opacity: 1 }}>{message.text}</p>}
    </div>
  );
}
