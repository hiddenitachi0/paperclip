import type { DataConnectionAccessLevel } from "@paperclipai/shared";
import { FileServerError } from "./errors.js";
import { confineRemotePath } from "./paths.js";
import {
  FILE_SERVER_MAX_READ_BYTES,
  FILE_SERVER_MAX_WRITE_BYTES,
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
 *  - operations are counted against the lookup's request budget.
 */

export interface FileServerOperations {
  readonly basePath: string;
  readonly access: DataConnectionAccessLevel;
  /** `directory` is relative to the base folder ("" or "/" for the base itself), or absolute inside it. */
  list(directory: string): Promise<{ path: string; entries: FileServerEntry[] }>;
  read(path: string): Promise<FileServerReadResult & { path: string }>;
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
  maxReadBytes?: number;
  openSession: () => Promise<FileServerSession>;
}

export function createFileServerOperations(input: CreateFileServerOperationsInput): FileServerOperations {
  const maxReadBytes = input.maxReadBytes ?? FILE_SERVER_MAX_READ_BYTES;
  let opening: Promise<FileServerSession> | null = null;
  let opened: FileServerSession | null = null;
  let requests = 0;

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
      const entries = await (await session()).list(path);
      return { path, entries };
    },
    async read(path) {
      const absolute = confineRemotePath(input.basePath, path);
      spend();
      const result = await (await session()).read(absolute, maxReadBytes);
      return { path: absolute, ...result };
    },
    async write(path, bytes) {
      requireWrite("write a file");
      const absolute = confineRemotePath(input.basePath, path);
      if (bytes.length > FILE_SERVER_MAX_WRITE_BYTES) {
        throw new FileServerError("too_large", `The file is larger than ${Math.round(FILE_SERVER_MAX_WRITE_BYTES / (1024 * 1024))} MB, which is the most Paperclip writes.`);
      }
      spend();
      await (await session()).write(absolute, bytes);
      return { path: absolute };
    },
    async remove(path) {
      requireWrite("delete a file");
      const absolute = confineRemotePath(input.basePath, path);
      spend();
      await (await session()).remove(absolute);
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
