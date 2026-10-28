import { useState } from "react";
import { fileContentPath } from "./anchor-helpers.js";
import { useCompanyPictures } from "./company-pictures.js";

const small: React.CSSProperties = { fontSize: 12, opacity: 0.75 };
const button: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid #a5d8ff", background: "#e7f5ff", color: "#1971c2", fontSize: 13, cursor: "pointer" };

/** The "Pick from Files" list: newest pictures first, a name search and "Load more pictures". */
export function FilesPictureList(props: { companyId: string; size: number; onPick: (fileId: string) => void }) {
  const files = useCompanyPictures(props.companyId, true);
  const [words, setWords] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <form
        style={{ display: "flex", gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void files.search(words);
        }}
      >
        <input
          aria-label="Search your pictures"
          placeholder="Search your pictures by name"
          value={words}
          maxLength={160}
          onChange={(e) => setWords(e.target.value)}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: "1px solid #ced4da", fontSize: 13 }}
        />
        <button type="submit" style={button} disabled={files.busy}>Search</button>
      </form>
      {files.error ? <div style={{ ...small, color: "#a61e4d" }}>{files.error}</div> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", maxHeight: 240, overflowY: "auto" }}>
        {files.pictures === null ? <span style={small}>Loading…</span> : null}
        {files.pictures?.length === 0 ? <span style={small}>{files.query ? "No pictures match that search." : "No pictures in Files yet."}</span> : null}
        {(files.pictures ?? []).map((p) => (
          <button key={p.fileId} type="button" title={p.title} style={{ padding: 0, border: "none", background: "none", cursor: "pointer" }} onClick={() => props.onPick(p.fileId)}>
            <img
              src={fileContentPath(p.fileId)}
              alt={p.title}
              style={{ width: props.size, height: props.size, objectFit: "cover", borderRadius: 6, display: "block", border: "1px solid rgba(128,128,128,0.35)" }}
            />
          </button>
        ))}
      </div>
      {files.hasMore ? (
        <div>
          <button type="button" style={button} disabled={files.busy} onClick={() => void files.loadMore()}>
            {files.busy ? "Loading…" : "Load more pictures"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
