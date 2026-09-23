import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { FileServerError } from "./errors.js";
import {
  cleanServerLine,
  FILE_SERVER_CONNECT_TIMEOUT_MS,
  FILE_SERVER_MAX_LISTING_ENTRIES,
  FILE_SERVER_OPERATION_TIMEOUT_MS,
  withDeadline,
  type FileServerEntry,
  type FileServerReadResult,
  type FileServerSession,
  type FileServerTestOnlyDeps,
} from "./session.js";

/**
 * DUR-3997 (files on a server): SFTP over the `ssh2` package the server
 * already depends on (the custom-image terminal uses it). No new dependency.
 *
 * Safety the transport itself enforces:
 *  - the TCP socket is opened by Paperclip to the PINNED address from
 *    address.ts and handed to ssh2 (`sock`), so ssh2 never resolves a name;
 *  - the server's host key is fingerprinted (SHA-256, OpenSSH style). The
 *    first Test records it on the connection; every later session refuses a
 *    different key, which is what stops a redirected connection from
 *    collecting the password;
 *  - the password or private key is handed to ssh2 exactly once and appears
 *    in no error, log line or message this file produces;
 *  - connecting and each operation have their own deadlines, and reads stop
 *    at the byte cap (a file that grows during the read is refused, not
 *    half-returned).
 */

const require = createRequire(import.meta.url);

type Ssh2Error = Error & { level?: string; code?: number };
interface Ssh2Attrs {
  mode?: number;
  size?: number;
  mtime?: number;
}
interface Ssh2DirEntry {
  filename: string;
  longname?: string;
  attrs?: Ssh2Attrs;
}
interface Ssh2ReadStream {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(event: "error", listener: (error: Ssh2Error) => void): this;
  destroy(error?: Error): void;
}
interface Ssh2Sftp {
  readdir(path: string, callback: (error: Ssh2Error | null | undefined, list: Ssh2DirEntry[]) => void): void;
  stat(path: string, callback: (error: Ssh2Error | null | undefined, stats: Ssh2Attrs) => void): void;
  createReadStream(path: string): Ssh2ReadStream;
  writeFile(path: string, data: Buffer, callback: (error?: Ssh2Error | null) => void): void;
  unlink(path: string, callback: (error?: Ssh2Error | null) => void): void;
}
interface Ssh2Client {
  once(event: "ready", listener: () => void): this;
  once(event: "error", listener: (error: Ssh2Error) => void): this;
  once(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Ssh2Error) => void): this;
  connect(config: Record<string, unknown>): void;
  sftp(callback: (error: Ssh2Error | undefined, sftp: Ssh2Sftp) => void): void;
  end(): void;
  destroy(): void;
}

const { Client } = require("ssh2") as { Client: new () => Ssh2Client };

export type SftpCredential =
  | { kind: "password"; password: string }
  | { kind: "private_key"; privateKey: string; passphrase?: string };

export interface SftpConnectOptions {
  /** The DNS name, for messages. */
  host: string;
  /** The pinned public address the socket is opened to. */
  address: string;
  port: number;
  username: string;
  credential: SftpCredential;
  /** "SHA256:…" recorded at the last Test; a different key is refused. Null before the first Test. */
  expectedHostKeyFingerprint: string | null;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  testOnly?: FileServerTestOnlyDeps;
}

