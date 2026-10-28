import { useCallback, useEffect, useState } from "react";
import { errorText } from "./storyline-api.js";
import {
  RATING_NAMES,
  errorBox,
  field,
  input,
  muted,
  providerName,
  setupsBase,
  setupsFetch,
  strengthText,
  type MediaSetupRow,
  type SetupKind,
} from "./setups-api.js";

// "Model setup" in a film's settings: pick one of the company's saved setups
// (made on the Model setups tab) instead of choosing the service and model by
// hand. Only approved setups are offered, because those are the ones the
// company has signed off. Picking one fills in the service and model below it;
// choosing a service or model by hand afterwards clears the pick. The server
// refuses a mature setup in a safe-for-work film and says so in plain words,
// which is shown as it is.

export function StorylineSetupPicker(props: {
  companyId: string;
  storylineId: string;
  kind: SetupKind;
  /** The setup the film uses now (null = chosen by hand). */
  value: string | null;
  disabled?: boolean;
  /** Called after the pick was saved, so the page can read the film again. */
  onChanged?: () => void | Promise<void>;
}) {
  const { companyId, storylineId, kind, value } = props;
  const base = setupsBase(companyId);
  const [setups, setSetups] = useState<MediaSetupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await setupsFetch<{ setups: MediaSetupRow[] }>(`${base}/setups?kind=${kind}`, undefined, "loading the model setups");
      setSetups(res.setups);
    } catch (e) {
      setSetups([]);
      setError(errorText(e));
    }
  }, [base, kind]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!setups) return <p style={muted}>Loading the model setups…</p>;
  // Approved ones, plus the one in use now even if it was sent back to draft since.
  const offered = setups.filter((s) => s.status === "approved" || s.id === value);
  const current = setups.find((s) => s.id === value) ?? null;

  const pick = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const body = kind === "video" ? { videoSetupId: id === "" ? null : id } : { imageSetupId: id === "" ? null : id };
      await setupsFetch(`${base}/storylines/${storylineId}/setups`, { method: "PUT", body: JSON.stringify(body) }, "choosing the model setup");
      await props.onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={field}>
      <label style={field}>
        <span style={{ fontSize: 12, color: "#868e96" }}>{kind === "video" ? "Video model setup" : "Picture model setup"}</span>
        <select style={input} aria-label={kind === "video" ? "Video model setup" : "Picture model setup"} value={value ?? ""} disabled={props.disabled || busy} onChange={(e) => void pick(e.target.value)}>
          <option value="">None: I choose the service and model myself</option>
          {offered.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({RATING_NAMES[s.contentRating].toLowerCase()}{s.status === "approved" ? "" : ", not approved"})
            </option>
          ))}
        </select>
      </label>
      {current ? (
        <p style={muted}>
          {providerName(current.provider)}, {current.modelId}
          {current.loras.length > 0 ? `, with ${current.loras.map((l) => `${l.name ?? "a removed LoRA"} at ${strengthText(l.strength)}`).join(" and ")}` : ""}.
          {current.status !== "approved" ? " This setup is no longer approved." : ""}
        </p>
      ) : offered.length === 0 ? (
        <p style={muted}>No approved {kind === "video" ? "video" : "picture"} setups yet. An owner or admin can approve one on the Model setups tab.</p>
      ) : (
        <p style={muted}>Pick a saved setup to fill in the service and model for you.</p>
      )}
      {error ? <div style={errorBox} role="alert">{error}</div> : null}
    </div>
  );
}
