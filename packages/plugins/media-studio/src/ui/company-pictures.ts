import { useCallback, useEffect, useRef, useState } from "react";
import { listCompanyPicturesPage } from "./anchor-helpers.js";

type Picture = { fileId: string; title: string };

/**
 * The company's pictures for a "Pick from Files" list: the newest page first,
 * a name search, and "Load more". The search words shown (`query`) always match
 * the list on screen, so "Load more" never mixes two searches.
 */
export function useCompanyPictures(companyId: string, enabled: boolean) {
  const [pictures, setPictures] = useState<Picture[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const load = useCallback(
    async (opts: { search?: string; cursor?: string | null } = {}) => {
      setBusy(true);
      setError(null);
      try {
        const page = await listCompanyPicturesPage(companyId, opts);
        setPictures((prev) => {
          if (!opts.cursor || !prev) return page.pictures;
          const have = new Set(prev.map((p) => p.fileId));
          return [...prev, ...page.pictures.filter((p) => !have.has(p.fileId))];
        });
        setNextCursor(page.nextCursor);
        setQuery((opts.search ?? "").trim());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPictures((prev) => prev ?? []);
      } finally {
        setBusy(false);
      }
    },
    [companyId],
  );

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void load();
  }, [enabled, load]);

  return {
    pictures,
    query,
    busy,
    error,
    hasMore: nextCursor !== null,
    search: (words: string) => load({ search: words }),
    loadMore: () => load({ search: query, cursor: nextCursor }),
  };
}
