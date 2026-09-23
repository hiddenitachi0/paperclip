import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KIND_LABELS,
  FILE_SERVER_CONFIG_SCHEMAS,
  FILE_SERVER_DEFAULT_PORTS,
  FILE_SERVER_PROTOCOLS,
  type DataConnectionObservedSummary,
  type FileServerConnectionConfig,
  type FileServerKind,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../errors.js";
import type { FileServerReadContext } from "./connection-kind.js";
import { resolveFileServerAddress } from "./file-server/address.js";
import { FileServerError } from "./file-server/errors.js";
import { connectFtp } from "./file-server/ftp-client.js";
import { createFileServerOperations } from "./file-server/operations.js";
import { connectSftp } from "./file-server/sftp-client.js";
import type { FileServerSession } from "./file-server/session.js";
import type { DataSourceKindDefinition, OpenReadContextInput } from "./registry.js";

/**
 * DUR-3997 (files on a server): the registry entries for `ftp_file`,
 * `ftps_file` and `sftp_file`. One factory, three kinds; the only differences
 * are the transport opened (ftp-client.ts plain or with TLS, or
 * sftp-client.ts), the default port, and which credential kinds are taken.
 *
 * "Test" connects, logs in, lists the base folder, and -- for a `read_write`
 * connection -- writes and deletes an empty `.paperclip-write-check` file.
 * A read-write connection that cannot write is not switched on.
 */

export const FILE_SERVER_WRITE_CHECK_NAME = ".paperclip-write-check";

/** Plain sentence for anything the transports throw. Never an unknown error's text. */
export function fileServerProblem(error: unknown): string {
  if (error instanceof FileServerError) return error.message;
  if (error instanceof HttpError && error.status === 422) return error.message;
  return "Something unexpected went wrong while contacting the server. The error is logged.";
}

function configOf(kind: FileServerKind, input: OpenReadContextInput): FileServerConnectionConfig {
  const { connection } = input;
  if (connection.kind !== kind || connection.config.kind !== kind) {
    throw unprocessable("This connection is of another kind than the file-server adapter expected.", {
      code: "data_source_kind_mismatch",
    });
  }
  return connection.config as FileServerConnectionConfig;
}

function openFileServerContext(kind: FileServerKind, input: OpenReadContextInput): FileServerReadContext {
  const config = configOf(kind, input);
  const { connection, deps } = input;
  const now = deps.now ?? Date.now;
  const fileServerDeps = deps.fileServer ?? {};

  const openSession = async (): Promise<FileServerSession> => {
    // Address first, credential second: a host that fails the address rule
    // never causes the credential to be read.
    const pinned = await resolveFileServerAddress(config.host, { lookup: fileServerDeps.lookup });
    const credential = await input.loadCredential();
    const shared = {
      host: pinned.host,
      address: pinned.address,
      port: config.port,
      username: config.username,
      connectTimeoutMs: fileServerDeps.connectTimeoutMs,
      operationTimeoutMs: fileServerDeps.operationTimeoutMs,
      testOnly: fileServerDeps.testOnly,
    };
    if (kind === "sftp_file") {
      if (credential.kind !== "password" && credential.kind !== "private_key") {
        throw unprocessable("The stored credential does not fit an SFTP connection. Paste it again.", { code: "credential_kind_mismatch" });
      }
      return connectSftp({ ...shared, credential, expectedHostKeyFingerprint: connection.hostKeyFingerprint });
    }
    if (credential.kind !== "password") {
      throw unprocessable("The stored credential does not fit an FTP connection. Paste it again.", { code: "credential_kind_mismatch" });
    }
    return connectFtp({ ...shared, secure: kind === "ftps_file", password: credential.password });
  };

  const files = createFileServerOperations({
    basePath: config.remotePath,
    access: connection.access,
    maxRequests: input.budget.maxRequests,
    openSession,
  });
  return {
    kind,
    connection,
    files,
    now: () => new Date(now()),
    stats: () => ({ requests: files.stats().requests, costPoints: 0 }),
  };
}

function emptyObserved(): DataConnectionObservedSummary {
  return {
    shopName: null,
    shopDomain: null,
    ianaTimezone: null,
    currencyCode: null,
    grantedScopes: [],
    earliestVisibleOrderAt: null,
    productTypeCoverage: null,
    fileServer: null,
    checkedAt: null,
  };
}

