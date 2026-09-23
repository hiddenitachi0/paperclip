import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

/**
 * A tiny in-process SFTP server for tests, on the `ssh2` package the server
 * already depends on. A fresh ed25519 host key is generated per start (nothing
 * is committed), one user name/password is accepted, and an in-memory tree
 * of files is served: REALPATH, STAT/LSTAT/FSTAT, OPENDIR/READDIR, OPEN/READ/
 * WRITE/CLOSE, REMOVE. Every authentication attempt is recorded so a test can
 * prove that a refused host key stops the client before it ever offers a
 * password. It never touches the network beyond 127.0.0.1.
 */

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ssh2 = require("ssh2") as any;
const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

export interface FakeSftpOptions {
  username: string;
  password: string;
  /** Absolute path -> content. Directories are implied by path prefixes. */
  files: Record<string, Buffer>;
}

export interface FakeSftpServer {
  port: number;
  files: Record<string, Buffer>;
  /** Authentication methods the client offered, in order ("none", "password", ...). */
  authAttempts: string[];
  close(): Promise<void>;
}

type FileHandle = { type: "file"; path: string; buf: Buffer; write: boolean };
type DirHandle = { type: "dir"; entries: Array<{ filename: string; longname: string; attrs: Record<string, number> }>; sent: boolean };
type Handle = FileHandle | DirHandle;

const NOW = Math.floor(Date.UTC(2026, 0, 1) / 1000);

function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export async function startFakeSftpServer(options: FakeSftpOptions): Promise<FakeSftpServer> {
  const files: Record<string, Buffer> = { ...options.files };
  const authAttempts: string[] = [];
  const hostKey = utils.generateKeyPairSync("ed25519");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connections = new Set<any>();

  const isDir = (path: string) => path === "/" || Object.keys(files).some((file) => file.startsWith(`${path}/`));
  const fileAttrs = (size: number) => ({ mode: 0o100644, size, uid: 0, gid: 0, atime: NOW, mtime: NOW });
  const dirAttrs = () => ({ mode: 0o40755, size: 4096, uid: 0, gid: 0, atime: NOW, mtime: NOW });
  const attrsFor = (path: string) => (files[path] ? fileAttrs(files[path]!.length) : isDir(path) ? dirAttrs() : null);
  const entriesOf = (dir: string) => {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const seen = new Set<string>();
    const entries: DirHandle["entries"] = [];
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({ filename: name, longname: name, attrs: slash === -1 ? fileAttrs(files[path]!.length) : dirAttrs() });
    }
    return entries;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on("authentication", (ctx: any) => {
      authAttempts.push(ctx.method);
      if (ctx.method === "password" && ctx.username === options.username && ctx.password === options.password) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession: () => any) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp: () => any) => {
          const sftp = acceptSftp();
          let nextId = 1;
          const handles = new Map<number, Handle>();
          const open = (handle: Handle) => {
            const id = nextId++;
            handles.set(id, handle);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(id, 0);
            return buffer;
          };
          const lookup = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0));

          sftp.on("REALPATH", (reqid: number, path: string) => {
            const resolved = normalize(path);
            sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrsFor(resolved) ?? {} }]);
          });
          const stat = (reqid: number, path: string) => {
            const attrs = attrsFor(normalize(path));
            if (attrs) sftp.attrs(reqid, attrs);
            else sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          };
          sftp.on("STAT", stat);
          sftp.on("LSTAT", stat);
          sftp.on("FSTAT", (reqid: number, handle: Buffer) => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            sftp.attrs(reqid, fileAttrs(entry.buf.length));
          });
          sftp.on("OPENDIR", (reqid: number, path: string) => {
            const dir = normalize(path);
            if (!isDir(dir)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.handle(reqid, open({ type: "dir", entries: entriesOf(dir), sent: false }));
          });
          sftp.on("READDIR", (reqid: number, handle: Buffer) => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (entry.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            entry.sent = true;
            sftp.name(reqid, entry.entries);
          });
          sftp.on("OPEN", (reqid: number, path: string, flags: number) => {
            const resolved = normalize(path);
            if (flags & OPEN_MODE.WRITE) {
              const existing = files[resolved];
              const buf = flags & OPEN_MODE.TRUNC || !existing ? Buffer.alloc(0) : Buffer.from(existing);
              sftp.handle(reqid, open({ type: "file", path: resolved, buf, write: true }));
              return;
            }
            if (!files[resolved]) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.handle(reqid, open({ type: "file", path: resolved, buf: files[resolved]!, write: false }));
          });
          sftp.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (offset >= entry.buf.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, entry.buf.subarray(offset, offset + length));
          });
          sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "file" || !entry.write) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const end = offset + data.length;
            if (entry.buf.length < end) {
              const grown = Buffer.alloc(end);
              entry.buf.copy(grown);
              entry.buf = grown;
            }
            data.copy(entry.buf, offset);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
            const entry = lookup(handle);
            if (entry?.type === "file" && entry.write) files[entry.path] = entry.buf;
            handles.delete(handle.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("REMOVE", (reqid: number, path: string) => {
            const resolved = normalize(path);
            if (!files[resolved]) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            delete files[resolved];
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    files,
    authAttempts,
    close: async () => {
      for (const connection of connections) connection.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
