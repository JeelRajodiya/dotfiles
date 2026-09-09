import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTokenCounts, formatAgentTokens, readChildSession, tokenCountsFromUsage } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

assert.deepEqual(addTokenCounts({ input: 32_000, output: 3_000 }, tokenCountsFromUsage({ input: 100, output: 20 })), { input: 32_100, output: 3_020 });
assert.equal(formatAgentTokens({ input: 32_100, output: 3_020 }), "↑32k ↓3k");
const dir = mkdtempSync(join(tmpdir(), "agent-team-"));
try {
	const session = join(dir, "agent.json");
	writeFileSync(session, [
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 32_000, output: 3_000 } } }),
		JSON.stringify({ type: "compaction", usage: { input: 100, output: 20 } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", usage: { input: 999, output: 999 } } }),
	].join("\n"));
	assert.deepEqual(readChildSession(session).tokens, { input: 33_099, output: 4_019 });
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("PASS: agent token totals aggregate and format compactly");
