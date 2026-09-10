// Run: node tests/context-window.test.ts
import assert from "node:assert/strict";
import { findCutIndex, formatRemaining, planNewContext } from "../dotfiles/agents/.pi/agent/extensions/lib/context-window.ts";

const messages = [
	{ role: "user", content: "old question" },
	{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
	{ role: "user", content: "second question" },
	{ role: "assistant", content: [{ type: "toolCall", id: "call-reset", name: "new_context" }] },
	{ role: "toolResult", toolCallId: "call-reset", content: [{ type: "text", text: "Context reset." }] },
	{ role: "assistant", content: [{ type: "text", text: "carrying on" }] },
];

assert.equal(findCutIndex(messages, "call-reset"), 3, "the cut lands on the assistant turn that made the call");
assert.equal(findCutIndex(messages, "never-happened"), -1, "an unknown call is reported, not guessed at");

const after = planNewContext(messages, 3, "Found the bug in parser.ts; tests still to write.");
assert.equal(after.length, 4, "everything before the call is gone");
assert.equal(after[0].role, "user", "the replacement opens on a user turn, which every provider accepts");
assert.match(JSON.stringify(after[0].content), /Found the bug in parser\.ts/, "the carry-over survives");
assert.deepEqual(after.slice(1), messages.slice(3), "the calling turn keeps its own tool result, so no call is orphaned");
assert.equal(planNewContext(messages, -1, "x"), messages, "a spent reset is a no-op");
assert.equal(planNewContext(messages, 0, "x"), messages, "and so is cutting at the very start");

assert.match(formatRemaining(120_000, 500_000), /380000 tokens remaining of 500000 \(76% free; 120000 used\)/);
assert.match(formatRemaining(null, 500_000), /not known yet/, "an unknown count is said plainly, not reported as zero");
assert.match(formatRemaining(600_000, 500_000), /^0 tokens remaining/, "an overfull window does not report negative space");
console.log("PASS: the agent can read its remaining context and reset it deliberately");
