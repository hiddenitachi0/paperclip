// Training a person LoRA and putting it where Sogni can use it.
//
//   1. Zip the ticked pictures (zipStore below: plain "stored" zip, no new
//      dependency).
//   2. Put the zip in Fal's storage and start fal-ai/krea-2-trainer on the
//      queue (fal.ai/models/fal-ai/krea-2-trainer/llms.txt):
//        input  {images_data_url, trigger_phrase, steps, resolution}
//        output {lora_file: {url}, config_file: {url}}
//      Fal's storage (as its own client does it):
//        POST https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3
//             {content_type, file_name} -> {upload_url, file_url}; PUT bytes to upload_url
//   3. Publish the file to a PUBLIC Hugging Face model repository (Sogni only
//      imports public Hugging Face or Civitai files):
//        GET  https://huggingface.co/api/whoami-v2                       -> {name}
//        POST https://huggingface.co/api/repos/create {type:"model", name, organization?, private:false}
//        POST https://huggingface.co/<repo>.git/info/lfs/objects/batch   (LFS upload of the file)
//        POST https://huggingface.co/api/models/<repo>/commit/main      (NDJSON: header, lfsFile, README)
//   4. Import into Sogni (POST /v1/loras/personal, sogni.ts) and attach.
//
// JSON calls go through the host's gated fetch. Raw bytes (zip, safetensors)
// go through `bytesFetch`, which only talks https to Fal's and Hugging Face's
// storage hosts and never follows a redirect: the host's fetch carries bodies
// as text, which would corrupt them (the same reason sogni.ts has
// guardedTransferFetch).

import { createHash } from "node:crypto";
import type { FetchImpl } from "./providers.js";
import { LORA_TRAINER_MODEL } from "./identity.js";

// ─── A small zip writer ──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with every file stored as is (pictures are already compressed). */
export function zipStore(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + file.bytes.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ─── Byte transfers ──────────────────────────────────────────────────────────

/** Storage hosts raw bytes may go to or come from. */
const BYTE_HOST_SUFFIXES = [".fal.media", ".fal.ai", ".fal.run", ".huggingface.co", ".hf.co", ".amazonaws.com", ".cloudfront.net", ".storage.googleapis.com", ".higgsfield.ai", ".r2.cloudflarestorage.com"];
const BYTE_HOSTS = ["fal.media", "storage.googleapis.com", "huggingface.co"];

export function assertByteTransferUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("A storage address could not be read.");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !(BYTE_HOSTS.includes(host) || BYTE_HOST_SUFFIXES.some((s) => host.endsWith(s)))) {
    throw new Error(`Media Studio does not send files to ${host || "that address"}.`);
  }
  return url;
}

/** The worker's byte fetch: platform fetch, checked address, no redirects, a time limit. */
export const guardedBytesFetch: FetchImpl = (url, init) =>
  globalThis.fetch(assertByteTransferUrl(url).toString(), { ...init, redirect: "error", signal: AbortSignal.timeout(300_000) });

// ─── Fal: storage and the trainer queue ──────────────────────────────────────

export const FAL_STORAGE_INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
export const FAL_QUEUE = "https://queue.fal.run";

