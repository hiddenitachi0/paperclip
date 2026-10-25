import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

/**
 * Board chat on signed-in servers runs its tools INSIDE the Paperclip server:
 * a tool call is a request handed straight to this server's own Express app
 * as a JavaScript object. No socket is opened, no HTTP leaves the process,
 * and no credential exists that anything else could copy.
 *
 * Who the request acts as is attached with a module-private Symbol. A
 * request that arrives over the network can never carry a Symbol, so only
 * this module can make one; the actor middleware (middleware/auth.ts) takes
 * the actor from it and skips every other way of signing in.
 *
 * Going through the app (rather than calling services directly) means every
 * change made on Approve runs the exact route the person's own click would:
 * the same validation, permission checks, activity log and follow-on work.
 */

const IN_PROCESS_ACTOR = Symbol("paperclip.boardChat.inProcessActor");
const IN_PROCESS_ACTION = Symbol("paperclip.boardChat.inProcessAction");

export type BoardChatInProcessAction = NonNullable<Express.Request["boardChatAction"]>;

/** The actor (and, for an approved change, the held action) attached to an in-process request, if any. */
export function readInProcessBoardChatRequest(req: unknown): {
  actor: Express.Request["actor"];
  action: BoardChatInProcessAction | undefined;
} | null {
  const holder = req as Record<symbol, unknown>;
  const actor = holder[IN_PROCESS_ACTOR] as Express.Request["actor"] | undefined;
  if (!actor) return null;
  return { actor, action: holder[IN_PROCESS_ACTION] as BoardChatInProcessAction | undefined };
}

export interface InProcessResponse {
  status: number;
  text: string;
  json: unknown;
}

export type BoardChatDispatch = (input: {
  method: string;
  path: string;
  body?: unknown;
  actor: Express.Request["actor"];
  action?: BoardChatInProcessAction;
}) => Promise<InProcessResponse>;

type AppHandler = (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;

const DISPATCH_TIMEOUT_MS = 60_000;

/** A dispatcher bound to the server's own Express app (late-bound: the app is still being built). */
export function createInProcessDispatcher(getApp: () => AppHandler): BoardChatDispatch {
  return (input) =>
    new Promise<InProcessResponse>((resolve) => {
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = input.method.toUpperCase();
      req.url = input.path;
      req.headers = { host: "localhost", accept: "application/json" };
      const holder = req as unknown as Record<symbol, unknown>;
      holder[IN_PROCESS_ACTOR] = input.actor;
      if (input.action) holder[IN_PROCESS_ACTION] = input.action;
      if (input.body !== undefined && input.body !== null) {
        // Parsed already: the JSON body parser skips a request without a body,
        // and the routes read req.body as usual.
        (req as unknown as { body: unknown }).body = input.body;
        req.headers["content-type"] = "application/json";
      }
      req.push(null);

      const res = new ServerResponse(req);
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (status: number, text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status, text, json });
      };
      const timer = setTimeout(() => finish(504, JSON.stringify({ error: "Paperclip took too long to answer." })), DISPATCH_TIMEOUT_MS);
      const toBuffer = (chunk: unknown, encoding?: unknown) =>
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
      const writable = res as unknown as {
        write: (...args: unknown[]) => boolean;
        end: (...args: unknown[]) => unknown;
        finished: boolean;
      };
      writable.write = (chunk: unknown, encoding?: unknown, cb?: unknown) => {
        if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(toBuffer(chunk, encoding));
        const callback = typeof encoding === "function" ? encoding : cb;
        if (typeof callback === "function") (callback as () => void)();
        return true;
      };
      writable.end = (chunk?: unknown, encoding?: unknown, cb?: unknown) => {
        if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(toBuffer(chunk, encoding));
        writable.finished = true;
        const callback = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : cb;
        if (typeof callback === "function") (callback as () => void)();
        const text = Buffer.concat(chunks).toString("utf8");
        finish(res.statusCode, text);
        // Let request-scoped work (company scope, request logs) see the end.
        setImmediate(() => {
          res.emit("finish");
          res.emit("close");
        });
        return res;
      };

      try {
        getApp()(req, res, (err?: unknown) => {
          finish(err ? 500 : 404, JSON.stringify({ error: err ? "Paperclip could not do that." : "Not found" }));
        });
      } catch {
        finish(500, JSON.stringify({ error: "Paperclip could not do that." }));
      }
    });
}
