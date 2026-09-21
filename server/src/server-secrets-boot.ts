/**
 * DUR-3994 Stage 1: imported FIRST by index.ts (before instrumentation and
 * before config.ts loads any .env file), so the server's keys leave
 * `process.env` -- and the entrypoint's hand-over descriptor is read and
 * closed -- before anything else runs or any child process can be started.
 * See server-secrets.ts.
 */
import { captureServerSecrets } from "./server-secrets.js";

captureServerSecrets();