function falHeaders(key: string): Record<string, string> {
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

export async function falUpload(apiFetch: FetchImpl, bytesFetch: FetchImpl, key: string, file: { bytes: Buffer; contentType: string; name: string }): Promise<string> {
  const res = await apiFetch(FAL_STORAGE_INITIATE, {
    method: "POST",
    headers: falHeaders(key),
    body: JSON.stringify({ content_type: file.contentType, file_name: file.name }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Fal.ai did not accept the key picked in Media Studio settings.");
  if (!res.ok) throw new Error(`Fal.ai's storage did not take the training pictures (error ${res.status}). Try again.`);
  const body = (await res.json()) as { upload_url?: string; file_url?: string };
  if (!body.upload_url || !body.file_url) throw new Error("Fal.ai's storage did not say where to put the training pictures.");
  assertByteTransferUrl(body.file_url);
  const put = await bytesFetch(body.upload_url, { method: "PUT", headers: { "Content-Type": file.contentType }, body: new Uint8Array(file.bytes) });
  if (!put.ok) throw new Error(`Fal.ai's storage did not take the training pictures (error ${put.status}). Try again.`);
  return body.file_url;
}

export async function falTrainerSubmit(
  apiFetch: FetchImpl,
  key: string,
  input: { zipUrl: string; triggerWord: string; steps: number },
): Promise<string> {
  const res = await apiFetch(`${FAL_QUEUE}/${LORA_TRAINER_MODEL}`, {
    method: "POST",
    headers: falHeaders(key),
    body: JSON.stringify({ images_data_url: input.zipUrl, trigger_phrase: input.triggerWord, steps: input.steps, resolution: 1024 }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Fal.ai did not accept the key picked in Media Studio settings.");
  if (!res.ok) throw new Error(`Fal.ai could not start the training (error ${res.status}).`);
  const body = (await res.json()) as { request_id?: string };
  if (!body.request_id) throw new Error("Fal.ai did not say which training it started.");
  return body.request_id;
}

export type TrainerPoll = { status: "running"; progress: string } | { status: "done"; loraUrl: string } | { status: "failed"; error: string };

export async function falTrainerPoll(apiFetch: FetchImpl, key: string, requestId: string): Promise<TrainerPoll> {
  const base = `${FAL_QUEUE}/${LORA_TRAINER_MODEL}/requests/${encodeURIComponent(requestId)}`;
  const statusRes = await apiFetch(`${base}/status`, { headers: falHeaders(key) });
  if (!statusRes.ok) {
    if (statusRes.status >= 500) return { status: "running", progress: "waiting for Fal.ai" };
    return { status: "failed", error: `Fal.ai lost track of the training (error ${statusRes.status}).` };
  }
  const status = (await statusRes.json()) as { status?: string; queue_position?: number };
  if (status.status === "IN_QUEUE") return { status: "running", progress: typeof status.queue_position === "number" ? `waiting in line (position ${status.queue_position})` : "waiting in line" };
  if (status.status === "IN_PROGRESS") return { status: "running", progress: "training" };
  if (status.status !== "COMPLETED") return { status: "failed", error: `Fal.ai stopped the training (${status.status ?? "unknown"}).` };
  const resultRes = await apiFetch(base, { headers: falHeaders(key) });
  if (!resultRes.ok) {
    let detail = "";
    try {
      const b = (await resultRes.json()) as { detail?: unknown };
      if (typeof b.detail === "string") detail = `: ${b.detail.slice(0, 200)}`;
    } catch {
      // keep it short
    }
    return { status: "failed", error: `The training did not finish${detail}.` };
  }
  const result = (await resultRes.json()) as { lora_file?: { url?: string } };
  const url = result.lora_file?.url;
  if (!url) return { status: "failed", error: "Fal.ai finished but sent no LoRA file back." };
  try {
    assertByteTransferUrl(url);
  } catch {
    return { status: "failed", error: "Fal.ai gave the LoRA file an address Media Studio does not fetch from." };
  }
  return { status: "done", loraUrl: url };
}

export async function downloadBytes(bytesFetch: FetchImpl, url: string, maxBytes = 1_500_000_000): Promise<Buffer> {
  const res = await bytesFetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`The file could not be fetched (error ${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("The file is too large.");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("The file is empty or too large.");
  return bytes;
}

// ─── Hugging Face ────────────────────────────────────────────────────────────

export const HF_BASE = "https://huggingface.co";

function hfHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

export async function hfWhoAmI(apiFetch: FetchImpl, token: string): Promise<string> {
  const res = await apiFetch(`${HF_BASE}/api/whoami-v2`, { headers: hfHeaders(token) });
  if (res.status === 401) throw new Error("Hugging Face did not accept the token picked in Media Studio's identity settings.");
  if (!res.ok) throw new Error(`Hugging Face could not be reached (error ${res.status}). Try again.`);
  const body = (await res.json()) as { name?: string };
  if (!body.name) throw new Error("Hugging Face did not say which account the token belongs to.");
  return body.name;
}

/** Publish one file to a PUBLIC model repository; returns the file's download address. */
export async function hfPublishPublic(
  apiFetch: FetchImpl,
  bytesFetch: FetchImpl,
  token: string,
  input: { namespace: string; repoName: string; fileName: string; bytes: Buffer; readme: string },
): Promise<{ repo: string; url: string }> {
  const repo = `${input.namespace}/${input.repoName}`;
  const me = await hfWhoAmI(apiFetch, token);
  const created = await apiFetch(`${HF_BASE}/api/repos/create`, {
    method: "POST",
    headers: hfHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ type: "model", name: input.repoName, ...(input.namespace !== me ? { organization: input.namespace } : {}), private: false }),
  });
  if (created.status === 401 || created.status === 403) {
    throw new Error("The Hugging Face token cannot create repositories there. It needs write access (and access to that organisation).");
  }
  if (!created.ok && created.status !== 409) throw new Error(`Hugging Face could not make the repository (error ${created.status}).`);

  const oid = createHash("sha256").update(input.bytes).digest("hex");
  const size = input.bytes.length;
  const batch = await apiFetch(`${HF_BASE}/${repo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: hfHeaders(token, { Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json" }),
    body: JSON.stringify({ operation: "upload", transfers: ["basic", "multipart"], hash_algo: "sha256", ref: { name: "main" }, objects: [{ oid, size }] }),
  });
  if (!batch.ok) throw new Error(`Hugging Face did not take the LoRA file (error ${batch.status}).`);
  const batchBody = (await batch.json()) as {
    objects?: Array<{ error?: { message?: string }; actions?: { upload?: { href: string; header?: Record<string, string> }; verify?: { href: string; header?: Record<string, string> } } }>;
  };
  const object = batchBody.objects?.[0];
  if (object?.error) throw new Error(`Hugging Face did not take the LoRA file: ${String(object.error.message ?? "").slice(0, 200)}`);
  const upload = object?.actions?.upload;
  if (upload) {
    const header = upload.header ?? {};
    const chunkSize = Number(header.chunk_size ?? 0);
    if (chunkSize > 0) {
      const partKeys = Object.keys(header).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (const key of partKeys) {
        const n = Number(key);
        const chunk = input.bytes.subarray((n - 1) * chunkSize, n * chunkSize);
        const put = await bytesFetch(header[key]!, { method: "PUT", body: new Uint8Array(chunk) });
        if (!put.ok) throw new Error(`Hugging Face's storage did not take part ${n} of the LoRA file (error ${put.status}).`);
        parts.push({ partNumber: n, etag: put.headers.get("etag") ?? "" });
      }
      const done = await apiFetch(upload.href, {
        method: "POST",
        headers: hfHeaders(token, { Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json" }),
        body: JSON.stringify({ oid, parts }),
      });
      if (!done.ok) throw new Error(`Hugging Face could not finish storing the LoRA file (error ${done.status}).`);
    } else {
      const put = await bytesFetch(upload.href, { method: "PUT", headers: { ...header, "Content-Type": "application/octet-stream" }, body: new Uint8Array(input.bytes) });
      if (!put.ok) throw new Error(`Hugging Face's storage did not take the LoRA file (error ${put.status}).`);
    }
    const verify = object?.actions?.verify;
    if (verify) {
      const ok = await apiFetch(verify.href, {
        method: "POST",
        headers: { ...hfHeaders(token), ...(verify.header ?? {}), Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ oid, size }),
      });
      if (!ok.ok) throw new Error(`Hugging Face could not check the stored LoRA file (error ${ok.status}).`);
    }
  }

  const lines = [
    { key: "header", value: { summary: `Add ${input.fileName}`, description: "Published from Paperclip Media Studio." } },
    { key: "lfsFile", value: { path: input.fileName, algo: "sha256", oid, size } },
    { key: "file", value: { path: "README.md", encoding: "base64", content: Buffer.from(input.readme, "utf8").toString("base64") } },
  ];
  const commit = await apiFetch(`${HF_BASE}/api/models/${repo}/commit/main`, {
    method: "POST",
    headers: hfHeaders(token, { "Content-Type": "application/x-ndjson" }),
    body: lines.map((l) => JSON.stringify(l)).join("\n"),
  });
  if (!commit.ok) throw new Error(`Hugging Face could not save the LoRA file in the repository (error ${commit.status}).`);
  return { repo, url: `${HF_BASE}/${repo}/resolve/main/${encodeURIComponent(input.fileName)}` };
}
