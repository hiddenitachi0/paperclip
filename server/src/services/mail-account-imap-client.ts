import { ImapFlow, type MessageStructureObject } from "imapflow";
import { logger } from "../middleware/logger.js";

/**
 * DUR-4194: IMAP sync for a per-person mail account. Modelled on
 * mail-imap-client.ts (the mail secretary's fetcher, DUR-4093), but kept as
 * its own module rather than a shared one: that module's read-only lock is
 * load-bearing for a feature whose whole safety story is "never writes to
 * someone's real inbox", and this feature's sync tick (also read-only, see
 * fetchNewMailMessages below) must never be refactored into sharing a code
 * path with a future write-capable operation on that file by accident.
 *
 * v1 scope: the sync tick only ever reads. Move/archive in this feature
 * relabel our own mail_messages row (folder column) and do not call IMAP
 * MOVE/COPY/STORE against the origin mailbox -- see the module doc comment
 * on packages/db/src/schema/mail_accounts.ts.
 */

export interface MailAccountImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
}

export interface FetchedAccountMailMessage {
  uid: number;
  messageId: string | null;
  inReplyToMessageId: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  receivedAt: Date | null;
  bodyText: string;
  bodyHtml: string | null;
}

const CONNECT_TIMEOUT_MS = 20_000;

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

function addressList(entries: Array<{ address?: string }> | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => entry.address ?? "").filter((address) => address.length > 0);
}

/**
 * Connects, opens the mailbox read-only, fetches every message with UID
 * greater than `sinceUid` (or the most recent `maxMessages` if this is the
 * account's first check), and disconnects. Always ascending by UID, capped
 * at `maxMessages` -- the rest wait for the next tick. Keeps both the text
 * and HTML bodies (unlike the mail secretary's fetcher) since a real mail
 * client wants to show the message as it was sent, not just a classifier
 * excerpt.
 */
export async function fetchNewAccountMailMessages(
  config: MailAccountImapConnectionConfig,
  sinceUid: number | null,
  maxMessages: number,
): Promise<FetchedAccountMailMessage[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    logger: false,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });

  const messages: FetchedAccountMailMessage[] = [];
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
      // First-ever check on an account: don't replay its whole history, only the most recent slice.
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
        let bodyHtml: string | null = null;
        const textPart = findBodyPart(fetched.bodyStructure, "text/plain");
        const htmlPart = findBodyPart(fetched.bodyStructure, "text/html");
        try {
          if (textPart) {
            const download = await client.download(String(uid), textPart.part, { uid: true });
            if (download.content) bodyText = await readDownload(download.content);
          }
          if (htmlPart) {
            const download = await client.download(String(uid), htmlPart.part, { uid: true });
            if (download.content) bodyHtml = await readDownload(download.content);
          }
        } catch (err) {
          logger.warn({ err, uid }, "mail-account: could not download a message part, leaving body empty");
        }

        const from = fetched.envelope?.from?.[0];
        messages.push({
          uid,
          messageId: fetched.envelope?.messageId ?? null,
          inReplyToMessageId: fetched.envelope?.inReplyTo ?? null,
          from: from ? `${from.address ?? ""}` : "",
          to: addressList(fetched.envelope?.to),
          cc: addressList(fetched.envelope?.cc),
          subject: fetched.envelope?.subject ?? "",
          receivedAt: fetched.envelope?.date ? new Date(fetched.envelope.date) : null,
          bodyText,
          bodyHtml,
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
