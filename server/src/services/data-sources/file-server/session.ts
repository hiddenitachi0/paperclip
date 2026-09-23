import { FileServerError } from "./errors.js";

/**
 * DUR-3997 (files on a server): the one shape every protocol's client
 * answers with, and the shared limits.
 *
 * A session is logged in to one server. Paths handed to it are ABSOLUTE
 * paths on that server; confinement under the connection's base folder is
 * done one layer up (operations.ts), so a session never decides what may be
 * touched.
 */

/** Connecting (DNS, TCP, TLS, login) may take this long in total. */
export const FILE_SERVER_CONNECT_TIMEOUT_MS = 10_000;
/** One list, read, write or delete may take this long. */
export const FILE_SERVER_OPERATION_TIMEOUT_MS = 60_000;
/** The most a single file read returns. */
export const FILE_SERVER_MAX_READ_BYTES = 25 * 1024 * 1024;
/** The most a single file write sends. */
export const FILE_SERVER_MAX_WRITE_BYTES = 25 * 1024 * 1024;
/** A folder listing stops being read after this many bytes of listing text. */
export const FILE_SERVER_MAX_LISTING_BYTES = 4 * 1024 * 1024;
/** Entries returned per listing at most. */
export const FILE_SERVER_MAX_LISTING_ENTRIES = 5_000;

export type FileServerProtocol = "ftp" | "ftps" | "sftp";

export interface FileServerEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number | null;
  modifiedAt: Date | null;
}

export interface FileServerReadResult {
  bytes: Buffer;
  size: number;
  modifiedAt: Date | null;
}

export interface FileServerSession {
  protocol: FileServerProtocol;
  /** The server's greeting or software name, one short line, or null. Never a credential. */
  serverSoftware: string | null;
  /** SFTP: "SHA256:<base64>" of the host key the session was opened against; null otherwise. */
  hostKeyFingerprint: string | null;
  list(directory: string): Promise<FileServerEntry[]>;
  read(path: string, maxBytes: number): Promise<FileServerReadResult>;
  write(path: string, bytes: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Test-only seams, mirroring safe-outbound-fetch's TestOnlyDialOverride.
 * Production code never passes them. `dial` sends every socket (control and
 * data) to a local fake server after every check has passed; `tls` lets a
 * test trust its own certificate authority.
 */
export interface FileServerTestOnlyDeps {
  dial?: { host: string; port: number };
  tls?: { ca?: string | string[] };
}

/** Runs `work` with a deadline; `onTimeout` tears down whatever is in flight. */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new FileServerError("timeout", `${what} did not finish within ${Math.round(ms / 1000)} seconds.`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Keeps only printable characters and clips, for a server's greeting in a message. */
export function cleanServerLine(text: string, max = 120): string {
  const cleaned = text.replace(/[^\x20-\x7e -￿]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
