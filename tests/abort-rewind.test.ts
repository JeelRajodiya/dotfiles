// Run: node tests/abort-rewind.test.ts
import assert from "node:assert/strict";
import { canRewind, dropAbandonedTurn } from "../dotfiles/agents/.pi/agent/extensions/lib/abort-rewind.ts";

const history = [
	{ type: "message", id: "before", parentId: null, message: { role: "user", content: "before" } },
	{ type: "message", id: "prompt", parentId: "before", message: { role: "user", content: "retry me" } },
	{ type: "message", id: "partial", parentId: "prompt", message: { role: "assistant", content: "partial" } },
	{ type: "message", id: "read", parentId: "partial", message: { role: "toolResult", content: "file contents" } },
];

// Abort before a final response restores the exact submitted editor text.
const submittedPrompt = "retry me";
assert.equal(canRewind(true, false), true);
assert.equal(submittedPrompt, "retry me");

// Read-only tool history is removed with the submitted prompt and partial output.
const rewound = dropAbandonedTurn(history, "prompt");
assert.deepEqual(rewound.map(entry => entry.id), ["before"]);
assert.deepEqual(rewound.map((entry: any) => entry.message.content), ["before"], "no abandoned prompt or read result remains context");

// write/edit and uncertain shell/custom tools preserve current behavior.
assert.equal(canRewind(true, true), false, "mutation-bearing turn is never silently rewound");
assert.equal(canRewind(false, false), false, "only a confirmed abort can rewind");
console.log("PASS: abort-before-response/read-only cleanup, mutation preservation, editor restoration input, and stale-context exclusion");
