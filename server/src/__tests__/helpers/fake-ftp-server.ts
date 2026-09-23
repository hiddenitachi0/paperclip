import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";

/**
 * A tiny in-process FTP server for tests. It speaks just enough RFC 959 for
 * the client under test: USER/PASS, FEAT, TYPE, PWD/CWD, PASV/EPSV, LIST/MLSD,
 * RETR, STOR, DELE, SIZE, MDTM, QUIT, and (with `tls`) the explicit FTPS
 * upgrade: AUTH TLS, PBSZ, PROT P, with encrypted data connections. No real
 * filesystem -- an in-memory tree of files. It never touches the network
 * beyond 127.0.0.1.
 *
 * Misbehaviour it can be told to show, so the client's defences are tested:
 *  - `pasvLieAddress`: PASV names a different address than its own (bounce);
 *  - `resetDataOn`: the data socket is reset before the transfer command is
 *    answered, then the command gets a 550;
 *  - `oversizedReplyOn`: one unterminated reply far longer than any FTP reply;
 *  - `stallOn`: the command is never answered.
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
  /** Reset the data socket when one of these transfer commands arrives, then answer it 550. */
  resetDataOn?: Array<"RETR" | "LIST" | "MLSD" | "STOR">;
  /** Answer this command with one enormous unterminated line. */
  oversizedReplyOn?: string;
  /** Never answer this command. */
  stallOn?: string;
  /** Offer AUTH TLS with this certificate (PEM key + cert). */
  tls?: { key: string; cert: string };
}

export interface FakeFtpServer {
  port: number;
  files: Record<string, FakeFtpFile>;
  loginAttempts: Array<{ user: string; pass: string }>;
  /** Commands seen on the control connection, in order. */
  commands: string[];
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
  const commands: string[] = [];
  const useMlsd = options.useMlsd !== false;
  const secureContext: SecureContext | null = options.tls ? createSecureContext({ key: options.tls.key, cert: options.tls.cert }) : null;
  const sockets = new Set<Socket>();

  const server: Server = createServer((plain: Socket) => {
    sockets.add(plain);
    plain.on("close", () => sockets.delete(plain));
    let control: Socket | TLSSocket = plain;
    let cwd = "/";
    let pendingUser = "";
    let protectedData = false;
    // In passive FTP the client connects the data channel after PASV/EPSV but
    // BEFORE the transfer command, so the data socket and the command's
    // handler can arrive in either order; pair whichever comes second.
    let dataListener: ((data: Socket | TLSSocket) => void) | null = null;
    let pendingDataSocket: Socket | TLSSocket | null = null;
    let dataServer: Server | null = null;
    let buffer = "";

    const send = (line: string) => control.write(`${line}\r\n`);

    const openPassive = (): Promise<number> =>
      new Promise((resolve) => {
        dataServer = createServer((raw) => {
          sockets.add(raw);
          raw.on("close", () => sockets.delete(raw));
          let dataSocket: Socket | TLSSocket = raw;
          if (protectedData && secureContext) {
            dataSocket = new TLSSocket(raw, { isServer: true, secureContext });
            dataSocket.on("error", () => undefined);
          }
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

    const withData = (fn: (dataSocket: Socket | TLSSocket) => void) => {
      if (pendingDataSocket) {
        const dataSocket = pendingDataSocket;
        pendingDataSocket = null;
        fn(dataSocket);
      } else {
        dataListener = fn;
      }
    };

    const onData = (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        handle(raw);
      }
    };

    plain.setEncoding("utf8");
    plain.on("data", onData);
    plain.on("error", () => undefined);
    send("220 fake-ftp ready");

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

    /** The misbehaviours: true when the command was consumed by one of them. */
    function misbehave(command: string): boolean {
      if (options.stallOn === command) return true;
      if (options.oversizedReplyOn === command) {
        control.write(`200-${"x".repeat(100 * 1024)}`);
        return true;
      }
      if (options.resetDataOn?.includes(command as "RETR")) {
        withData((dataSocket) => {
          const raw = dataSocket instanceof TLSSocket ? plain : dataSocket;
          if ("resetAndDestroy" in raw) (raw as Socket).resetAndDestroy();
          else dataSocket.destroy();
          setTimeout(() => send("550 the data connection was dropped for the test"), 30);
        });
        return true;
      }
      return false;
    }

    function handle(line: string): void {
      const spaceAt = line.indexOf(" ");
      const command = (spaceAt === -1 ? line : line.slice(0, spaceAt)).toUpperCase();
      const arg = spaceAt === -1 ? "" : line.slice(spaceAt + 1);
      commands.push(command);
      if (misbehave(command)) return;
      switch (command) {
        case "AUTH": {
          if (!secureContext || arg.toUpperCase() !== "TLS") {
            send("502 AUTH not supported");
            return;
          }
          // Reply in the clear, then hand the same socket to TLS; the client
          // starts the handshake after reading the 234.
          plain.removeListener("data", onData);
          plain.pause();
          plain.write("234 Proceed with negotiation\r\n", () => {
            const secure = new TLSSocket(plain, { isServer: true, secureContext });
            secure.setEncoding("utf8");
            secure.on("data", onData);
            secure.on("error", () => undefined);
            control = secure;
          });
          return;
        }
        case "PBSZ":
          send("200 PBSZ=0");
          return;
        case "PROT":
          protectedData = arg.toUpperCase() === "P";
          send("200 Protection level set");
          return;
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
          if (useMlsd) send(" MLSD");
          send(" SIZE");
          send(" MDTM");
          send(" UTF8");
          if (secureContext) send(" AUTH TLS");
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
            dataSocket.on("data", (data: Buffer | string) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
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
          control.end();
          return;
        default:
          send("502 not implemented");
      }
    }

    plain.on("close", () => {
      dataServer?.close();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    files,
    loginAttempts,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
