// DUR-3996: accept a request body field under the name a client used to send
// it, by moving it to the name the route reads now -- BEFORE anything else on
// the route can fail.
//
// Why this exists: the HTTP logger copies `req.body` into every 4xx/5xx log
// line and blanks fields by NAME (see redact-sensitive.ts). A bare `token` is
// deliberately left readable there, because it is a pagination cursor far
// more often than a credential. Two routes carried a real credential under
// that name anyway -- a Telegram bot token, and the CLI sign-in challenge
// secret -- so a wrong role, a typo elsewhere in the body or a database error
// wrote the credential to server.log, a file every agent on this box can
// read. Those routes now read `botToken` / `authToken`, both on the redaction
// list.
//
// This keeps the old spelling working for one release. It must be the FIRST
// handler in the route's chain: by the time the authorization gate, the
// validator or the handler can throw, the body no longer has a field called
// `token`, whichever way the request ends. The new name wins when a client
// sends both; the legacy field is always removed. A body that is not a plain
// object is left alone for the validator to refuse.
//
// Remove the two call sites (routes/telegram-bots.ts, routes/access.ts) and
// this file in the release after the one that ships them.
import type { NextFunction, Request, Response } from "express";

export function acceptLegacyBodyField(legacyName: string, name: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const body: unknown = req.body;
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.prototype.hasOwnProperty.call(body, legacyName)
    ) {
      const record = body as Record<string, unknown>;
      if (record[name] === undefined) record[name] = record[legacyName];
      delete record[legacyName];
    }
    next();
  };
}
