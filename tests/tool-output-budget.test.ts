// Run: node tests/tool-output-budget.test.ts
import assert from "node:assert/strict";
import {
	CLEAR_ABOVE_TOKENS,
	KEEP_TOKENS,
	clearedPlaceholder,
	estimateResultTokens,
	planClears,
	type ToolOutputResult,
} from "../dotfiles/agents/.pi/agent/extensions/lib/tool-output-budget.ts";

const result = (id: string, tokens: number, toolName = "bash"): ToolOutputResult => ({
	toolCallId: id,
	toolName,
	content: [{ type: "text", text: "x".repeat(tokens * 4) }],
});

assert.equal(estimateResultTokens([{ type: "text", text: "x".repeat(4000) }]), 1000, "four chars to a token");
assert.equal(estimateResultTokens([{ type: "image" }]), 1500, "an image is flat-rated, not measured by its base64");

// Under the ceiling nothing moves: a cut point that crept forward every turn would rewrite the
// cached prefix on every request, which costs far more than it saves.
const small = [result("a", 10_000), result("b", 10_000)];
assert.deepEqual(planClears(small, new Set()), [], "quiet sessions are left alone");

const overflowing: ToolOutputResult[] = Array.from({ length: 20 }, (_, i) => result(`t${i}`, 10_000));
const first = planClears(overflowing, new Set());
assert.ok(first.length > 0, "crossing the ceiling clears something");
assert.deepEqual(first, overflowing.slice(0, first.length).map(r => r.toolCallId), "oldest results go first");

const cleared = new Set(first);
const liveAfter = overflowing.filter(r => !cleared.has(r.toolCallId)).reduce((n, r) => n + estimateResultTokens(r.content), 0);
assert.ok(liveAfter <= KEEP_TOKENS, `clears down to the floor (${liveAfter} <= ${KEEP_TOKENS})`);
assert.ok(liveAfter > KEEP_TOKENS - 10_000, "and no further than the floor");

// The hysteresis is the whole point: re-running on the same history must be a no-op until enough
// new output has arrived to cross the ceiling again.
assert.deepEqual(planClears(overflowing, cleared), [], "a settled context stays settled");
const nearlyFull = [...overflowing, ...Array.from({ length: 5 }, (_, i) => result(`n${i}`, 10_000))];
assert.deepEqual(planClears(nearlyFull, cleared), [], "still quiet while the live total is under the ceiling");
const overAgain = [...overflowing, ...Array.from({ length: 8 }, (_, i) => result(`n${i}`, 10_000))];
assert.ok(planClears(overAgain, cleared).length > 0, "crossing again clears again");

// Small results are skipped - the note replacing them would not be meaningfully shorter.
const tiny: ToolOutputResult[] = [result("tiny", 50), ...Array.from({ length: 20 }, (_, i) => result(`big${i}`, 10_000))];
assert.ok(!planClears(tiny, new Set()).includes("tiny"), "a 50-token result is not worth a placeholder");

assert.match(clearedPlaceholder("bash", 12_000), /bash output cleared to save context \(~12000 tokens\)/);
assert.ok(CLEAR_ABOVE_TOKENS > KEEP_TOKENS, "ceiling above floor, or clearing would run every turn");
console.log("PASS: stale tool output is cleared in stable batches");
