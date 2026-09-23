import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { isSamePeerAddress } from "./address.js";
import { FileServerError } from "./errors.js";
import {
  cleanServerLine,
  formatSize,
  FILE_SERVER_CONNECT_TIMEOUT_MS,
  FILE_SERVER_MAX_LISTING_BYTES,
  FILE_SERVER_MAX_LISTING_ENTRIES,
  FILE_SERVER_OPERATION_TIMEOUT_MS,
  withDeadline,
  type FileServerEntry,
  type FileServerReadResult,
  type FileServerSession,
  type FileServerTestOnlyDeps,
} from "./session.js";

/**
 * DUR-3997 (files on a server): a small FTP / FTPS client on Node's own
 * `net` and `tls`, no dependency. RFC 959 plus the pieces every modern server
 * has: FEAT, EPSV, MLSD, SIZE, MDTM, UTF8, and for FTPS the explicit upgrade
 * (AUTH TLS, PBSZ 0, PROT P) with TLS session reuse on data connections.
 *
 * Safety the transport itself enforces:
 *  - the control socket is opened to the PINNED address resolved by
 *    address.ts, never to a name;
 *  - passive mode only, and a PASV reply that names a different address than
 *    the server the control connection is talking to is refused (the classic
 *    FTP bounce). EPSV carries no address at all and is preferred;
 *  - FTPS verifies the certificate against the DNS name (SNI + identity
 *    check), on the control connection and on every data connection;
 *  - the password is written to the socket exactly once and appears in no
 *    error, log line or reply text this file produces;
 *  - every command line is checked for CR/LF before it is sent, so a path
 *    cannot smuggle a second command;
 *  - connecting (TCP, TLS, login) has one deadline, each operation another,
 *    and reads and listings stop at their byte caps.
 */

export interface FtpConnectOptions {
  /** The DNS name, for TLS identity and messages. */
  host: string;
  /** The pinned public address the sockets are opened to. */
  address: string;
  port: number;
  /** Explicit FTPS (AUTH TLS). */
  secure: boolean;
  username: string;
  password: string;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  testOnly?: FileServerTestOnlyDeps;
}

interface FtpReply {
  code: number;
  text: string;
  lines: string[];
}

type Waiter = { resolve: (reply: FtpReply) => void; reject: (error: Error) => void };

/** A control reply (all lines of a multi-line reply) may hold at most this much unread text. */
const MAX_CONTROL_BUFFER_BYTES = 64 * 1024;
/** A multi-line reply may have at most this many lines. */
const MAX_REPLY_LINES = 200;

function assertCommandArgument(value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new FileServerError("protocol_error", "A path or name contained a line break, which cannot be sent to an FTP server.");
  }
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

function upgradeToTls(
  socket: Socket,
  options: { servername: string; ca?: string | string[]; session?: Buffer },
  timeoutMs: number,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({
      socket,
      servername: options.servername,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(options.ca ? { ca: options.ca } : {}),
      ...(options.session ? { session: options.session } : {}),
    });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new FileServerError("timeout", `Setting up the encrypted connection to ${options.servername} took too long.`));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timer);
      secure.destroy();
      reject(
        new FileServerError(
          "tls_failed",
          `The encrypted connection to ${options.servername} could not be verified (${cleanServerLine(error.message, 80)}).`,
        ),
      );
    };
    secure.once("error", onError);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      secure.removeListener("error", onError);
      resolve(secure);
    });
  });
}

/** The control connection: a line-oriented reply reader over one socket (plain or TLS). */
class FtpControl {
  socket!: Socket | TLSSocket;
  private buffer = "";
  /** Where the next unread line starts in `buffer`; lines before it belong to the reply being assembled. */
  private scanOffset = 0;
  private partialCode: string | null = null;
  private partialLines: string[] = [];
  private readonly queued: FtpReply[] = [];
  private readonly waiters: Waiter[] = [];
  private failure: Error | null = null;
  broken = false;

  constructor(socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", () => this.fail(new FileServerError("connect_failed", "The connection to the server failed.")));
    socket.on("close", () => this.fail(new FileServerError("connect_failed", "The server closed the connection.")));
  }

