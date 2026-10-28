// Paperclip render worker: what a composition may contain, checked before
// anything touches the disk or a browser. Pure functions only, so
// test/composition.test.mjs can hold every rule without a browser.
//
// A composition arrives as a flat list of { path, contentBase64 } files. The
// worker writes them into a fresh per-job directory itself (no archive is ever
// unpacked, so there is no symlink or "zip slip" path to worry about), and only
// after every rule below has passed.

export class CompositionError extends Error {
  /** @param {string} code  machine-readable reason @param {string} message  plain sentence for the person or agent */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CompositionError";
    this.code = code;
    this.details = details;
  }
}

/** File types a composition may carry. Text types are also scanned for remote addresses. */
export const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".vtt", ".srt"]);
export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif",
  ".mp4", ".webm", ".mov",
  ".mp3", ".wav", ".ogg", ".m4a", ".aac",
  ".woff", ".woff2", ".ttf", ".otf",
]);

export const DEFAULT_COMPOSITION_LIMITS = Object.freeze({
  maxFiles: 300,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxPathLength: 200,
  maxDepth: 8,
});

const SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function extensionOf(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/**
 * A relative path inside the composition, or a CompositionError. No absolute
 * paths, no "." / ".." segments, no hidden files, no backslashes, only plain
 * ASCII names: the path is joined under the job directory as-is.
 */
export function normalizeCompositionPath(raw, limits = DEFAULT_COMPOSITION_LIMITS) {
  if (typeof raw !== "string" || raw.length === 0) throw new CompositionError("bad_path", "Every file needs a path.");
  if (raw.length > limits.maxPathLength) throw new CompositionError("bad_path", `The path "${raw.slice(0, 60)}..." is too long.`);
  if (raw.includes("\\") || raw.includes("\0")) throw new CompositionError("bad_path", `The path "${raw}" has a character that is not allowed.`);
  if (raw.startsWith("/")) throw new CompositionError("bad_path", `The path "${raw}" must be relative to the composition folder.`);
  const segments = raw.split("/");
  if (segments.length > limits.maxDepth) throw new CompositionError("bad_path", `The path "${raw}" has too many folders.`);
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new CompositionError(
        "bad_path",
        `The path "${raw}" is not allowed: use letters, digits, "-", "_" and "." only, no hidden files, no "..".`,
      );
    }
  }
  const ext = extensionOf(raw);
  if (!TEXT_EXTENSIONS.has(ext) && !BINARY_EXTENSIONS.has(ext)) {
    throw new CompositionError("bad_type", `The file "${raw}" has a type the renderer does not take (${ext || "no extension"}).`);
  }
  return raw;
}

/**
 * Checks the whole file list and decodes it. Returns { entry, files } with
 * each file's bytes, or throws a CompositionError naming the first problem.
 */
export function validateComposition(input, limits = DEFAULT_COMPOSITION_LIMITS) {
  if (!input || typeof input !== "object") throw new CompositionError("bad_request", "The composition is missing.");
  const entry = normalizeCompositionPath(typeof input.entry === "string" && input.entry ? input.entry : "index.html", limits);
  if (![".html", ".htm"].includes(extensionOf(entry))) throw new CompositionError("bad_entry", "The composition's entry file must be an .html file.");
  const list = input.files;
  if (!Array.isArray(list) || list.length === 0) throw new CompositionError("bad_request", "The composition has no files.");
  if (list.length > limits.maxFiles) throw new CompositionError("too_many_files", `A composition may have at most ${limits.maxFiles} files.`);

  const seen = new Set();
  const files = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") throw new CompositionError("bad_request", "Every file must be an object with a path and contentBase64.");
    const path = normalizeCompositionPath(item.path, limits);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new CompositionError("duplicate_path", `The file "${path}" is listed twice.`);
    seen.add(key);
    if (typeof item.contentBase64 !== "string" || !BASE64_PATTERN.test(item.contentBase64)) {
      throw new CompositionError("bad_content", `The file "${path}" is not valid base64.`);
    }
    const bytes = Buffer.from(item.contentBase64, "base64");
    if (bytes.length > limits.maxFileBytes) throw new CompositionError("file_too_large", `The file "${path}" is larger than ${limits.maxFileBytes} bytes.`);
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new CompositionError("too_large", `The composition is larger than ${limits.maxTotalBytes} bytes in total.`);
    files.push({ path, bytes, text: TEXT_EXTENSIONS.has(extensionOf(path)) });
  }
  if (!seen.has(entry.toLowerCase())) throw new CompositionError("bad_entry", `The entry file "${entry}" is not among the files.`);
  return { entry, files };
}

// HTML comments, and opening tags (quoted attribute values may hold ">").
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const OPENING_TAG_PATTERN = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/g;
const TIMING_ATTRIBUTE_PATTERNS = {
  "data-start": /\sdata-start\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  "data-duration": /\sdata-duration\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
};

