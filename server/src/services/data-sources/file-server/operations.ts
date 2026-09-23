import type { DataConnectionAccessLevel } from "@paperclipai/shared";
import { FileServerError } from "./errors.js";
import { confineRemotePath } from "./paths.js";
import {
  FILE_SERVER_MAX_READ_BYTES,
  FILE_SERVER_MAX_WRITE_BYTES,
  formatSize,
  withDeadline,
  type FileServerEntry,
  type FileServerReadResult,
  type FileServerSession,
} from "./session.js";

/**
 * DUR-3997 (files on a server): what an adapter, the Test and the quick-agent
 * tool get -- the session behind a fence.
 *
 *  - every path is confined under the connection's base folder before it is
 *    handed to the session (paths.ts);
 *  - write and delete exist only when the connection is `read_write`; on a
 *    `read` connection they are refused here, before any command is sent;
 *  - the session is opened lazily, once, on the first operation (so the
 *    credential is resolved only when something is actually read);
 *  - operations are counted against the lookup's request budget, and the
 *    whole context has one wall-clock deadline (budget.deadlineMs): an
 *    operation that would run past it is refused, and one that hits it is
 *    torn down (sockets destroyed), never left hanging.
 */

export interface FileServerOperations {
  readonly basePath: string;
  readonly access: DataConnectionAccessLevel;
  /** `directory` is relative to the base folder ("" or "/" for the base itself), or absolute inside it. */
  list(directory: string): Promise<{ path: string; entries: FileServerEntry[] }>;
  /** `maxBytes` caps this one read (default: the context's cap); a larger file is refused, never cut. */
  read(path: string, options?: { maxBytes?: number }): Promise<FileServerReadResult & { path: string }>;
  write(path: string, bytes: Buffer): Promise<{ path: string }>;
  remove(path: string): Promise<{ path: string }>;
  /** The absolute path a caller's path resolves to, or a refusal; no server contact. */
  resolve(path: string): string;
  /** Facts about the open session; null until the first operation has opened it. */
  session(): { protocol: FileServerSession["protocol"]; serverSoftware: string | null; hostKeyFingerprint: string | null } | null;
  stats(): { requests: number };
  close(): Promise<void>;
}

export interface CreateFileServerOperationsInput {
  basePath: string;
  access: DataConnectionAccessLevel;
  /** Operations allowed in this context (list, read, write and delete each count one). */
  maxRequests: number;
  /** Wall-clock time the whole context may use, from creation; absent means no context deadline. */
  deadlineMs?: number;
  maxReadBytes?: number;
  openSession: () => Promise<FileServerSession>;
  now?: () => number;
}

export function createFileServerOperations(input: CreateFileServerOperationsInput): FileServerOperations {
  const maxReadBytes = input.maxReadBytes ?? FILE_SERVER_MAX_READ_BYTES;
  const now = input.now ?? Date.now;
  const deadlineAt = input.deadlineMs === undefined ? null : now() + input.deadlineMs;
  let opening: Promise<FileServerSession> | null = null;
  let opened: FileServerSession | null = null;
  let requests = 0;

  /** Drops every socket now; a later close() is then a no-op. */
  function abort(): void {
    const pending = opening;
    opening = null;
    opened?.abort();
    opened = null;
    pending?.then((session) => session.abort(), () => undefined);
  }

  /** Runs one operation under what is left of the context deadline. */
  function timed<T>(work: () => Promise<T>, what: string): Promise<T> {
    if (deadlineAt === null) return work();
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      return Promise.reject(new FileServerError("timeout", `${what} was not started: this lookup's time is used up.`));
    }
    return withDeadline(work(), remaining, abort, what);
  }

  function session(): Promise<FileServerSession> {
    if (!opening) {
      opening = input.openSession().then((value) => {
        opened = value;
        return value;
      });
    }
    return opening;
  }

  function spend(): void {
    if (requests >= input.maxRequests) {
      throw new FileServerError(
        "request_budget_exceeded",
        `This lookup already used its ${input.maxRequests} server operations. Ask again for the rest.`,
      );
    }
    requests += 1;
  }

  function requireWrite(what: string): void {
    if (input.access !== "read_write") {
      throw new FileServerError(
        "write_not_allowed",
        `This connection is read-only, so Paperclip cannot ${what}. A board user can add the server again with read and write access if that is intended.`,
      );
    }
  }

  return {
    basePath: input.basePath,
    access: input.access,
    resolve: (path) => confineRemotePath(input.basePath, path),
    async list(directory) {
      const path = confineRemotePath(input.basePath, directory);
      spend();
      const entries = await timed(async () => (await session()).list(path), `Listing ${path}`);
      return { path, entries };
    },
    async read(path, options = {}) {
      const absolute = confineRemotePath(input.basePath, path);
      const maxBytes = Math.min(options.maxBytes ?? maxReadBytes, maxReadBytes);
      spend();
      const result = await timed(async () => (await session()).read(absolute, maxBytes), `Reading ${absolute}`);
      return { path: absolute, ...result };
    },
    async write(path, bytes) {
      requireWrite("write a file");
      const absolute = confineRemotePath(input.basePath, path);
      if (bytes.length > FILE_SERVER_MAX_WRITE_BYTES) {
        throw new FileServerError("too_large", `The file is larger than ${formatSize(FILE_SERVER_MAX_WRITE_BYTES)}, which is the most Paperclip writes.`);
      }
      spend();
      await timed(async () => (await session()).write(absolute, bytes), `Writing ${absolute}`);
      return { path: absolute };
    },
    async remove(path) {
      requireWrite("delete a file");
      const absolute = confineRemotePath(input.basePath, path);
      spend();
      await timed(async () => (await session()).remove(absolute), `Deleting ${absolute}`);
      return { path: absolute };
    },
    session: () =>
      opened
        ? { protocol: opened.protocol, serverSoftware: opened.serverSoftware, hostKeyFingerprint: opened.hostKeyFingerprint }
        : null,
    stats: () => ({ requests }),
    async close() {
      if (!opening) return;
      const pending = opening;
      opening = null;
      opened = null;
      const active = await pending.catch(() => null);
      if (active) await active.close().catch(() => undefined);
    },
  };
}
