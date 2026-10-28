import { useEffect, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";

// Standalone ES module (see index.tsx's note): no imports from index.tsx.
//
// The "How was this made?" panel on a storyboard picture and on a clip: what
// was really sent to the picture/video service, read from the record the
// server wrote when it was made (GET .../shots/:shotId/generation; see
// packages/shared/src/video-storyline-stills.ts for the shape). The server
// never puts keys or picture bytes in a record, so everything here is safe to
// show to anyone who can see the film.

export interface GenerationRecord {
  version: 1;
  kind: "still" | "clip";
  madeAt: string;
  promptSent: string;
  negativePromptSent: string | null;
  provider: string;
  model: string | null;
  editModel: string | null;
  tool: string | null;
  loras: Array<{ id: string; strength: number }>;
  lorasDropped: Array<{ id: string; reason: string }>;
  contentRating: "sfw" | "mature";
  contentFilterOn: boolean | null;
  providerSafety: Record<string, string | number | boolean>;
  promptExpansion: string;
  references: Array<{ fileId: string | null; role: string }>;
  referencesNotSent: number;
  seed: number | string;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  providerCredits: number | null;
  notes: string[];
}

export interface GenerationResponse {
  still: GenerationRecord | null;
  clip: GenerationRecord | null;
}

const PROVIDER_NAME: Record<string, string> = { fal: "Fal.ai", sogni: "Sogni" };

function cents(value: number | null): string {
  return value === null ? "not known" : `$${(value / 100).toFixed(2)}`;
}

/** The record as plain label/value rows, in reading order. Exported for tests. */
export function generationRows(record: GenerationRecord): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({ label: "Made", value: new Date(record.madeAt).toLocaleString() });
  rows.push({ label: "Service", value: PROVIDER_NAME[record.provider] ?? record.provider });
  rows.push({ label: "Model", value: record.model ?? "the service's default" });
  if (record.editModel) rows.push({ label: "Picture-editing model", value: record.editModel });
  if (record.tool) rows.push({ label: "Tool", value: record.tool });
  rows.push({ label: "Film rating", value: record.contentRating === "sfw" ? "Safe for work" : "Mature" });
  rows.push({
    label: "Content filter",
    value: record.contentFilterOn === null ? "the service's own safety checks (below)" : record.contentFilterOn ? "On" : "Off",
  });
  const safety = Object.entries(record.providerSafety);
  rows.push({ label: "Service safety settings", value: safety.length > 0 ? safety.map(([k, v]) => `${k}: ${String(v)}`).join(", ") : "none sent" });
  rows.push({ label: "Prompt expansion", value: record.promptExpansion });
  rows.push({ label: "Seed", value: String(record.seed) });
  rows.push({ label: "LoRAs used", value: record.loras.length > 0 ? record.loras.map((l) => `${l.id} (strength ${l.strength})`).join(", ") : "none" });
  if (record.lorasDropped.length > 0) rows.push({ label: "LoRAs left out", value: record.lorasDropped.map((l) => `${l.id}: ${l.reason}`).join("\n") });
  const refs = record.references.map((r) => `${r.role}${r.fileId ? ` (file ${r.fileId})` : ""}`);
  rows.push({
    label: "Pictures sent",
    value: `${refs.length > 0 ? refs.join("\n") : "none"}${record.referencesNotSent > 0 ? `\n${record.referencesNotSent} could not be read and were not sent` : ""}`,
  });
  rows.push({ label: "Estimated cost", value: cents(record.estimatedCostCents) });
  rows.push({
    label: "Actual cost",
    value: `${cents(record.actualCostCents)}${record.providerCredits !== null ? ` (${record.providerCredits} Sogni credits)` : ""}`,
  });
  return rows;
}

const box: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.3)", borderRadius: 6, padding: "4px 8px", fontSize: 11 };
const pre: React.CSSProperties = { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit" };

/**
 * `<details>` that loads the record when first opened (and again when
 * `version` changes, so a remade picture shows its own record).
 */
export function HowWasThisMade(props: { base: string; shotId: string; kind: "still" | "clip"; version?: string | null }) {
  const { base, shotId, kind, version } = props;
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<GenerationRecord | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecord(undefined);
    setError(null);
  }, [shotId, version]);

  useEffect(() => {
    if (!open || record !== undefined) return;
    let cancelled = false;
    storylineFetchJson<GenerationResponse>(`${base}/shots/${shotId}/generation`, undefined, "loading how this was made")
      .then((res) => {
        if (!cancelled) setRecord(res[kind]);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, record, base, shotId, kind]);

  return (
    <details style={box} data-testid={`how-made-${kind}-${shotId}`} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>How was this made?</summary>
      {error ? (
        <p style={{ margin: "6px 0 0", color: "#a61e4d" }}>{error}</p>
      ) : record === undefined ? (
        <p style={{ margin: "6px 0 0", color: "#868e96" }}>Loading...</p>
      ) : record === null ? (
        <p style={{ margin: "6px 0 0", color: "#868e96" }}>
          No details were kept for this {kind === "still" ? "picture" : "clip"}. It was made before Paperclip started keeping them.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          <div>
            <div style={{ color: "#868e96" }}>What was sent</div>
            <pre style={pre} data-testid="how-made-prompt">{record.promptSent}</pre>
          </div>
          {record.negativePromptSent && (
            <div>
              <div style={{ color: "#868e96" }}>Things to avoid</div>
              <pre style={pre}>{record.negativePromptSent}</pre>
            </div>
          )}
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px" }}>
            {generationRows(record).map((row) => (
              <div key={row.label} style={{ display: "contents" }}>
                <dt style={{ color: "#868e96" }}>{row.label}</dt>
                <dd style={{ margin: 0, whiteSpace: "pre-line", wordBreak: "break-word" }}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {record.notes.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 16, color: "#b45309" }}>
              {record.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}