function timingAttribute(tag, name) {
  const match = TIMING_ATTRIBUTE_PATTERNS[name].exec(tag);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim().replace(/s$/i, "");
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * How long a composition says it runs, in seconds, read from its entry HTML:
 * the latest `data-start` + `data-duration` of any timed element, the root's
 * `data-duration` included; null when it names no length. Same rule as
 * Paperclip's estimateCompositionSeconds (packages/shared/src/code-renders.ts):
 * a job whose composition is longer than it may be is refused before any
 * browser starts, instead of rendering for the whole time limit first.
 */
export function compositionLengthSeconds(html) {
  let longest = null;
  for (const tag of String(html).replace(HTML_COMMENT_PATTERN, "").match(OPENING_TAG_PATTERN) ?? []) {
    const duration = timingAttribute(tag, "data-duration");
    if (duration === null) continue;
    const end = (timingAttribute(tag, "data-start") ?? 0) + duration;
    if (longest === null || end > longest) longest = end;
  }
  return longest;
}

/** Encoder rounding allowed when a length is compared with the limit. */
export const DURATION_SLACK_SECONDS = 0.5;

/**
 * Refuses (CompositionError "too_long") a composition whose entry file says
 * it runs longer than `maxSeconds`. Returns the length it names, or null.
 */
export function assertCompositionLength(entry, files, maxSeconds) {
  const file = files.find((f) => f.path === entry) ?? files.find((f) => f.path.toLowerCase() === entry.toLowerCase());
  if (!file) return null;
  const seconds = compositionLengthSeconds(file.bytes.toString("utf8"));
  if (seconds !== null && seconds > maxSeconds + DURATION_SLACK_SECONDS) {
    throw new CompositionError(
      "too_long",
      `The composition runs ${seconds} seconds (its data-start/data-duration), more than the ${maxSeconds} seconds allowed for this job. ` +
        "Make it shorter, or ask for a render of its real length.",
      { compositionSeconds: seconds, maxSeconds },
    );
  }
  return seconds;
}

/** XML namespace names look like addresses but are never fetched. */
const NAMESPACE_URIS = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/1998/Math/MathML",
]);

const ABSOLUTE_URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'`()<>\\]+/gi;
// Protocol-relative addresses ("//host/x") only where a browser would load
// them: an attribute value, a CSS url() or an @import. A bare "//" is far more
// often a JavaScript comment than an address.
const PROTOCOL_RELATIVE_PATTERNS = [
  /\b(?:src|href|srcset|poster|data|action|formaction)\s*=\s*["']\s*(\/\/[^"'\s]+)/gi,
  /url\(\s*["']?\s*(\/\/[^"')\s]+)/gi,
  /@import\s+["'](\/\/[^"']+)/gi,
];

/**
 * Remote addresses a composition names. The container has no route out, so
 * such a load would only fail mid-render; refusing up front gives the agent a
 * plain reason. Media Studio files are sent with the job as local files.
 */
export function findRemoteReferences(text, limit = 20) {
  const found = new Set();
  for (const match of text.matchAll(ABSOLUTE_URL_PATTERN)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (NAMESPACE_URIS.has(url)) continue;
    found.add(url);
    if (found.size >= limit) return [...found];
  }
  for (const pattern of PROTOCOL_RELATIVE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.add(match[1]);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

/**
 * Library addresses the worker can serve from its own image instead of the
 * network. Only GSAP's jsDelivr builds, and only when the operator built the
 * image with GSAP included (see the Dockerfile's WITH_GSAP argument and
 * THIRD_PARTY_NOTICES.md): its licence is not an open-source one, so it is
 * off unless chosen.
 */
const GSAP_CDN_PATTERN = /https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[0-9][0-9.]*\/dist\/([A-Za-z0-9]+(?:\.min)?\.js)/g;
export const VENDOR_PREFIX = "_paperclip_vendor";

/**
 * Rewrites known library addresses to the local vendor copy. `available(file)`
 * says whether the image carries that file. Returns the new text and the files
 * that must be copied next to the composition.
 */
export function rewriteVendoredScripts(text, available) {
  const used = new Set();
  const rewritten = text.replace(GSAP_CDN_PATTERN, (whole, file) => {
    if (!available(`gsap/${file}`)) return whole;
    used.add(`gsap/${file}`);
    return `${VENDOR_PREFIX}/gsap/${file}`;
  });
  return { text: rewritten, used: [...used] };
}

/**
 * Applies the vendor rewrite to every text file, then refuses the composition
 * if any remote address is left. Returns the files (possibly rewritten) and
 * the vendor files to copy in.
 */
export function prepareCompositionFiles(files, available = () => false) {
  const vendor = new Set();
  const remote = [];
  const prepared = files.map((file) => {
    if (!file.text) return file;
    const { text, used } = rewriteVendoredScripts(file.bytes.toString("utf8"), available);
    for (const v of used) vendor.add(v);
    for (const url of findRemoteReferences(text)) remote.push({ path: file.path, url });
    return used.length > 0 ? { ...file, bytes: Buffer.from(text, "utf8") } : file;
  });
  if (remote.length > 0) {
    const shown = remote.slice(0, 5).map((r) => `${r.url} (in ${r.path})`).join(", ");
    throw new CompositionError(
      "remote_urls",
      `The composition loads files from the internet, which the renderer cannot reach: ${shown}. Send every picture, font, sound and script with the job instead (Media Studio files can be attached as assets).`,
      { urls: remote.slice(0, 20) },
    );
  }
  return { files: prepared, vendor: [...vendor] };
}
