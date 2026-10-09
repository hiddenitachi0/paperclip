import { useEffect, useState, type ReactNode } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { hostFetchJson } from "./anchor-helpers.js";
import { IdentitySettingsPanel } from "./identities-panel.js";

// Media Studio's Settings tab. Three parts:
//   1. This company's own service keys (Sogni, Fal.ai, Higgsfield): the
//      company's owner or admin picks them from the company's Secrets. A
//      service without the company's own key uses the instance's key.
//   2. Identity settings (the analysis model, Hugging Face), for this company.
//   3. The instance's defaults, for the instance admin only (they apply to
//      every company that has not set its own).
// The browser only ever sees secret ids and names, never a key.

export const ACTION_SERVICE_KEYS_GET = "serviceKeys.get";
export const ACTION_SERVICE_KEYS_SAVE = "serviceKeys.save";

type Service = "sogni" | "fal" | "higgsfield";
export type ServiceKeyView = {
  service: Service;
  label: string;
  help: string;
  source: "company" | "instance" | "none";
  sourceText: string;
  companySecretId: string | null;
};
type Secret = { id: string; name: string };

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const help: React.CSSProperties = { fontSize: 12, opacity: 0.75 };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const okBox: React.CSSProperties = { background: "#e6fcf5", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const primaryBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 13, fontWeight: 600, background: "#1971c2", color: "#fff" };
const badge = (source: ServiceKeyView["source"]): React.CSSProperties => ({
  alignSelf: "flex-start",
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 999,
  background: source === "company" ? "#e6fcf5" : source === "instance" ? "#e7f5ff" : "#fff4e6",
  color: source === "company" ? "#087f5b" : source === "instance" ? "#1971c2" : "#d9480f",
});

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "Which key is used for this company" for each picture service, and the company's own picks. */
export function ServiceKeysPanel({ companyId }: { companyId: string }) {
  const getKeys = usePluginAction(ACTION_SERVICE_KEYS_GET);
  const saveKeys = usePluginAction(ACTION_SERVICE_KEYS_SAVE);
  const [keys, setKeys] = useState<ServiceKeyView[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [picks, setPicks] = useState<Record<Service, string>>({ sogni: "", fal: "", higgsfield: "" });
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = (list: ServiceKeyView[]) => {
    setKeys(list);
    setPicks({
      sogni: list.find((k) => k.service === "sogni")?.companySecretId ?? "",
      fal: list.find((k) => k.service === "fal")?.companySecretId ?? "",
      higgsfield: list.find((k) => k.service === "higgsfield")?.companySecretId ?? "",
    });
  };

  useEffect(() => {
    getKeys({})
      .then((r) => {
        const res = r as { keys: ServiceKeyView[]; canManage: boolean };
        apply(res.keys);
        setCanManage(res.canManage);
      })
      .catch((e) => setError(errText(e)));
    hostFetchJson<Secret[]>(`/api/companies/${companyId}/secrets`).then((list) => setSecrets(Array.isArray(list) ? list : [])).catch(() => setSecrets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  if (!keys) return error ? <div style={errorBox}>{error}</div> : <div style={help}>Loading the company's keys…</div>;

  const onSave = async () => {
    setError(null);
    setSaved(false);
    try {
      const res = (await saveKeys({ sogni: picks.sogni || null, fal: picks.fal || null, higgsfield: picks.higgsfield || null })) as { keys: ServiceKeyView[] };
      apply(res.keys);
      setSaved(true);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div style={card} aria-label="This company's service keys">
      <strong>This company's service keys</strong>
      <div style={help}>
        The picture services Media Studio uses are paid with these keys. Pick this company's own key for a service to have that service bill
        this company's account. A service without the company's own key uses the instance's key, which the instance admin set for everyone.
        Keys come from the company's Secrets (Company settings &gt; Secrets); they are read on the server each time and never shown here.
        {canManage ? "" : " Only the company's owner or an admin can change them."}
      </div>
      {keys.map((k) => (
        <label key={k.service} style={field}>
          <span>{k.label} key</span>
          <span style={badge(k.source)} data-testid={`key-source-${k.service}`}>{k.sourceText}</span>
          <select
            style={input}
            disabled={!canManage}
            value={picks[k.service]}
            onChange={(e) => setPicks({ ...picks, [k.service]: e.target.value })}
            aria-label={`${k.label} key`}
          >
            <option value="">{k.source === "none" && !picks[k.service] ? "No key" : "Use the instance's key"}</option>
            {secrets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <span style={help}>{k.help}</span>
        </label>
      ))}
      {error ? <div style={errorBox}>{error}</div> : null}
      {saved ? <div style={okBox}>Saved.</div> : null}
      {canManage ? (
        <div>
          <button type="button" style={primaryBtn} onClick={() => void onSave()}>Save keys</button>
        </div>
      ) : null}
    </div>
  );
}

/** The whole Settings tab. `instanceForm` is the instance-wide settings form, shown to instance admins only. */
export function MediaStudioSettingsTab({ companyId, isInstanceAdmin, instanceForm }: { companyId: string | null; isInstanceAdmin: boolean; instanceForm: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {companyId ? (
        <>
          <ServiceKeysPanel companyId={companyId} />
          <IdentitySettingsPanel companyId={companyId} />
        </>
      ) : (
        <div style={help}>Open Media Studio from inside a company to see the company's settings.</div>
      )}
      {isInstanceAdmin ? (
        <div style={card} aria-label="Instance defaults">
          <strong>Instance defaults (instance admin only)</strong>
          <div style={help}>
            These apply to every company on this Paperclip instance that has not picked its own key above: which picture service is used by
            default, the default models, and the instance's keys. A key picked here must be one of a company's Secrets, so it only works for
            that company; other companies should pick their own key above.
          </div>
          {instanceForm}
        </div>
      ) : null}
    </div>
  );
}
