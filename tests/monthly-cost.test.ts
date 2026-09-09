// Run: node tests/monthly-cost.test.ts
import assert from "node:assert/strict";
import { monthPrefix } from "../dotfiles/agents/.pi/agent/extensions/monthly-cost.ts";

// Session timestamps are UTC ISO strings, so the prefix they are matched against must be UTC.
// Deriving it from local getMonth() put every entry in the hours around a month boundary in the
// wrong month for anyone not on UTC.
assert.equal(monthPrefix(new Date("2026-03-01T00:30:00.000Z")), "2026-03");
assert.equal(monthPrefix(new Date("2026-02-28T23:30:00.000Z")), "2026-02");
assert.equal(monthPrefix(new Date("2026-09-08T12:00:00.000Z")), "2026-09");
// Single-digit months stay zero-padded so startsWith() cannot match 2026-1 against 2026-10.
assert.equal(monthPrefix(new Date("2026-01-15T12:00:00.000Z")), "2026-01");
assert.ok(!"2026-10-01T00:00:00Z".startsWith(monthPrefix(new Date("2026-01-15T12:00:00.000Z"))));

console.log("PASS: monthly cost buckets entries by UTC month");
