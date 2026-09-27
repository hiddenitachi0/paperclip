import { useCallback, useEffect, useState } from "react";
import type { PluginCompanySettingsPageProps, PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

// The plugin UI is served as a standalone ES module, so it must not import from
// sibling plugin files (only bare specifiers resolve). Keep these in sync with
// manifest.ts / providers.ts.
const PLUGIN_ID = "paperclip.media-studio";
const ACTION_GENERATE = "generate";
const PROVIDER = "media-studio";
const ACTION_LOOKS_LIST = "looks.list";
const ACTION_LOOKS_SAVE = "looks.save";
const ACTION_LOOKS_DELETE = "looks.delete";

type GenerationResult = {
  provider: string;
  contentType: string;
  imageUrl?: string;
  imageDataUrl?: string;
  meta?: Record<string, unknown>;
};

type WorkProduct = {
  id: string;
  title: string;
  provider: string;
  url: string | null;
  status: string;
  reviewState: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
};

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  }).then(async (res) => {
    if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`);
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  });
}

function imageSrc(wp: WorkProduct): string | null {
  if (wp.url) return wp.url;
  const dataUrl = wp.metadata?.imageDataUrl;
  return typeof dataUrl === "string" ? dataUrl : null;
}

const STATUS_TONE: Record<string, { bg: string; fg: string; label: string }> = {
  ready_for_review: { bg: "#fff4e6", fg: "#b45309", label: "Needs review" },
  approved: { bg: "#e6fcf5", fg: "#087f5b", label: "Approved" },
  changes_requested: { bg: "#fff0f6", fg: "#a61e4d", label: "Changes requested" },
  merged: { bg: "#e7f5ff", fg: "#1971c2", label: "Posted" },
};

export function MediaStudioIssueTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const companyId = context.companyId;
  const generate = usePluginAction(ACTION_GENERATE);

  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<GenerationResult | null>(null);
  const [items, setItems] = useState<WorkProduct[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await hostFetchJson<WorkProduct[]>(`/api/issues/${issueId}/work-products`);
      setItems(all.filter((w) => w.provider === PROVIDER));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [issueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const onGenerate = () =>
    run("generate", async () => {
      if (!prompt.trim()) throw new Error("Enter a prompt first.");
      const result = (await generate({ prompt })) as GenerationResult;
      setPreview(result);
    });

  const onSubmit = () =>
    run("submit", async () => {
      if (!preview || !companyId) throw new Error("Generate a preview first.");
      const title = prompt.trim().slice(0, 80) || "Generated image";
      // 1) File the board approval, linked to this issue (surfaces in the Now view's Needs-you lane).
      const approval = await hostFetchJson<{ id: string }>(
        `/api/companies/${companyId}/approvals`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "request_board_approval",
            payload: { title: `Approve image: ${title}`, summary: prompt.trim() },
            issueIds: [issueId],
          }),
        },
      );
      // 2) Save the work product in a review state, linking the approval.
      await hostFetchJson(`/api/issues/${issueId}/work-products`, {
        method: "POST",
        body: JSON.stringify({
          type: "artifact",
          provider: PROVIDER,
          title,
          url: preview.imageUrl ?? null,
          status: "ready_for_review",
          reviewState: "needs_board_review",
          summary: prompt.trim(),
          metadata: {
            prompt: prompt.trim(),
            generatedBy: preview.provider,
            contentType: preview.contentType,
            imageDataUrl: preview.imageDataUrl ?? null,
            approvalId: approval.id,
          },
        }),
      });
      setPreview(null);
      await load();
    });

  const approvalIdOf = (wp: WorkProduct) =>
    typeof wp.metadata?.approvalId === "string" ? (wp.metadata.approvalId as string) : null;

  const onApprove = (wp: WorkProduct) =>
    run(`approve-${wp.id}`, async () => {
      const approvalId = approvalIdOf(wp);
      if (approvalId) await hostFetchJson(`/api/approvals/${approvalId}/approve`, { method: "POST", body: "{}" });
      await hostFetchJson(`/api/work-products/${wp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved", reviewState: "approved" }),
      });
      await load();
    });

  const onRequestChanges = (wp: WorkProduct) =>
    run(`changes-${wp.id}`, async () => {
      const approvalId = approvalIdOf(wp);
      if (approvalId)
        await hostFetchJson(`/api/approvals/${approvalId}/request-revision`, { method: "POST", body: "{}" });
      await hostFetchJson(`/api/work-products/${wp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "changes_requested", reviewState: "changes_requested" }),
      });
      await load();
    });

  const onRegenerate = (wp: WorkProduct) => {
    const p = typeof wp.metadata?.prompt === "string" ? (wp.metadata.prompt as string) : "";
    setPrompt(p);
    setPreview(null);
    setError(null);
  };

  // The approval gate in action: only an approved image can be posted.
  const onPost = (wp: WorkProduct) =>
    run(`post-${wp.id}`, async () => {
      const src = imageSrc(wp);
      const body = src
        ? `Approved media: **${wp.title}**\n\n![${wp.title}](${src})`
        : `Approved media: **${wp.title}**`;
      await hostFetchJson(`/api/issues/${issueId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      await hostFetchJson(`/api/work-products/${wp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "merged", isPrimary: true }),
      });
      await load();
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 13 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Media Studio</div>
        <div style={{ color: "#868e96" }}>
          Generate an image, then require a board approval before it can be posted.
        </div>
      </div>

      {error ? (
        <div style={{ background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8 }}>{error}</div>
      ) : null}

      {/* Generate */}
      <div style={{ border: "1px solid #e9ecef", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image to generate…"
          rows={3}
          style={{ width: "100%", resize: "vertical", padding: 8, borderRadius: 8, border: "1px solid #ced4da", fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={onGenerate} disabled={busy === "generate"} style={primaryBtn}>
            {busy === "generate" ? "Generating…" : "Generate"}
          </button>
          {preview ? (
            <button type="button" onClick={onSubmit} disabled={busy === "submit"} style={secondaryBtn}>
              {busy === "submit" ? "Submitting…" : "Submit for approval"}
            </button>
          ) : null}
        </div>
        {preview ? (
          <img
            src={preview.imageUrl ?? preview.imageDataUrl}
            alt="preview"
            style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #e9ecef" }}
          />
        ) : null}
      </div>

      {/* Existing media + approval gate */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 600 }}>Media ({items.length})</div>
        {items.length === 0 ? (
          <div style={{ color: "#868e96" }}>No generated media yet.</div>
        ) : (
          items.map((wp) => {
            const tone = STATUS_TONE[wp.status] ?? { bg: "#f1f3f5", fg: "#495057", label: wp.status };
            const src = imageSrc(wp);
            return (
              <div key={wp.id} style={{ border: "1px solid #e9ecef", borderRadius: 10, padding: 12, display: "flex", gap: 12 }}>
                {src ? (
                  <img src={src} alt={wp.title} style={{ width: 120, height: 90, objectFit: "cover", borderRadius: 8, border: "1px solid #e9ecef" }} />
                ) : null}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wp.title}</span>
                    <span style={{ background: tone.bg, color: tone.fg, borderRadius: 999, padding: "2px 8px", fontSize: 11, whiteSpace: "nowrap" }}>{tone.label}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {wp.status === "ready_for_review" ? (
                      <>
                        <button type="button" onClick={() => onApprove(wp)} disabled={busy === `approve-${wp.id}`} style={approveBtn}>Approve</button>
                        <button type="button" onClick={() => onRequestChanges(wp)} disabled={busy === `changes-${wp.id}`} style={dangerBtn}>Request changes</button>
                        <button type="button" onClick={() => onRegenerate(wp)} style={ghostBtn}>Regenerate</button>
                      </>
                    ) : wp.status === "approved" ? (
                      <>
                        <button type="button" onClick={() => onPost(wp)} disabled={busy === `post-${wp.id}`} style={primaryBtn}>Post</button>
                        <button type="button" onClick={() => onRegenerate(wp)} style={ghostBtn}>Regenerate</button>
                      </>
                    ) : wp.status === "changes_requested" ? (
                      <button type="button" onClick={() => onRegenerate(wp)} style={ghostBtn}>Regenerate</button>
                    ) : (
                      <span style={{ color: "#868e96" }}>Posted to the issue thread.</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div style={{ color: "#adb5bd", fontSize: 11 }}>Plugin: {PLUGIN_ID}</div>
    </div>
  );
}

// ─── Company settings → Media Studio looks ───────────────────────────────────

type Look = {
  id: string;
  name: string;
  style: string;
  model: string | null;
  seed: number | null;
  referenceFileIds: string[];
  updatedAt: string;
};

type LooksResponse = { looks: Look[]; canManage?: boolean; maxReferenceFiles?: number };

type CompanyImage = { fileId: string; title: string; src: string };

const ATTACHMENT_PATH = /^\/api\/attachments\/([0-9a-f-]{36})\/content$/i;

function fileContentPath(fileId: string) {
  return `/api/attachments/${fileId}/content`;
}

type LookDraft = { id: string | null; name: string; style: string; model: string; seed: string; referenceFileIds: string[] };

const EMPTY_DRAFT: LookDraft = { id: null, name: "", style: "", model: "", seed: "", referenceFileIds: [] };

export function MediaStudioLooksPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const listLooks = usePluginAction(ACTION_LOOKS_LIST);
  const saveLook = usePluginAction(ACTION_LOOKS_SAVE);
  const deleteLook = usePluginAction(ACTION_LOOKS_DELETE);

  const [looks, setLooks] = useState<Look[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [maxRefs, setMaxRefs] = useState(4);
  const [draft, setDraft] = useState<LookDraft | null>(null);
  const [images, setImages] = useState<CompanyImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await listLooks({})) as LooksResponse;
      setLooks(res.looks ?? []);
      setCanManage(res.canManage === true);
      if (typeof res.maxReferenceFiles === "number") setMaxRefs(res.maxReferenceFiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listLooks]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadImages = useCallback(async () => {
    if (!companyId || images) return;
    try {
      const res = await hostFetchJson<{ artifacts?: Array<{ title: string; contentPath: string | null; mediaKind: string }> }>(
        `/api/companies/${companyId}/artifacts?kind=image&limit=100`,
      );
      const found: CompanyImage[] = [];
      for (const artifact of res.artifacts ?? []) {
        const match = artifact.contentPath ? ATTACHMENT_PATH.exec(artifact.contentPath) : null;
        if (!match || found.some((img) => img.fileId === match[1])) continue;
        found.push({ fileId: match[1], title: artifact.title, src: artifact.contentPath! });
      }
      setImages(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImages([]);
    }
  }, [companyId, images]);

  const startEdit = (look: Look | null) => {
    setError(null);
    setDraft(
      look
        ? {
            id: look.id,
            name: look.name,
            style: look.style,
            model: look.model ?? "",
            seed: look.seed === null ? "" : String(look.seed),
            referenceFileIds: [...look.referenceFileIds],
          }
        : { ...EMPTY_DRAFT },
    );
    void loadImages();
  };

  const toggleRef = (fileId: string) => {
    setDraft((d) => {
      if (!d) return d;
      if (d.referenceFileIds.includes(fileId)) {
        return { ...d, referenceFileIds: d.referenceFileIds.filter((id) => id !== fileId) };
      }
      if (d.referenceFileIds.length >= maxRefs) return d;
      return { ...d, referenceFileIds: [...d.referenceFileIds, fileId] };
    });
  };

  const onSave = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await saveLook({
        id: draft.id,
        name: draft.name,
        style: draft.style,
        model: draft.model,
        seed: draft.seed.trim() === "" ? null : draft.seed.trim(),
        referenceFileIds: draft.referenceFileIds,
      })) as LooksResponse;
      setLooks(res.looks ?? []);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (look: Look) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete the look "${look.name}"? Pictures already made with it are kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await deleteLook({ id: look.id })) as LooksResponse;
      setLooks(res.looks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 13, maxWidth: 820 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 16 }}>Media Studio looks</div>
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          A look keeps pictures consistent: its style words are added to every picture made with it, and it can fix the
          seed and use up to {maxRefs} reference pictures from your Files to keep the same person, product or style.
          Agents can use looks by name (for example "make a banner in our catalogue look"), but only the company's owner
          or an admin can change them.
        </div>
      </div>

      {error ? <div style={errorBox}>{error}</div> : null}

      {looks.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No looks are saved yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {looks.map((look) => (
            <div key={look.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>{look.name}</span>
                {canManage ? (
                  <span style={{ display: "flex", gap: 8 }}>
                    <button type="button" style={ghostBtn} disabled={busy} onClick={() => startEdit(look)}>Edit</button>
                    <button type="button" style={ghostBtn} disabled={busy} onClick={() => void onDelete(look)}>Delete</button>
                  </span>
                ) : null}
              </div>
              {look.style ? <div style={{ whiteSpace: "pre-wrap" }}>{look.style}</div> : <div style={{ opacity: 0.6 }}>No style words.</div>}
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                {look.seed !== null ? `Fixed seed ${look.seed}` : "New seed each time"}
                {look.model ? ` · Model ${look.model}` : ""}
              </div>
              {look.referenceFileIds.length > 0 ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {look.referenceFileIds.map((id) => (
                    <img key={id} src={fileContentPath(id)} alt="Reference picture" style={thumb} />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canManage && !draft ? (
        <div>
          <button type="button" style={primaryBtn} onClick={() => startEdit(null)}>Add a look</button>
        </div>
      ) : null}
      {!canManage ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>Only the company's owner or an admin can add or change looks.</div>
      ) : null}

      {draft ? (
        <div style={{ ...card, gap: 10 }}>
          <div style={{ fontWeight: 600 }}>{draft.id ? "Edit look" : "New look"}</div>
          <label style={field}>
            <span>Name</span>
            <input value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={input} placeholder="Catalogue" />
          </label>
          <label style={field}>
            <span>Style words added to every picture</span>
            <textarea
              value={draft.style}
              maxLength={1000}
              rows={3}
              onChange={(e) => setDraft({ ...draft, style: e.target.value })}
              style={{ ...input, resize: "vertical" }}
              placeholder="Soft daylight, Scandinavian living room, light oak and linen, photographed at eye level"
            />
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={{ ...field, flex: "1 1 160px" }}>
              <span>Fixed seed (optional)</span>
              <input value={draft.seed} inputMode="numeric" onChange={(e) => setDraft({ ...draft, seed: e.target.value.replace(/[^0-9]/g, "") })} style={input} placeholder="Leave empty for a new one each time" />
            </label>
            <label style={{ ...field, flex: "2 1 240px" }}>
              <span>Model (optional)</span>
              <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} style={input} placeholder="Leave empty to use the normal one" />
            </label>
          </div>
          <div style={field}>
            <span>Reference pictures ({draft.referenceFileIds.length} of {maxRefs} picked)</span>
            {images === null ? (
              <div style={{ opacity: 0.7 }}>Loading your pictures…</div>
            ) : images.length === 0 ? (
              <div style={{ opacity: 0.7 }}>There are no pictures in Files yet.</div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 260, overflowY: "auto" }}>
                {images.map((img) => {
                  const picked = draft.referenceFileIds.includes(img.fileId);
                  return (
                    <button
                      key={img.fileId}
                      type="button"
                      title={img.title}
                      aria-pressed={picked}
                      onClick={() => toggleRef(img.fileId)}
                      style={{ padding: 0, border: picked ? "3px solid #1971c2" : "3px solid transparent", borderRadius: 8, background: "none", cursor: "pointer" }}
                    >
                      <img src={img.src} alt={img.title} style={thumb} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void onSave()}>{busy ? "Saving…" : "Save look"}</button>
            <button type="button" style={ghostBtn} disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8 };
const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const thumb: React.CSSProperties = { width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" };

const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const approveBtn: React.CSSProperties = { ...baseBtn, background: "#087f5b", color: "#fff" };
const dangerBtn: React.CSSProperties = { ...baseBtn, background: "#f03e3e", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
