import { useCallback, useEffect, useState } from "react";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

// The plugin UI is served as a standalone ES module, so it must not import from
// sibling plugin files (only bare specifiers resolve). Keep these in sync with
// manifest.ts / providers.ts.
const PLUGIN_ID = "paperclip.media-studio";
const ACTION_GENERATE = "generate";
const PROVIDER = "media-studio";

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

const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const approveBtn: React.CSSProperties = { ...baseBtn, background: "#087f5b", color: "#fff" };
const dangerBtn: React.CSSProperties = { ...baseBtn, background: "#f03e3e", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
