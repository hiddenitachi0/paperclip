import { posix } from "node:path";
import { FileServerError } from "./errors.js";

/**
 * DUR-3997 (files on a server): path confinement. Every path a caller names
 * becomes one absolute path on the server that is the connection's base
 * folder or inside it, or it is refused. The transports never take a path
 * from anywhere else.
 */

export const FILE_SERVER_PATH_MAX_LENGTH = 1024;

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") || "/" : value;
}

/** Control characters (including line breaks) and NUL are never valid in a path. */
export function hasForbiddenPathCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The absolute path on the server for `requested`, confined under `basePath`.
 * An empty path, "." or "/" means the base folder itself. A relative path is
 * taken from the base folder; an absolute path must already be inside it.
 */
export function confineRemotePath(basePath: string, requested: string): string {
  const base = trimTrailingSlash(posix.normalize(basePath.replace(/\\/g, "/")));
  if (!base.startsWith("/")) {
    throw new FileServerError("path_outside_base", "The connection's base folder is not an absolute path.");
  }
  if (typeof requested !== "string" || requested.length > FILE_SERVER_PATH_MAX_LENGTH) {
    throw new FileServerError("path_outside_base", "The path is too long.");
  }
  if (hasForbiddenPathCharacters(requested)) {
    throw new FileServerError("path_outside_base", "The path contains characters that are not allowed.");
  }
  const cleaned = requested.trim().replace(/\\/g, "/");
  let candidate: string;
  if (cleaned === "" || cleaned === "." || cleaned === "/") {
    candidate = base;
  } else if (cleaned.startsWith("/")) {
    candidate = posix.normalize(cleaned);
  } else {
    candidate = posix.normalize(posix.join(base, cleaned));
  }
  candidate = trimTrailingSlash(candidate);
  const inside = base === "/" ? candidate.startsWith("/") : candidate === base || candidate.startsWith(`${base}/`);
  if (!inside || candidate.split("/").includes("..")) {
    throw new FileServerError("path_outside_base", `The path is outside the connection's base folder (${base}).`);
  }
  return candidate;
}

/** The path as shown to people: relative to the base folder, "/" for the base itself. */
export function displayRemotePath(basePath: string, absolutePath: string): string {
  const base = trimTrailingSlash(basePath);
  if (absolutePath === base) return "/";
  return base === "/" ? absolutePath : absolutePath.slice(base.length);
}
