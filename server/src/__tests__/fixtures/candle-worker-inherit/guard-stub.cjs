// Stands in for node-module-guard.cjs: marks the realm it was --require'd into.
globalThis[Symbol.for("test.moduleGuard")] = true;
