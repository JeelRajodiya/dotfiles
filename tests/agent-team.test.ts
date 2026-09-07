// Run: node tests/agent-team.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contextTokensFromUsage,
	hasRunningAgent,
	latestAssistantContextTokens,
} from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

assert.equal(contextTokensFromUsage({ totalTokens: 23_456, input: 1 }), 23_456);
assert.equal(
	contextTokensFromUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
	100,
);

const dir = mkdtempSync(join(tmpdir(), "agent-team-"));
const session = join(dir, "child.json");
try {
	writeFileSync(session, [
		"not json",
		JSON.stringify({ type: "message", message: { role: "user", usage: { totalTokens: 999 } } }),
		JSON.stringify({ type: "message", message: { role: "assistant" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1200 } } }),
	].join("\n"));
	assert.equal(latestAssistantContextTokens(session), 1200);

	appendFileSync(session, `\n${JSON.stringify({
		type: "message",
		message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 400 } },
	})}\n{malformed`);
	assert.equal(latestAssistantContextTokens(session), 1900);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

assert.equal(hasRunningAgent([{ status: "idle" }, { status: "done" }]), false);
assert.equal(hasRunningAgent([{ status: "idle" }, { status: "running" }]), true);

console.log("PASS: agent context accounting, restoration, malformed lines, and switch guard");
