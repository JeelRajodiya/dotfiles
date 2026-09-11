// Run: node tests/agent-defs.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentMarkdown, parseTeams } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-defs.ts";
import { canClearAgent, canCompactAgent, canSteerAgent, formatAgentModelLabel, formatToolActivity, instanceSuffix, nextAgentName, parseOpenAIFastEnvValue, parseTellArguments, readChildSession, resolveAgentThinking, resultDeliveryStatus, runConcurrent, shouldCompleteTellTarget } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { displayName, renderCard, renderDetail, renderGrid } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-render.ts";
import { ActivityLog } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-activity.ts";

assert.deepEqual(parseTeams("flat:\n  - planner\n  - builder\nrooted:\n  main: understand\n  subs:\n    - iterate\n"), {
	flat: { members: ["planner", "builder"] },
	rooted: { root: "understand", members: ["iterate"] },
});
assert.deepEqual(parseTeams(readFileSync("dotfiles/agents/.pi/agent/agents/teams.yaml", "utf8"))["tracer-worker"], {
	root: "tracer", members: ["worker"],
});
const agent = (thinking?: string) => parseAgentMarkdown(`---\nname: specialist${thinking === undefined ? "" : `\nthinking: ${thinking}`}\n---\nprompt`, "specialist.md")!;
assert.equal(agent("low").thinking, "low");
assert.equal(agent("medium").thinking, "medium");
assert.equal(resolveAgentThinking(agent("invalid").thinking, "high"), "high");
assert.equal(resolveAgentThinking(agent().thinking, "high"), "high");
assert.equal(resolveAgentThinking(agent().thinking, undefined), "off");
assert.equal(resolveAgentThinking(agent("off").thinking, "high"), "off");
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
assert.equal(canSteerAgent("running", false), true);
assert.equal(canSteerAgent("running", true), false);
assert.equal(canSteerAgent("done", false), false);
const starts: string[] = [];
let resolveFirst!: (value: string) => void;
let rejectSecond!: (error: Error) => void;
const concurrent = runConcurrent([
	() => { starts.push("first"); return new Promise<string>(resolve => { resolveFirst = resolve; }); },
	() => { starts.push("second"); return new Promise<string>((_resolve, reject) => { rejectSecond = reject; }); },
]);
assert.deepEqual(starts, ["first", "second"], "all compactions start before any settles");
resolveFirst("first"); rejectSecond(new Error("failed"));
assert.deepEqual((await concurrent).map(result => result.status), ["fulfilled", "rejected"]);
// A lone specialist carries no suffix at all: with one of each type the letter would be on every
// card and mean nothing.
assert.equal(nextAgentName("worker", []), "worker");
assert.equal(nextAgentName("worker", ["worker"]), "worker-b", "the second starts at B, since the bare name is already A");
assert.equal(nextAgentName("Worker", ["worker", "WORKER-B", "worker-d"]), "worker-c", "case-insensitive, and it fills the first free letter");
assert.equal(nextAgentName("worker", ["worker-b"]), "worker", "a free base name is taken before any letter");
assert.equal(instanceSuffix(0), "a");
assert.equal(instanceSuffix(25), "z");
assert.equal(instanceSuffix(26), "aa", "the sequence continues past z rather than colliding");
assert.equal(instanceSuffix(701), "zz");
assert.equal(displayName("iterate-a"), "Iterate A", "the dash is a key separator, not something the user reads");
assert.equal(displayName("understand-aa"), "Understand Aa");

assert.equal(parseOpenAIFastEnvValue("on"), true);
assert.equal(parseOpenAIFastEnvValue("off"), false);
assert.equal(parseOpenAIFastEnvValue("maybe"), undefined);

