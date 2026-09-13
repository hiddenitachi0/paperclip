export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

/**
 * DUR-3977: "you have hit a limit, here is which one". `details` carries a
 * machine-readable `reason` so a batch caller can tell a daily call cap apart
 * from a spent budget apart from too many calls at once, and back off
 * accordingly rather than hammering.
 */
export function tooManyRequests(message: string, details?: unknown) {
  return new HttpError(429, message, details);
}
