import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * A tiny in-process FTP server for tests. It speaks just enough RFC 959 for
 * the client under test: USER/PASS, FEAT, TYPE, PWD/CWD, PASV/EPSV, LIST/MLSD,
 * RETR, STOR, DELE, SIZE, MDTM, QUIT. No TLS, no real filesystem -- an
 * in-memory tree of files.
 *
 * It can be told to lie in a PASV reply (a different address than its own),
 * so the client's FTP-bounce refusal can be exercised. It never touches the
 * network beyond 127.0.0.1.
 */

export interface FakeFtpFile {
  content: Buffer;
  modify?: string; // "YYYYMMDDHHMMSS"
}

export interface FakeFtpOptions {
  username: string;
  password: string;
  /** Absolute path -> file. Directories are implied by path prefixes. */
  files: Record<string, FakeFtpFile>;
  /** Make PASV advertise this address (e.g. "8.8.8.8") to test bounce refusal. EPSV is then disabled. */
  pasvLieAddress?: string;
  /** Use MLSD for listings (default) or fall back to LIST. */
  useMlsd?: boolean;
}

export interface FakeFtpServer {
  port: number;
  files: Record<string, FakeFtpFile>;
  loginAttempts: Array<{ user: string; pass: string }>;
  close(): Promise<void>;
}

function normalize(base: string, target: string): string {
  const path = target.startsWith("/") ? target : `${base}/${target}`;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export async function startFakeFtpServer(options: FakeFtpOptions): Promise<FakeFtpServer> {
  const files = { ...options.files };
  const loginAttempts: Array<{ user: string; pass: string }> = [];
  const useMlsd = options.useMlsd !== false;

  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let cwd = "/";
    let pendingUser = "";
    // In passive FTP the client connects the data channel after PASV/EPSV but
    // BEFORE the transfer command, so the data socket and the command's
    // handler can arrive in either order; pair whichever comes second.
    let dataListener: ((data: Socket) => void) | null = null;
    let pendingDataSocket: Socket | null = null;
    let dataServer: Server | null = null;
    let buffer = "";

    const send = (line: string) => socket.write(`${line}\r\n`);

    const openPassive = (): Promise<number> =>
      new Promise((resolve) => {
        dataServer = createServer((dataSocket) => {
          if (dataListener) {
            const listener = dataListener;
            dataListener = null;
            listener(dataSocket);
          } else {
            pendingDataSocket = dataSocket;
          }
        });
        dataServer.listen(0, "127.0.0.1", () => resolve((dataServer!.address() as AddressInfo).port));
      });

    const withData = (fn: (dataSocket: Socket) => void) => {
      if (pendingDataSocket) {
        const dataSocket = pendingDataSocket;
        pendingDataSocket = null;
        fn(dataSocket);
      } else {
        dataListener = fn;
      }
    };

    send("220 fake-ftp ready");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        handle(raw);
      }
    });

    function listingFor(dir: string): string {
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          const file = files[path]!;
          seen.add(rest);
          lines.push(
            useMlsd
              ? `type=file;size=${file.content.length};modify=${file.modify ?? "20260101000000"}; ${rest}`
              : `-rw-r--r-- 1 owner group ${file.content.length} Jan 01 00:00 ${rest}`,
          );
        } else {
          const name = rest.slice(0, slash);
          if (seen.has(`d:${name}`)) continue;
          seen.add(`d:${name}`);
          lines.push(useMlsd ? `type=dir;modify=20260101000000; ${name}` : `drwxr-xr-x 2 owner group 4096 Jan 01 00:00 ${name}`);
        }
      }
      return lines.join("\r\n") + (lines.length ? "\r\n" : "");
    }

    function handle(line: string): void {
      const spaceAt = line.indexOf(" ");
      const command = (spaceAt === -1 ? line : line.slice(0, spaceAt)).toUpperCase();
      const arg = spaceAt === -1 ? "" : line.slice(spaceAt + 1);
      switch (command) {
        case "USER":
          pendingUser = arg;
          send("331 need password");
          return;
        case "PASS":
          loginAttempts.push({ user: pendingUser, pass: arg });
          if (pendingUser === options.username && arg === options.password) send("230 logged in");
          else send("530 bad login");
          return;
        case "FEAT":
          send("211-Features:");
          send(useMlsd ? " MLSD" : " SIZE");
          send(" SIZE");
          send(" MDTM");
          send(" UTF8");
          if (!options.pasvLieAddress) send(" EPSV");
          send("211 End");
          return;
        case "OPTS":
          send("200 ok");
          return;
        case "TYPE":
          send("200 type set");
          return;
        case "PWD":
          send(`257 "${cwd}"`);
          return;
        case "CWD":
          cwd = normalize(cwd, arg);
          send("250 ok");
          return;
        case "EPSV": {
          if (options.pasvLieAddress) {
            send("500 EPSV not supported");
            return;
          }
          void openPassive().then((port) => send(`229 Entering Extended Passive Mode (|||${port}|)`));
          return;
        }
        case "PASV": {
          void openPassive().then((port) => {
            const address = options.pasvLieAddress ?? "127.0.0.1";
            const [a, b, c, d] = address.split(".");
            send(`227 Entering Passive Mode (${a},${b},${c},${d},${Math.floor(port / 256)},${port % 256})`);
          });
          return;
        }
        case "MLSD":
        case "LIST": {
          const dir = arg ? normalize(cwd, arg) : cwd;
          const body = listingFor(dir);
          send("150 here comes the listing");
          withData((dataSocket) => {
            dataSocket.end(body);
            send("226 listing done");
          });
          return;
        }
        case "SIZE": {
          const file = files[normalize(cwd, arg)];
          if (file) send(`213 ${file.content.length}`);
          else send("550 no such file");
          return;
        }
        case "MDTM": {
          const file = files[normalize(cwd, arg)];
          if (file) send(`213 ${file.modify ?? "20260101000000"}`);
          else send("550 no such file");
          return;
        }
        case "RETR": {
          const path = normalize(cwd, arg);
          const file = files[path];
          if (!file) {
            send("550 no such file");
            return;
          }
          send("150 sending");
          withData((dataSocket) => {
            dataSocket.end(file.content);
            send("226 transfer complete");
          });
          return;
        }
        case "STOR": {
          const path = normalize(cwd, arg);
          send("150 ready");
          withData((dataSocket) => {
            const chunks: Buffer[] = [];
            dataSocket.on("data", (data: Buffer) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
            dataSocket.on("end", () => {
              files[path] = { content: Buffer.concat(chunks) };
              send("226 stored");
            });
          });
          return;
        }
        case "DELE": {
          const path = normalize(cwd, arg);
          if (files[path]) {
            delete files[path];
            send("250 deleted");
          } else {
            send("550 no such file");
          }
          return;
        }
        case "QUIT":
          send("221 bye");
          socket.end();
          return;
        default:
          send("502 not implemented");
      }
    }

    socket.on("close", () => {
      dataServer?.close();
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    files,
    loginAttempts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