/** OpenSSH-style fingerprint of a raw host key: SHA256 in base64 without padding. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function dial(target: { host: string; port: number }, timeoutMs: number, describe: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new FileServerError("timeout", `${describe} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    const onError = () => {
      clearTimeout(timer);
      reject(new FileServerError("connect_failed", `Could not connect to ${describe}.`));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function entryType(mode: number | undefined): FileServerEntry["type"] {
  if (typeof mode !== "number") return "other";
  const format = mode & S_IFMT;
  return format === S_IFDIR ? "directory" : format === S_IFREG ? "file" : "other";
}

function sftpStatusError(error: Ssh2Error, what: string): FileServerError {
  if (error.code === 2) return new FileServerError("not_found", `The server could not ${what}: no such file or folder.`);
  if (error.code === 3) return new FileServerError("permission_denied", `The server did not allow Paperclip to ${what}.`);
  return new FileServerError("protocol_error", `The server refused to ${what} (${cleanServerLine(error.message, 80)}).`);
}

export async function connectSftp(options: SftpConnectOptions): Promise<FileServerSession> {
  const connectTimeoutMs = options.connectTimeoutMs ?? FILE_SERVER_CONNECT_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? FILE_SERVER_OPERATION_TIMEOUT_MS;
  const describe = `${options.host}:${options.port}`;
  const target = options.testOnly?.dial ?? { host: options.address, port: options.port };
  const sock = await dial(target, connectTimeoutMs, describe);

  const client = new Client();
  let fingerprint: string | null = null;
  let keyRefused = false;
  let broken = false;

  function mapError(error: Ssh2Error): FileServerError {
    if (keyRefused) {
      return new FileServerError(
        "host_key_mismatch",
        `The SSH host key of ${options.host} is not the one seen at the last Test. If the server was reinstalled, remove the connection and add it again; otherwise the connection may be intercepted, so nothing was sent.`,
      );
    }
    if (error.level === "client-authentication") {
      return new FileServerError("login_failed", `${options.host} refused the user name, password or key.`);
    }
    if (error.level === "client-timeout") {
      return new FileServerError("timeout", `${describe} did not answer within ${Math.round(connectTimeoutMs / 1000)} seconds.`);
    }
    if (error.level === "client-socket") {
      return new FileServerError("connect_failed", `The connection to ${describe} failed.`);
    }
    if (/privateKey|passphrase/i.test(error.message)) {
      return new FileServerError("login_failed", "The private key could not be read. Paste the whole key, and the passphrase if it has one.");
    }
    return new FileServerError("protocol_error", `Could not set up the SSH connection to ${options.host} (${cleanServerLine(error.message, 80)}).`);
  }

  // A permanent listener: an 'error' with no listener would throw out of the event loop.
  client.on("error", () => {
    broken = true;
  });
  const ready = new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (error) => reject(mapError(error)));
    client.once("close", () => reject(new FileServerError("connect_failed", `${options.host} closed the connection before login finished.`)));
  });
  try {
    client.connect({
      sock,
      username: options.username,
      readyTimeout: connectTimeoutMs,
      tryKeyboard: false,
      ...(options.credential.kind === "password"
        ? { password: options.credential.password }
        : { privateKey: options.credential.privateKey, ...(options.credential.passphrase ? { passphrase: options.credential.passphrase } : {}) }),
      hostVerifier: (key: Buffer) => {
        fingerprint = hostKeyFingerprint(key);
        if (options.expectedHostKeyFingerprint && options.expectedHostKeyFingerprint !== fingerprint) {
          keyRefused = true;
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    sock.destroy();
    throw mapError(error as Ssh2Error);
  }
  try {
    await withDeadline(ready, connectTimeoutMs, () => client.destroy(), `Connecting to ${describe}`);
  } catch (error) {
    client.destroy();
    throw error;
  }

  const sftp = await withDeadline(
    new Promise<Ssh2Sftp>((resolve, reject) => {
      client.sftp((error, channel) => {
        if (error || !channel) {
          reject(new FileServerError("unsupported", `${options.host} accepted the login but does not offer SFTP.`));
          return;
        }
        resolve(channel);
      });
    }),
    connectTimeoutMs,
    () => client.destroy(),
    `Opening SFTP on ${describe}`,
  ).catch((error: unknown) => {
    client.destroy();
    throw error;
  });

  const guarded = <T>(work: () => Promise<T>, what: string): Promise<T> => {
    if (broken) return Promise.reject(new FileServerError("connect_failed", `The connection to ${options.host} was lost.`));
    return withDeadline(work(), operationTimeoutMs, () => client.destroy(), what);
  };

  function stat(path: string, what: string): Promise<Ssh2Attrs> {
    return new Promise((resolve, reject) => {
      sftp.stat(path, (error, stats) => (error ? reject(sftpStatusError(error, what)) : resolve(stats ?? {})));
    });
  }

  const session: FileServerSession = {
    protocol: "sftp",
    serverSoftware: null,
    get hostKeyFingerprint() {
      return fingerprint;
    },

    list(directory) {
      return guarded(
        () =>
          new Promise<FileServerEntry[]>((resolve, reject) => {
            sftp.readdir(directory, (error, list) => {
              if (error) {
                reject(sftpStatusError(error, `list ${directory}`));
                return;
              }
              const entries: FileServerEntry[] = [];
              for (const item of list ?? []) {
                if (!item?.filename || item.filename === "." || item.filename === "..") continue;
                entries.push({
                  name: item.filename,
                  type: entryType(item.attrs?.mode),
                  size: typeof item.attrs?.size === "number" ? item.attrs.size : null,
                  modifiedAt: typeof item.attrs?.mtime === "number" ? new Date(item.attrs.mtime * 1000) : null,
                });
                if (entries.length >= FILE_SERVER_MAX_LISTING_ENTRIES) break;
              }
              resolve(entries);
            });
          }),
        `Listing ${directory} on ${options.host}`,
      );
    },

    read(path, maxBytes) {
      return guarded(async () => {
        const attrs = await stat(path, `read ${path}`);
        if (entryType(attrs.mode) === "directory") {
          throw new FileServerError("not_found", `${path} is a folder, not a file.`);
        }
        if (typeof attrs.size === "number" && attrs.size > maxBytes) {
          throw new FileServerError(
            "too_large",
            `${path} is ${Math.round(attrs.size / (1024 * 1024))} MB, more than the ${Math.round(maxBytes / (1024 * 1024))} MB Paperclip reads at most.`,
          );
        }
        const bytes = await new Promise<Buffer>((resolve, reject) => {
          const stream = sftp.createReadStream(path);
          const chunks: Buffer[] = [];
          let received = 0;
          let settled = false;
          const finish = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            outcome();
          };
          stream.on("data", (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
              stream.destroy();
              finish(() =>
                reject(
                  new FileServerError("too_large", `${path} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, which is the most Paperclip reads.`),
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          stream.on("error", (error) => finish(() => reject(sftpStatusError(error, `read ${path}`))));
          stream.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
          stream.on("close", () => finish(() => resolve(Buffer.concat(chunks))));
        });
        const result: FileServerReadResult = {
          bytes,
          size: bytes.length,
          modifiedAt: typeof attrs.mtime === "number" ? new Date(attrs.mtime * 1000) : null,
        };
        return result;
      }, `Reading ${path} from ${options.host}`);
    },

    write(path, bytes) {
      return guarded(
        () =>
          new Promise<void>((resolve, reject) => {
            sftp.writeFile(path, bytes, (error) => (error ? reject(sftpStatusError(error, `write ${path}`)) : resolve()));
          }),
        `Writing ${path} to ${options.host}`,
      );
    },

    remove(path) {
      return guarded(
        () =>
          new Promise<void>((resolve, reject) => {
            sftp.unlink(path, (error) => (error ? reject(sftpStatusError(error, `delete ${path}`)) : resolve()));
          }),
        `Deleting ${path} on ${options.host}`,
      );
    },

    async close() {
      broken = true;
      try {
        client.end();
      } catch {
        client.destroy();
      }
      setTimeout(() => sock.destroy(), 1_000).unref();
    },
  };
  return session;
}
