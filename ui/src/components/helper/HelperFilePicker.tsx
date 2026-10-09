import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HELPER_PICTURE_MAX_BYTES, HELPER_PICTURE_TYPES } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { artifactsApi } from "../../api/artifacts";
import { queryKeys } from "../../lib/queryKeys";

/**
 * A small "pick from Files" list for the Ask panel: this company's most
 * recent pictures (the company Files list, pictures only). Picking one only
 * names it; the server reads it from Files for the one question and checks
 * it belongs to this company.
 */
export function HelperFilePicker({
  companyId,
  onPick,
  onClose,
}: {
  companyId: string;
  onPick: (file: { attachmentId: string; name: string; thumbnailPath: string | null }) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = useQuery({
    queryKey: [...queryKeys.artifacts.list(companyId, "image", q), "helper-picker"],
    queryFn: () => artifactsApi.list(companyId, { kind: "image", q: q || undefined, limit: 24 }),
    staleTime: 30_000,
  });
  const files = (query.data?.artifacts ?? []).filter(
    (a) =>
      a.source === "attachment" &&
      a.id.startsWith("attachment:") &&
      (HELPER_PICTURE_TYPES as readonly string[]).includes(String(a.contentType ?? "").toLowerCase()) &&
      (a.byteSize == null || a.byteSize <= HELPER_PICTURE_MAX_BYTES),
  );
  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="helper-file-picker">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          placeholder="Search the company's pictures…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search the company's pictures"
        />
        <button type="button" className="text-xs text-muted-foreground underline" onClick={onClose}>
          Close
        </button>
      </div>
      {query.isLoading ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading pictures…
        </div>
      ) : null}
      {query.error ? <p className="text-xs text-destructive">Could not load the company's pictures.</p> : null}
      {!query.isLoading && !query.error && files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No pictures (PNG, JPEG, WebP or GIF up to 5 MB) in this company's Files yet.</p>
      ) : null}
      <div className="grid max-h-48 grid-cols-4 gap-1 overflow-y-auto">
        {files.map((file) => {
          const attachmentId = file.id.slice("attachment:".length);
          return (
            <button
              key={file.id}
              type="button"
              title={file.title}
              className="aspect-square overflow-hidden rounded border border-border hover:ring-2 hover:ring-primary"
              onClick={() => onPick({ attachmentId, name: file.title, thumbnailPath: file.thumbnailPath ?? null })}
              data-testid="helper-file-option"
            >
              {file.thumbnailPath ? (
                <img src={file.thumbnailPath} alt={file.title} className="h-full w-full object-cover" />
              ) : (
                <span className="block p-1 text-[10px]">{file.title}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
