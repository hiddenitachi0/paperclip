import nodemailer from "nodemailer";

/**
 * DUR-4194: SMTP send for a per-person mail account. The ONLY place in this
 * codebase that sends real mail on a mail account's behalf -- and it is only
 * ever called from mailAccountsService.sendDraft, which refuses any actor
 * except the owning human pressing Send (see that function's doc comment).
 * An AI PA agent can reach every other function in this file's sibling
 * service but never this one.
 */

export interface MailAccountSmtpConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface OutgoingMailMessage {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  inReplyTo: string | null;
}

export interface SentMailResult {
  messageId: string;
}

export async function sendAccountMail(
  config: MailAccountSmtpConnectionConfig,
  message: OutgoingMailMessage,
): Promise<SentMailResult> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
  });
  try {
    const info = await transport.sendMail({
      from: message.from,
      to: message.to,
      cc: message.cc.length > 0 ? message.cc : undefined,
      subject: message.subject,
      text: message.text,
      html: message.html ?? undefined,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.inReplyTo ?? undefined,
    });
    return { messageId: info.messageId };
  } finally {
    transport.close();
  }
}
