import { useEffect, useState } from "react";
import { fileContentPath } from "./anchor-helpers.js";

type Shown = "ok" | "gone" | "unshown";

/**
 * A picture kept in Files. When its preview does not load, the server is asked
 * for the file itself, and only a "not found" answer reads "No longer in Files"
 * (a picture can fail to preview and still be there).
 */
export function StoredPicture(props: { fileId: string; alt: string; style: React.CSSProperties }) {
  const [shown, setShown] = useState<Shown>("ok");
  useEffect(() => setShown("ok"), [props.fileId]);
  const onError = async () => {
    try {
      const res = await fetch(fileContentPath(props.fileId), { method: "HEAD", credentials: "include" });
      setShown(res.status === 404 || res.status === 403 ? "gone" : "unshown");
    } catch {
      setShown("unshown");
    }
  };
  if (shown === "ok") return <img src={fileContentPath(props.fileId)} alt={props.alt} style={props.style} onError={() => void onError()} />;
  return (
    <div
      role="img"
      aria-label={props.alt}
      data-picture-state={shown}
      style={{ ...props.style, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 11, padding: 4, boxSizing: "border-box", background: "rgba(128,128,128,0.12)" }}
    >
      {shown === "gone" ? "No longer in Files" : "Can't be shown right now"}
    </div>
  );
}
