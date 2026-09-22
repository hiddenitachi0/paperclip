// What the HTTP logger attaches to a 4xx/5xx log line, kept in its own
// module (no pino transport, no file handles) so a test can drive a real
// pino-http instance into an in-memory stream and assert what would have
// been written. logger.ts is the only production caller.
//
// Everything copied from the request is passed through redactSensitive, which
// blanks fields by NAME. A body field that carries a credential must
// therefore be named so it is on that list -- see redact-sensitive.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSensitive } from "./redact-sensitive.js";

export function httpErrorLogProps(req: IncomingMessage, res: ServerResponse): Record<string, unknown> {
  if (res.statusCode < 400) return {};
  const ctx = (res as any).__errorContext;
  if (ctx) {
    return {
      errorContext: ctx.error,
      reqBody: redactSensitive(ctx.reqBody),
      reqParams: redactSensitive(ctx.reqParams),
      reqQuery: redactSensitive(ctx.reqQuery),
    };
  }
  const props: Record<string, unknown> = {};
  const { body, params, query } = req as any;
  if (body && typeof body === "object" && Object.keys(body).length > 0) {
    props.reqBody = redactSensitive(body);
  }
  if (params && typeof params === "object" && Object.keys(params).length > 0) {
    props.reqParams = redactSensitive(params);
  }
  if (query && typeof query === "object" && Object.keys(query).length > 0) {
    props.reqQuery = redactSensitive(query);
  }
  if ((req as any).route?.path) {
    props.routePath = (req as any).route.path;
  }
  return props;
}