export function fileServerDataSource(kind: FileServerKind): DataSourceKindDefinition {
  const label = DATA_CONNECTION_KIND_LABELS[kind];
  const protocol = FILE_SERVER_PROTOCOLS[kind];
  return {
    kind,
    label,
    supported: true,
    credentialKinds: DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND[kind],
    datasets: ["custom"],
    configSchema: FILE_SERVER_CONFIG_SCHEMAS[kind],
    storedShape(input) {
      if (input.kind !== kind) throw unprocessable(`Wrong kind of connection for ${label}.`);
      // The config schema keeps only its own fields: the credential, the name,
      // the cap and the access mode are stripped, so no secret lands in `config`.
      const config = FILE_SERVER_CONFIG_SCHEMAS[kind].parse(input) as Record<string, unknown>;
      return { shopDomain: null, apiVersion: null, config, access: input.access };
    },
    describeTarget(connection) {
      const config = connection.config;
      if (config.kind !== kind) return "";
      const port = config.port === FILE_SERVER_DEFAULT_PORTS[kind] ? "" : `:${config.port}`;
      return `${config.host}${port}${config.remotePath}`;
    },
    // Not HTTP: the transports carry their own address rule (file-server/address.ts).
    outboundPolicy() {
      return null;
    },
    canActivate(observed) {
      const seen = observed?.fileServer ?? null;
      if (!seen) return { ok: false, problems: ["The connection has not passed Test yet. Press Test first."] };
      if (seen.writable === false) {
        return { ok: false, problems: ["The write check failed at the last Test, so this read-and-write connection cannot be switched on."] };
      }
      return { ok: true, problems: [] };
    },
    openReadContext(input) {
      return openFileServerContext(kind, input);
    },
    async check(input) {
      const context = openFileServerContext(kind, input);
      const { files, connection } = context;
      const problems: string[] = [];
      const notes: string[] = [];
      let observed: DataConnectionObservedSummary | null = null;
      let ok = false;
      try {
        const listing = await files.list("/");
        ok = true;
        const fileCount = listing.entries.filter((entry) => entry.type === "file").length;
        const directoryCount = listing.entries.filter((entry) => entry.type === "directory").length;
        notes.push(
          `${fileCount} ${fileCount === 1 ? "file" : "files"} and ${directoryCount} ${directoryCount === 1 ? "folder" : "folders"} in ${files.basePath}.`,
        );
        let writable: boolean | null = null;
        if (connection.access === "read_write") {
          try {
            await files.write(FILE_SERVER_WRITE_CHECK_NAME, Buffer.alloc(0));
            await files.remove(FILE_SERVER_WRITE_CHECK_NAME);
            writable = true;
            notes.push(`Write check passed: an empty ${FILE_SERVER_WRITE_CHECK_NAME} was created and deleted in ${files.basePath}.`);
          } catch (error) {
            writable = false;
            problems.push(
              `Write check failed: ${fileServerProblem(error)} The connection was saved with read and write access, so it cannot be switched on until writing works.`,
            );
          }
        } else {
          notes.push("Read-only: Paperclip will never write, change or delete anything on this server.");
        }
        const session = files.session();
        if (kind === "ftp_file") {
          notes.push("Plain FTP: the password and every file travel unencrypted between Paperclip and this server.");
        }
        if (kind === "sftp_file" && session?.hostKeyFingerprint) {
          notes.push(
            connection.hostKeyFingerprint
              ? `The server's SSH host key matches the one pinned at the first Test (${session.hostKeyFingerprint}).`
              : `The server's SSH host key is now pinned (${session.hostKeyFingerprint}); a different key is refused from now on.`,
          );
        }
        observed = {
          ...emptyObserved(),
          fileServer: {
            protocol,
            fileCount,
            directoryCount,
            writable,
            hostKeyFingerprint: session?.hostKeyFingerprint ?? connection.hostKeyFingerprint ?? null,
            serverSoftware: session?.serverSoftware ?? null,
          },
          checkedAt: context.now().toISOString(),
        };
      } catch (error) {
        problems.push(fileServerProblem(error));
      } finally {
        await files.close();
      }
      return {
        ok,
        canActivate: ok && problems.length === 0,
        problems,
        notes,
        observed,
        stats: context.stats(),
      };
    },
    adapters: {},
  };
}
