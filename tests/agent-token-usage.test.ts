import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTokenCounts, formatAgentContext, formatAgentTokens, formatCompactCount, readChildSession, tokenCountsFromUsage } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

assert.deepEqual(addTokenCounts({ input: 32_000, output: 3_000 }, tokenCountsFromUsage({ input: 100, output: 20 })), { input: 32_100, output: 3_020 });
assert.equal(formatAgentTokens({ input: 32_100, output: 3_020 }), "↑32k ↓3k");
// Past a thousand thousands the readout rolls up, so a long run never widens the card with "1540k".
assert.equal(formatAgentTokens({ input: 1_540_000, output: 999_600 }), "↑1.5M ↓1M");
assert.equal(formatCompactCount(12_300_000), "12M", "a second decimal place buys nothing at this size");
assert.equal(formatAgentContext(1_240_000, 2_000_000), "1.2M/2M");
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
