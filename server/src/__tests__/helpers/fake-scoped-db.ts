// DUR-348: every route wired through the company-scope middleware now
// reserves a real connection (rawDb.$client.reserve()) for the request --
// see middleware/company-scope.ts / packages/db/src/company-scope.ts. Route
// unit tests that pass a plain mock object (not a real Db from
// createDb()/the embedded-postgres helper) need this stub attached so a
// request through a scoped route doesn't 500 on a missing `$client`.
//
// This only satisfies the reserve/set-claim/reset/release lifecycle -- it
// does not execute real SQL. Tests whose routes issue real queries against
// the *scoped* db (as opposed to calling a fully-mocked service) still need
// a real Db (see file-resources.test.ts / company-scope-middleware.test.ts
// for the embedded-postgres pattern) or their own query stub on top of this.
//
// `$client` is defined non-enumerable so it doesn't change what the mock
// object looks like to assertions that compare the request-scoped db by
// structural equality (e.g. `toHaveBeenCalledWith({}, ...)`).
//
// `unsafeRows` backs `client.unsafe(query, params)` -- the one drizzle-orm's
// postgres-js driver actually calls to run a compiled query (see
// drizzle-orm/postgres-js/session.js). It's used both as the plain
// awaited result (no-fields queries) and via `.values()` (queries that
// specify column selections, e.g. `.select({ id: ..., companyId: ... })`),
// which drizzle expects as an array of positional value-tuples in the same
// order as the select()'s field list. It defaults to `[]` -- a route that
// does a real scoped `db.select()...` (rather than going through a mocked
// service, as almost every route in this wave does) needs its test to pass
// the exact tuple shape its query produces; getting that wrong silently
// would be worse than the query simply coming back empty.
const FAKE_DRIVER_OPTIONS = {
  parsers: {},
  serializers: {},
  types: {
    numeric: {},
    timestamp: {},
    timestamptz: {},
    bigint: {},
    date: {},
    interval: {},
  },
};

function makeFakeReservedConnection(unsafeRows: unknown[]) {
  const reserved = async (..._args: unknown[]) => [];
  Object.assign(reserved, {
    release: () => {},
    options: FAKE_DRIVER_OPTIONS,
    unsafe: (..._args: unknown[]) => {
      const result: Promise<unknown[]> & { values?: () => Promise<unknown[]> } = Promise.resolve(unsafeRows);
      result.values = () => Promise.resolve(unsafeRows);
      return result;
    },
  });
  return reserved;
}

export function withFakeCompanyScopeReserve<T extends object>(fakeDb: T, opts: { unsafeRows?: unknown[] } = {}): T {
  const unsafeRows = opts.unsafeRows ?? [];
  Object.defineProperty(fakeDb, "$client", {
    value: {
      options: FAKE_DRIVER_OPTIONS,
      reserve: async () => makeFakeReservedConnection(unsafeRows),
    },
    enumerable: false,
    configurable: true,
  });
  return fakeDb;
}
