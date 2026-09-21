export {
  createDb,
  DEFAULT_APP_POOL_MAX,
  DEFAULT_APP_POOL_STATEMENT_TIMEOUT_MS,
  getAppPoolMax,
  getAppPoolStatementTimeoutMs,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestOptions,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export {
  withCompanyScope,
  withCompanyScopeBypass,
  runInCompanyScope,
  runInCompanyScopeBypass,
  runInPooledScope,
  createRequestScopedDb,
  ConnectionReleaseUnsafeError,
  ConnectionFencedError,
  ConnectionReserveTimeoutError,
  RESERVE_CONNECTION_TIMEOUT_MS,
  type CompanyScopeBypassOptions,
  type RequestScope,
  type RequestCompanyScope,
  type RequestCompanyScopeBypass,
  type RequestPooledScope,
} from "./company-scope.js";
export {
  ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE,
  ROUTINE_SCHEDULER_BYPASS_ROUTES,
  ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS,
  isRoutineSchedulerBypass,
  recordRoutineSchedulerBypass,
  snapshotRoutineSchedulerBypassCounts,
  resetRoutineSchedulerBypassCounts,
  type RoutineSchedulerBypassRoute,
  type RoutineSchedulerBypassSubject,
} from "./cross-company-audit.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
