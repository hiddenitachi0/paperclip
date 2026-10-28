import { useState } from "react";
import { LoraLibraryPanel } from "./lora-library-panel.js";
import { ModelSetupsPanel } from "./model-setups-panel.js";

// Media Studio's "Model setups" tab: the saved model setups and, next to them,
// the LoRA library they are built from.

type Section = "setups" | "loras";

const sectionBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid #ced4da", cursor: "pointer", fontSize: 13, fontWeight: 600, background: "transparent", color: "#495057" };
const sectionBtnActive: React.CSSProperties = { ...sectionBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };

export function ModelSetupsTab({ companyId }: { companyId: string | null }) {
  const [section, setSection] = useState<Section>("setups");
  if (!companyId) return <p style={{ fontSize: 13 }}>Open this page from inside a company to see its model setups.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div role="group" aria-label="Model setups sections" style={{ display: "flex", gap: 8 }}>
        <button type="button" aria-pressed={section === "setups"} style={section === "setups" ? sectionBtnActive : sectionBtn} onClick={() => setSection("setups")}>
          Setups
        </button>
        <button type="button" aria-pressed={section === "loras"} style={section === "loras" ? sectionBtnActive : sectionBtn} onClick={() => setSection("loras")}>
          LoRA library
        </button>
      </div>
      {section === "setups" ? <ModelSetupsPanel companyId={companyId} /> : <LoraLibraryPanel companyId={companyId} />}
    </div>
  );
}
