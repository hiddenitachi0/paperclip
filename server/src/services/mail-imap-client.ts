import { ImapFlow, type MessageStructureObject } from "imapflow";
import { logger } from "../middleware/logger.js";

/**
 * DUR-4093: the mail secretary's only way to read a mailbox -- one
 * connection per tick, opened read-only, closed when done. Never sends,
 * never deletes, never sets a flag (a readOnly mailbox lock refuses any of
 * that at the protocol level, so this is enforced by the server, not just by
 * this module choosing not to call those methods).
 */

export interface MailImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
}

export interface FetchedMailMessage {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  receivedAt: Date | null;
  /** Best-effort plain text, HTML stripped if that was the only part found. Never the raw MIME source. */
  bodyText: string;
}

const CONNECT_TIMEOUT_MS = 20_000;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Depth-first search of a BODYSTRUCTURE tree for the first part of the given MIME type. */
function findBodyPart(
  structure: MessageStructureObject | undefined,
  type: string,
): { part: string } | null {
  if (!structure) return null;
  const nodeType = `${structure.type ?? ""}`.toLowerCase();
  if (nodeType === type && structure.part) return { part: structure.part };
  if (Array.isArray(structure.childNodes)) {
    for (const child of structure.childNodes) {
      const found = findBodyPart(child, type);
      if (found) return found;
    }
  }
  return null;
}

async function readDownload(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Connects, opens the mailbox read-only, fetches every message with UID
 * greater than `sinceUid` (or the most recent `maxMessages` if this is the
 * inbox's first check), and disconnects. Always ascending by UID, capped at
 * `maxMessages` -- the rest wait for the next tick.
 */
export async function fetchNewMailMessages(
  config: MailImapConnectionConfig,
  sinceUid: number | null,
  maxMessages: number,
): Promise<FetchedMailMessage[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    logger: false,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });

  const messages: FetchedMailMessage[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox, { readOnly: true });
    try {
      const exists = client.mailbox ? client.mailbox.exists : 0;
      if (!exists) return [];

      const range = sinceUid ? `${sinceUid + 1}:*` : `1:*`;
      const uidsToFetch: number[] = [];
      for await (const message of client.fetch(range, { uid: true }, { uid: true })) {
        if (sinceUid && message.uid <= sinceUid) continue;
        uidsToFetch.push(message.uid);
      }
      uidsToFetch.sort((a, b) => a - b);
      // First-ever check on an inbox: don't replay its whole history, only the most recent slice.
      const targetUids = sinceUid ? uidsToFetch : uidsToFetch.slice(-maxMessages);
      const batch = targetUids.slice(0, maxMessages);

      for (const uid of batch) {
        const fetched = await client.fetchOne(
          String(uid),
          { envelope: true, bodyStructure: true },
          { uid: true },
        );
        if (!fetched) continue;
        let bodyText = "";
        const textPart = findBodyPart(fetched.bodyStructure, "text/plain") ?? findBodyPart(fetched.bodyStructure, "text/html");
        const isHtml = !findBodyPart(fetched.bodyStructure, "text/plain") && Boolean(textPart);
        if (textPart) {
          try {
            const download = await client.download(String(uid), textPart.part, { uid: true });
            if (download.content) {
              const raw = await readDownload(download.content);
              bodyText = isHtml ? stripHtml(raw) : raw;
            }
          } catch (err) {
            logger.warn({ err, uid }, "mail-secretary: could not download a message part, leaving body empty");
          }
        }
        const from = fetched.envelope?.from?.[0];
        const fromAddress = from ? `${from.address ?? ""}` : "";
        const rawDate = fetched.envelope?.date;
        const receivedAt = rawDate ? new Date(rawDate) : null;
        messages.push({
          uid,
          messageId: fetched.envelope?.messageId ?? null,
          from: fromAddress,
          subject: fetched.envelope?.subject ?? "",
          receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
          bodyText,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
  return messages;
}
