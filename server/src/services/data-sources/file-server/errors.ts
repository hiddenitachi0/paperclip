/**
 * DUR-3997 (files on a server): every refusal and failure the file-server
 * transports raise, as one error class with a fixed code and a plain English
 * sentence.
 *
 * The message never contains a credential, a request that carried one, or a
 * raw server reply longer than one short scrubbed line, so an error that
 * reaches a log, an audit row or a chat answer cannot carry the password.
 */
export type FileServerErrorCode =
  | "address_not_public"
  | "dns_failed"
  | "connect_failed"
  | "tls_failed"
  | "host_key_mismatch"
  | "login_failed"
  | "timeout"
  | "bounce_refused"
  | "not_found"
  | "permission_denied"
  | "too_large"
  | "path_outside_base"
  | "write_not_allowed"
  | "request_budget_exceeded"
  | "protocol_error"
  | "unsupported";

export class FileServerError extends Error {
  readonly code: FileServerErrorCode;
  constructor(code: FileServerErrorCode, message: string) {
    super(message);
    this.name = "FileServerError";
    this.code = code;
  }
}

export function isFileServerError(error: unknown): error is FileServerError {
  return error instanceof FileServerError;
}

/** Codes that mean the server or the network, not the person asking, is the problem. */
export function isUpstreamFileServerError(code: FileServerErrorCode): boolean {
  return (
    code === "dns_failed" ||
    code === "connect_failed" ||
    code === "tls_failed" ||
    code === "timeout" ||
    code === "protocol_error" ||
    code === "login_failed" ||
    code === "host_key_mismatch"
  );
}
