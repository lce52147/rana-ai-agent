import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_AVAILABLE, __test as storeTest, memoryStats } from "./store.js";

test("current Node exposes sqlite and the memory store reports its state", () => {
  assert.equal(MEMORY_AVAILABLE, true);
  assert.equal(memoryStats().status, "ok");
});

test("sqlite load failure disables memory without crashing the runtime", () => {
  let trace;
  const result = storeTest.loadDatabaseSync(() => {
    const error = new Error("unsupported");
    error.code = "ERR_UNKNOWN_BUILTIN_MODULE";
    throw error;
  }, (record) => { trace = record; });
  assert.equal(result.DatabaseSync, null);
  assert.equal(trace.status, "disabled");
  assert.equal(trace.reason, "node_sqlite_unavailable");
});