  /** Detach before a TLS upgrade so the plain socket's events stop reaching the reader. */
  detach(): Socket | TLSSocket {
    const socket = this.socket;
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    socket.setEncoding(undefined as unknown as BufferEncoding);
    return socket;
  }

  get peerAddress(): string {
    return this.socket.remoteAddress ?? "";
  }

  private onData(chunk: string): void {
    if (this.buffer.length + chunk.length > MAX_CONTROL_BUFFER_BYTES) {
      this.fail(new FileServerError("protocol_error", "The server sent a reply that is too long to be an FTP reply."));
      this.socket.destroy();
      return;
    }
    this.buffer += chunk;
    for (;;) {
      const reply = this.takeReply();
      if (!reply) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(reply);
      else this.queued.push(reply);
    }
  }

  /**
   * Takes one complete reply off the buffer, or null while one is still
   * arriving. Scanning resumes where it stopped last time (lines already
   * examined are kept in partialLines), so a slow multi-line reply is read
   * once, not re-read on every chunk.
   */
  private takeReply(): FtpReply | null {
    let position = this.scanOffset;
    for (;;) {
      const newline = this.buffer.indexOf("\n", position);
      if (newline === -1) {
        this.scanOffset = position;
        return null;
      }
      let line = this.buffer.slice(position, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      position = newline + 1;
      this.partialLines.push(line);
      if (this.partialLines.length > MAX_REPLY_LINES) {
        this.fail(new FileServerError("protocol_error", "The server sent a reply with too many lines to be an FTP reply."));
        this.socket.destroy();
        return null;
      }
      const match = /^(\d{3})([ -])/.exec(line);
      if (this.partialCode === null) {
        if (!match) {
          this.fail(new FileServerError("protocol_error", "The server sent a reply Paperclip could not read."));
          this.socket.destroy();
          return null;
        }
        this.partialCode = match[1]!;
        if (match[2] === " ") break;
      } else if (match && match[1] === this.partialCode && match[2] === " ") {
        break;
      }
    }
    const lines = this.partialLines;
    const code = this.partialCode!;
    this.partialLines = [];
    this.partialCode = null;
    this.buffer = this.buffer.slice(position);
    this.scanOffset = 0;
    return {
      code: Number(code),
      lines,
      text: lines.map((line) => line.replace(/^\d{3}[ -]/, "")).join("\n"),
    };
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.broken = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  read(): Promise<FtpReply> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  send(line: string): Promise<FtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    assertCommandArgument(line);
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  destroy(): void {
    this.broken = true;
    this.socket.destroy();
  }
}

/** "20260923101500" or "20260923101500.123" (UTC) to a Date, or null. */
export function parseFtpTimestamp(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const millis = fraction ? Number(`0.${fraction}`) * 1000 : 0;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One MLSD line: "type=file;size=123;modify=20260923101500; name.csv". Null for the . and .. entries. */
export function parseMlsdLine(line: string): FileServerEntry | null {
  const separator = line.indexOf(" ");
  if (separator === -1) return null;
  const facts = line.slice(0, separator);
  const name = line.slice(separator + 1);
  if (!name) return null;
  let type: FileServerEntry["type"] = "other";
  let size: number | null = null;
  let modifiedAt: Date | null = null;
  for (const fact of facts.split(";")) {
    const equals = fact.indexOf("=");
    if (equals === -1) continue;
    const key = fact.slice(0, equals).trim().toLowerCase();
    const value = fact.slice(equals + 1).trim();
    if (key === "type") {
      const lower = value.toLowerCase();
      if (lower === "cdir" || lower === "pdir") return null;
      type = lower === "file" ? "file" : lower === "dir" ? "directory" : "other";
    } else if (key === "size") {
      const parsed = Number.parseInt(value, 10);
      size = Number.isFinite(parsed) ? parsed : null;
    } else if (key === "modify") {
      modifiedAt = parseFtpTimestamp(value);
    }
  }
  return { name, type, size, modifiedAt };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A Unix-style or DOS-style LIST line; null for lines that are neither (totals, . and ..). */
export function parseListLine(line: string, now: Date = new Date()): FileServerEntry | null {
  const unix = /^([-dl])[rwxsStT-]{9}\+?\s+\d+\s+(?:\S+\s+){1,2}(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}|\d{1,2}:\d{2})\s+(.+?)\s*$/.exec(line);
  if (unix) {
    const [, kind, sizeText, monthText, dayText, yearOrTime, rawName] = unix;
    const name = kind === "l" ? rawName!.split(" -> ")[0]! : rawName!;
    if (name === "." || name === "..") return null;
    const month = MONTHS.indexOf(monthText!.toLowerCase());
    let modifiedAt: Date | null = null;
    if (month !== -1) {
      if (/^\d{4}$/.test(yearOrTime!)) {
        modifiedAt = new Date(Date.UTC(Number(yearOrTime), month, Number(dayText)));
      } else {
        const [hour, minute] = yearOrTime!.split(":").map(Number);
        let year = now.getUTCFullYear();
        const candidate = new Date(Date.UTC(year, month, Number(dayText), hour, minute));
        if (candidate.getTime() > now.getTime() + 24 * 3600 * 1000) year -= 1;
        modifiedAt = new Date(Date.UTC(year, month, Number(dayText), hour, minute));
      }
    }
    return {
      name,
      type: kind === "d" ? "directory" : kind === "-" ? "file" : "other",
      size: kind === "-" ? Number.parseInt(sizeText!, 10) : null,
      modifiedAt,
    };
  }
  const dos = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})(AM|PM)?\s+(<DIR>|\d+)\s+(.+?)\s*$/i.exec(line);
  if (dos) {
    const [, monthText, dayText, yearText, hourText, minuteText, meridiem, sizeOrDir, name] = dos;
    if (name === "." || name === "..") return null;
    let hour = Number(hourText);
    if (meridiem) {
      const pm = meridiem.toUpperCase() === "PM";
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    const year = yearText!.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const isDirectory = sizeOrDir!.toUpperCase() === "<DIR>";
    return {
      name: name!,
      type: isDirectory ? "directory" : "file",
      size: isDirectory ? null : Number.parseInt(sizeOrDir!, 10),
      modifiedAt: new Date(Date.UTC(year, Number(monthText) - 1, Number(dayText), hour, Number(minuteText))),
    };
  }
  return null;
}

function replyError(reply: FtpReply, what: string): FileServerError {
  const detail = cleanServerLine(reply.text.split("\n")[0] ?? "", 80);
  const suffix = detail ? ` (${reply.code}: ${detail})` : ` (${reply.code})`;
  if (reply.code === 550 || reply.code === 553 || reply.code === 450) {
    return new FileServerError("not_found", `The server could not ${what}${suffix}. The file or folder may not exist, or the account may not be allowed to use it.`);
  }
  if (reply.code === 530 || reply.code === 532) {
    return new FileServerError("permission_denied", `The server did not allow Paperclip to ${what}${suffix}.`);
  }
  return new FileServerError("protocol_error", `The server refused to ${what}${suffix}.`);
}

export async function connectFtp(options: FtpConnectOptions): Promise<FileServerSession> {
  const connectTimeoutMs = options.connectTimeoutMs ?? FILE_SERVER_CONNECT_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? FILE_SERVER_OPERATION_TIMEOUT_MS;
  const describe = `${options.host}:${options.port}`;
  const controlTarget = options.testOnly?.dial ?? { host: options.address, port: options.port };
  const ca = options.testOnly?.tls?.ca;
  const features = new Set<string>();
  let serverSoftware: string | null = null;
  let controlTls: TLSSocket | null = null;
  /** The data socket of the transfer in flight, so a timeout or close tears it down too. */
  let activeData: Socket | TLSSocket | null = null;

  const abort = () => {
    activeData?.destroy();
    activeData = null;
    control.destroy();
  };

  const control = new FtpControl(await dial(controlTarget, connectTimeoutMs, describe));

  async function expect(reply: FtpReply, codes: number[], what: string): Promise<FtpReply> {
    if (!codes.includes(reply.code)) throw replyError(reply, what);
    return reply;
  }

  async function setup(): Promise<void> {
    const greeting = await control.read();
    if (greeting.code !== 220) {
      throw new FileServerError("protocol_error", `${options.host} did not greet like an FTP server (reply ${greeting.code}).`);
    }
    serverSoftware = cleanServerLine(greeting.text.split("\n")[0] ?? "") || null;

    if (options.secure) {
      const auth = await control.send("AUTH TLS");
      if (auth.code !== 234 && auth.code !== 334) {
        throw new FileServerError(
          "tls_failed",
          `${options.host} does not offer encrypted FTPS (AUTH TLS was refused with ${auth.code}). Ask the server owner to enable it, or add the server as plain FTP if you accept an unencrypted connection.`,
        );
      }
      const plain = control.detach() as Socket;
      controlTls = await upgradeToTls(plain, { servername: options.host, ca }, connectTimeoutMs);
      control.attach(controlTls);
      await expect(await control.send("PBSZ 0"), [200], "set up encryption");
      await expect(await control.send("PROT P"), [200], "encrypt data connections");
    }

    assertCommandArgument(options.username);
    assertCommandArgument(options.password);
    const user = await control.send(`USER ${options.username}`);
    if (user.code === 331 || user.code === 332) {
      const pass = await control.send(`PASS ${options.password}`);
      if (pass.code !== 230 && pass.code !== 202) {
        throw new FileServerError("login_failed", `${options.host} refused the user name or password.`);
      }
    } else if (user.code !== 230) {
      throw new FileServerError("login_failed", `${options.host} refused the user name or password.`);
    }

    const feat = await control.send("FEAT");
    if (feat.code === 211) {
      for (const line of feat.lines.slice(1, -1)) {
        const name = line.trim().split(/\s+/)[0];
        if (name) features.add(name.toUpperCase());
      }
    }
    if (features.has("UTF8")) await control.send("OPTS UTF8 ON");
    await expect(await control.send("TYPE I"), [200], "switch to binary mode");
  }

  try {
    await withDeadline(setup(), connectTimeoutMs, abort, `Connecting to ${describe}`);
  } catch (error) {
    control.destroy();
    throw error;
  }

  async function openDataSocket(): Promise<Socket | TLSSocket> {
    let port: number | null = null;
    let address = control.peerAddress;
    if (features.has("EPSV") || address.includes(":")) {
      const epsv = await control.send("EPSV");
      if (epsv.code === 229) {
        const match = /\(\|\|\|(\d+)\|\)/.exec(epsv.text);
        if (!match) throw new FileServerError("protocol_error", `${options.host} sent an EPSV reply Paperclip could not read.`);
        port = Number(match[1]);
      }
    }
    if (port === null) {
      const pasv = await expect(await control.send("PASV"), [227], "open a data connection");
      const match = /(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(pasv.text);
      if (!match) throw new FileServerError("protocol_error", `${options.host} sent a PASV reply Paperclip could not read.`);
      const offered = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
      port = Number(match[5]) * 256 + Number(match[6]);
      if (!isSamePeerAddress(offered, address)) {
        throw new FileServerError(
          "bounce_refused",
          `${options.host} asked Paperclip to open a data connection to a different address (${offered}) than the server itself. That is refused.`,
        );
      }
      address = offered;
    }
    if (port < 1 || port > 65_535) throw new FileServerError("protocol_error", `${options.host} offered an invalid data port.`);
    const target = options.testOnly?.dial ? { host: options.testOnly.dial.host, port } : { host: address, port };
    const socket = await dial(target, connectTimeoutMs, `the data connection to ${options.host}`);
    if (!options.secure) return socket;
    return upgradeToTls(socket, { servername: options.host, ca, session: controlTls?.getSession() ?? undefined }, connectTimeoutMs);
  }

  /** One transfer: open the data connection, send the command, move the bytes, read the final reply. */
  async function transfer(command: string, what: string, direction: "download" | "upload", payload: Buffer | null, maxBytes: number): Promise<Buffer> {
    const data = await openDataSocket();
    activeData = data;
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    const finished = new Promise<void>((resolve, reject) => {
      data.on("data", (chunk: Buffer) => {
        if (direction !== "download") return;
        received += chunk.length;
        if (received > maxBytes) {
          overflow = true;
          data.destroy();
          return;
        }
        chunks.push(chunk);
      });
      data.on("error", () => (overflow ? resolve() : reject(new FileServerError("connect_failed", `The data connection to ${options.host} failed.`))));
      data.on("close", () => resolve());
    });
    // The data socket can fail (a reset) before the control reply arrives.
    // Observe the outcome now so an early rejection is never unhandled; the
    // await below still sees it.
    finished.catch(() => undefined);
    try {
      let reply: FtpReply;
      try {
        reply = await control.send(command);
      } catch (error) {
        data.destroy();
        throw error;
      }
      if (reply.code !== 150 && reply.code !== 125) {
        data.destroy();
        throw replyError(reply, what);
      }
      if (direction === "upload") {
        data.end(payload ?? Buffer.alloc(0));
      }
      await finished;
      if (overflow) {
        // The server is still sending; the session cannot be reused cleanly.
        control.destroy();
        throw new FileServerError("too_large", `The file is larger than ${formatSize(maxBytes)}, which is the most Paperclip reads here.`);
      }
      const done = await control.read();
      if (done.code !== 226 && done.code !== 250) throw replyError(done, what);
      return Buffer.concat(chunks);
    } finally {
      if (activeData === data) activeData = null;
    }
  }

  const guarded = <T>(work: () => Promise<T>, what: string): Promise<T> =>
    withDeadline(work(), operationTimeoutMs, abort, what);

  const session: FileServerSession = {
    protocol: options.secure ? "ftps" : "ftp",
    get serverSoftware() {
      return serverSoftware;
    },
    hostKeyFingerprint: null,

    list(directory) {
      return guarded(async () => {
        assertCommandArgument(directory);
        const useMlsd = features.has("MLSD");
        const raw = await transfer(useMlsd ? `MLSD ${directory}` : `LIST ${directory}`, `list ${directory}`, "download", null, FILE_SERVER_MAX_LISTING_BYTES);
        const entries: FileServerEntry[] = [];
        for (const line of raw.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const entry = useMlsd ? parseMlsdLine(line) : parseListLine(line);
          if (entry) entries.push(entry);
          if (entries.length >= FILE_SERVER_MAX_LISTING_ENTRIES) break;
        }
        return entries;
      }, `Listing ${directory} on ${options.host}`);
    },

    read(path, maxBytes) {
      return guarded(async () => {
        assertCommandArgument(path);
        let modifiedAt: Date | null = null;
        if (features.has("SIZE")) {
          const size = await control.send(`SIZE ${path}`);
          if (size.code === 213) {
            const known = Number.parseInt(size.text.trim(), 10);
            if (Number.isFinite(known) && known > maxBytes) {
              throw new FileServerError("too_large", `${path} is ${formatSize(known)}, more than the ${formatSize(maxBytes)} Paperclip reads here at most.`);
            }
          } else if (size.code === 550) {
            throw replyError(size, `read ${path}`);
          }
        }
        if (features.has("MDTM")) {
          const mdtm = await control.send(`MDTM ${path}`);
          if (mdtm.code === 213) modifiedAt = parseFtpTimestamp(mdtm.text);
        }
        const bytes = await transfer(`RETR ${path}`, `read ${path}`, "download", null, maxBytes);
        const result: FileServerReadResult = { bytes, size: bytes.length, modifiedAt };
        return result;
      }, `Reading ${path} from ${options.host}`);
    },

    write(path, bytes) {
      return guarded(async () => {
        assertCommandArgument(path);
        await transfer(`STOR ${path}`, `write ${path}`, "upload", bytes, 0);
      }, `Writing ${path} to ${options.host}`);
    },

    remove(path) {
      return guarded(async () => {
        assertCommandArgument(path);
        await expect(await control.send(`DELE ${path}`), [250, 200], `delete ${path}`);
      }, `Deleting ${path} on ${options.host}`);
    },

    abort,
    async close() {
      activeData?.destroy();
      activeData = null;
      if (!control.broken) {
        await withDeadline(control.send("QUIT"), 3_000, () => control.destroy(), "Closing the connection").catch(() => undefined);
      }
      control.destroy();
    },
  };
  return session;
}
