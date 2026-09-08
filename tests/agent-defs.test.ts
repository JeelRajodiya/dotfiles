// Run: node tests/agent-defs.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTeams } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-defs.ts";
import { canClearAgent, canCompactAgent, formatAgentModelLabel, formatToolActivity, nextAgentName, parseOpenAIFastEnvValue, parseTellArguments, resultDeliveryStatus, rootTools, shouldCompleteTellTarget } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
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
assert.equal(canCompactAgent("done", false, true), true);
assert.equal(canCompactAgent("idle", true, true), false);
assert.equal(canCompactAgent("running", false, true), false);
assert.equal(canCompactAgent("waiting", false, true), false);
assert.equal(canCompactAgent("done", false, false), false);
assert.equal(nextAgentName("iterate", []), "iterate-1");
assert.equal(nextAgentName("iterate", ["iterate-1"]), "iterate-2");
assert.equal(nextAgentName("Iterate", ["iterate-1", "ITERATE-2", "iterate-4"]), "iterate-3");

assert.equal(parseOpenAIFastEnvValue("on"), true);
assert.equal(parseOpenAIFastEnvValue("off"), false);
assert.equal(parseOpenAIFastEnvValue("maybe"), undefined);

assert.equal(formatAgentModelLabel("openai-codex/gpt-5.6-sol", true), "gpt-5.6-sol (fast)");
assert.equal(formatAgentModelLabel("anthropic/claude-4", true), "claude-4");

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const elapsedCard = renderCard({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "done",
	model: "openai-codex/gpt-5.6-sol", fast: true, thinking: "high", toolCount: 7, elapsed: 12_000, contextTokens: 0,
	contextWindow: 0, tokens: { input: 1_200, output: 300 },
}, 80, plainTheme);
assert.equal(elapsedCard.length, 4);
assert.match(elapsedCard[1], /7 · 12s/);
assert.match(elapsedCard[2], /gpt-5.6-sol \(fast\) · high/);

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
assert.match(grid.join("\n"), /↑↓ gpt-5.6-sol/);

const coloredTheme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[0m` };
assert.equal(renderCard({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "running",
	model: "openai-codex/gpt-5.6-sol", thinking: "high", toolCount: 0, elapsed: 0, contextTokens: 0, contextWindow: 0, tokens: { input: 0, output: 0 },
}, 20, coloredTheme).every(line => visibleWidth(line) <= 20), true);

const detail = renderDetail({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "done",
	toolCount: 0, elapsed: 1_000, contextTokens: 0, contextWindow: 0, tokens: { input: 0, output: 0 },
	model: "openai-codex/gpt-5.6-sol", fast: true,
}, 120, plainTheme, { model: formatAgentModelLabel("openai-codex/gpt-5.6-sol", true), activity: [], steerable: true }, 1);
assert.match(detail, /gpt-5.6-sol \(fast\)/);

assert.equal(formatToolActivity("bash", { command: "git status --short" }), "git status --short");
assert.equal(formatToolActivity("read", { path: "src/main.ts" }), "src/main.ts");
assert.equal(formatToolActivity("bash", {}), "bash");
const compactDetail = renderDetail({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "done",
	toolCount: 0, elapsed: 0, contextTokens: 0, contextWindow: 0, tokens: { input: 0, output: 0 }, model: "test/model",
}, 40, plainTheme, {
	model: "test/model", steerable: true,
	activity: [
		{ kind: "assistant", text: "assistant row\ncontinued " + "x".repeat(50) },
		{ kind: "thought", text: "thought row " + "x".repeat(50), startedAt: 0, finishedAt: 0 },
		{ kind: "tool-start", text: formatToolActivity("bash", { command: "git status --short --branch " + "x".repeat(50) }) },
		{ kind: "tool-done", text: "tool done row" },
		{ kind: "tool-error", text: "tool error row" },
	],
}, 0);
const compactRows = compactDetail.split("\n");
assert.equal(compactRows.filter(row => /assistant row continued|Thinking \(0s\) — thought row|git status --short|tool done row|tool error row/.test(row)).length, 5);
assert.equal(compactRows.some(row => row.includes("◆") || row.includes("bash — command:")), false);
assert.equal(compactRows.every(row => visibleWidth(row) <= 40), true);
assert.equal(compactRows.some(row => row.includes("…")), true);

console.log("PASS: teams parse; compact activity rows, model label formatting, and rendering markers are correct");