assert.equal(formatAgentModelLabel("openai-codex/gpt-5.6-sol", true), "gpt-5.6-sol (fast)");
assert.equal(formatAgentModelLabel("anthropic/claude-4", true), "claude-4");

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
// The cards render the display form too, not just the detail pane.
const card = renderCard({ name: "tracer-b", def: { name: "tracer", description: "" }, goal: "", task: "", status: "idle", toolCount: 0, elapsed: 0, contextTokens: 0, contextWindow: 500_000, tokens: { input: 0, output: 0 }, model: "test/model" }, 40, plainTheme, 0).join(" ");
assert.match(card.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""), /Tracer B/, "cards show the spaced, capitalised form");
const elapsedAgent = {
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "done" as const,
	model: "openai-codex/gpt-5.6-sol", fast: true, thinking: "high", toolCount: 7, elapsed: 12_000, contextTokens: 0,
	contextWindow: 0, tokens: { input: 1_200, output: 300 },
};
const elapsedCard = renderCard(elapsedAgent, 80, plainTheme);
assert.equal(elapsedCard.length, 4);
assert.match(elapsedCard[1], /7 · 12s/);
const longRunCard = renderCard({ ...elapsedAgent, elapsed: 210_000 }, 80, plainTheme);
assert.match(longRunCard[1], /3m30s/, "a run past a minute reads in minutes, not 210s");
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
assert.equal(formatToolActivity("read", { path: "src/main.ts" }), "Read src/main.ts");
assert.equal(formatToolActivity("edit", { path: "src/main.ts" }), "Edit src/main.ts");
assert.equal(formatToolActivity("write", { path: "src/main.ts" }), "Write src/main.ts");
assert.equal(formatToolActivity("grep", { pattern: "TODO", path: "src" }), "Search TODO in src");
assert.equal(formatToolActivity("bash", {}), "bash");

const liveActivity = new ActivityLog();
liveActivity.startTool("read-1", "Read src/main.ts");
liveActivity.startTool("read-2", "Read src/main.ts");
liveActivity.finishTool("read-2", "tool-done", "Read src/main.ts · 0s");
liveActivity.finishTool("read-1", "tool-error", "Read src/main.ts · 1s — denied");
liveActivity.startTool("pending", "Edit src/main.ts");
liveActivity.finishTool(undefined, "tool-done", "Write src/main.ts · 0s");
assert.deepEqual(liveActivity.list().map(({ kind, text }) => [kind, text]), [
	["tool-error", "Read src/main.ts · 1s — denied"],
	["tool-done", "Read src/main.ts · 0s"],
	["tool-start", "Edit src/main.ts"],
	["tool-done", "Write src/main.ts · 0s"],
], "identified concurrent calls collapse in their original order; pending and missing-ID results stay distinct");
const cappedActivity = new ActivityLog();
for (let index = 0; index < 25; index++) cappedActivity.startTool(`tool-${index}`, `Read ${index}`);
assert.equal(cappedActivity.list().length, 24, "one-row tool tracking retains the activity cap");

const sessionDir = mkdtempSync(join(tmpdir(), "agent-activity-"));
const childSession = join(sessionDir, "child.jsonl");
writeFileSync(childSession, [
	JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [
		{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/main.ts" } },
		{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/main.ts" } },
	] } }),
	JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "read-2", toolName: "read", content: [], isError: false } }),
	JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "missing", toolName: "write", content: [{ type: "text", text: "denied" }], isError: true } }),
].join("\n"));
const recovered = ActivityLog.parse(readChildSession(childSession).activity).list();
assert.deepEqual(recovered.map(({ kind, text }) => [kind, text]), [
	["tool-start", "Read src/main.ts"],
	["tool-done", "Read src/main.ts · 1s"],
	["tool-error", "Write — denied"],
], "recovery collapses matched calls, preserves pending starts, and retains unmatched failures");
rmSync(sessionDir, { recursive: true, force: true });
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
assert.equal(compactRows.filter(row => /assistant row continued|Thought \(0s\) — thought row|git status --short|tool done row|tool error row/.test(row)).length, 5);
assert.equal(compactRows.some(row => row.includes("◆") || row.includes("bash — command:")), false);
assert.equal(compactRows.every(row => visibleWidth(row) <= 40), true);
assert.equal(compactRows.some(row => row.includes("…")), true);

console.log("PASS: teams parse; compact activity rows, model label formatting, and rendering markers are correct");
