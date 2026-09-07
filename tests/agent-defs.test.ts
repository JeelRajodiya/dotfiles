// Run: node tests/agent-defs.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTeams } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-defs.ts";
import { canClearAgent, formatAgentModelLabel, parseOpenAIFastEnvValue, parseTellArguments, resultDeliveryStatus, rootTools, shouldCompleteTellTarget } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { renderCard, renderDetail, renderGrid } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-render.ts";

assert.deepEqual(parseTeams("flat:\n  - planner\n  - builder\nrooted:\n  main: understand\n  subs:\n    - iterate\n"), {
	flat: { members: ["planner", "builder"] },
	rooted: { root: "understand", members: ["iterate"] },
});
assert.deepEqual(parseTeams(readFileSync("dotfiles/agents/.pi/agent/agents/teams.yaml", "utf8"))["understand-iterate"], {
	root: "understand", members: ["iterate"],
});
assert.deepEqual(rootTools(["read", "bash", "grep"], ["dispatch_agent", "set_agent_model", "read"]), ["read", "bash", "grep", "dispatch_agent", "set_agent_model"]);
assert.equal(resultDeliveryStatus("done", true), "waiting");
assert.equal(resultDeliveryStatus("error", true), "waiting");
assert.equal(resultDeliveryStatus("error", false), "error");
assert.deepEqual(parseTellArguments("iterate review the current diff"), { agent: "iterate", message: "review the current diff" });
assert.deepEqual(parseTellArguments("  iterate   check status  "), { agent: "iterate", message: "check status" });
assert.equal(parseTellArguments("iterate"), undefined);
assert.equal(parseTellArguments("   "), undefined);
assert.equal(shouldCompleteTellTarget(["tell"], true), true);
assert.equal(shouldCompleteTellTarget(["tell", "iterate"], false), true);
assert.equal(shouldCompleteTellTarget(["tell", "iterate"], true), false);
assert.equal(canClearAgent("done", false), true);
assert.equal(canClearAgent("running", false), false);
assert.equal(canClearAgent("waiting", false), false);
assert.equal(canClearAgent("idle", true), false);

assert.equal(parseOpenAIFastEnvValue("on"), true);
assert.equal(parseOpenAIFastEnvValue("off"), false);
assert.equal(parseOpenAIFastEnvValue("maybe"), undefined);

assert.equal(formatAgentModelLabel("openai-codex/gpt-5.6-sol", true), "gpt-5.6-sol (fast)");
assert.equal(formatAgentModelLabel("anthropic/claude-4", true), "claude-4");

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const elapsedCard = renderCard({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "done",
	model: "openai-codex/gpt-5.6-sol", fast: true, toolCount: 7, elapsed: 12_000, contextTokens: 0,
	contextWindow: 0, tokens: { input: 1_200, output: 300 },
}, 80, plainTheme);
assert.equal(elapsedCard.length, 4);
assert.match(elapsedCard[1], /7 · 12s/);
assert.match(elapsedCard[2], /gpt-5.6-sol \(fast\)/);

const waitingCard = renderCard({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "waiting",
	pendingOutcome: "error", model: "openai-codex/gpt-5.6-sol", fast: true, toolCount: 0, elapsed: 0, contextTokens: 0,
	contextWindow: 0, tokens: { input: 1_200, output: 300 },
}, 20, plainTheme);
assert.equal(waitingCard.length, 4);
assert.match(waitingCard[1], /↗.*return error/);
assert.notEqual(waitingCard[2].trim(), "│                │");

const grid = renderGrid([
	{
		name: "agent-a", def: { name: "agent-a", description: "" }, goal: "", task: "", status: "done", toolCount: 0, elapsed: 0, contextTokens: 0,
		contextWindow: 0, tokens: { input: 1_000, output: 500 }, model: "openai-codex/gpt-5.6-sol", fast: true,
	},
	{
		name: "agent-b", def: { name: "agent-b", description: "" }, goal: "", task: "", status: "done", toolCount: 0, elapsed: 0, contextTokens: 0,
		contextWindow: 0, tokens: { input: 2_000, output: 600 }, model: "openai-codex/gpt-5.6-sol", fast: true,
	},
	{
		name: "agent-c", def: { name: "agent-c", description: "" }, goal: "", task: "", status: "done", toolCount: 0, elapsed: 0, contextTokens: 0,
		contextWindow: 0, tokens: { input: 300, output: 90 }, model: "openai-codex/gpt-4o", fast: false,
	},
], 80, 3, plainTheme);
assert.equal(grid.length, 4);
assert.match(grid.join("\n"), /↑↓ gpt-5.6-sol \(fast\)/);


const detail = renderDetail({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "done",
	toolCount: 0, elapsed: 1_000, contextTokens: 0, contextWindow: 0, tokens: { input: 0, output: 0 },
	model: "openai-codex/gpt-5.6-sol", fast: true,
}, 120, plainTheme, { model: formatAgentModelLabel("openai-codex/gpt-5.6-sol", true), activity: [], steerable: true }, 1);
assert.match(detail, /gpt-5.6-sol \(fast\)/);

console.log("PASS: teams parse; openai fast parsing, model label formatting, and rendering markers are correct");
