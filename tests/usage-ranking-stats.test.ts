// Run: node tests/usage-ranking-stats.test.ts
//
// These assertions used to live inside extensions/usage-ranking.ts behind a
// PI_USAGE_RANK_SELF_TEST env guard, which meant bin/check.sh never ran them and the extension
// shipped 70 lines of test code to every session.
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseSessionLines } from "../dotfiles/agents/.pi/agent/extensions/lib/session-cost.ts";
import {
	alignColumns,
	commandFromText,
	commandSearchText,
	completedModelQuery,
	isInMonths,
	rank,
	requestsPerMessage,
	scanSession,
} from "../dotfiles/agents/.pi/agent/extensions/usage-ranking.ts";

// Skills are recognised from both the typed form and the expanded block.
assert.equal(commandFromText("/skill:commit-unstaged"), "skill:commit-unstaged");
assert.equal(commandFromText('<skill name="commit-unstaged" location="/tmp/SKILL.md">'), "skill:commit-unstaged");
assert.equal(commandFromText("ordinary message"), undefined);

// Columns line up across wide (double-width) glyphs.
const aligned = alignColumns([["Model", "Msg", "Cost"], ["模型", "1", "$2"], ["long-model", "123", "n/a"]]);
assert.equal(new Set(aligned.map(visibleWidth)).size, 1, "every aligned row is the same visible width");
assert.ok(aligned[1]!.includes("  1    $2"), "numeric columns stay right-aligned");

const now = new Date(2026, 0, 15);
for (const [timestamp, monthly, twoMonths] of [
	[new Date(2026, 0, 1).toISOString(), true, true],
	[new Date(2025, 11, 15).toISOString(), true, true],
	[new Date(2025, 11, 14).toISOString(), false, true],
	[new Date(2025, 10, 15).toISOString(), false, true],
	[new Date(2025, 10, 14).toISOString(), false, false],
	[new Date(2025, 10, 30).toISOString(), false, true],
	[new Date(2026, 1, 1).toISOString(), false, false],
	["invalid", false, false],
] as const) {
	assert.equal(isInMonths(timestamp, 1, now), monthly, `one-month window: ${timestamp}`);
	assert.equal(isInMonths(timestamp, 2, now), twoMonths, `two-month window: ${timestamp}`);
}
// A rolling month clamps to the shorter month rather than overflowing into the next one.
assert.equal(isInMonths(new Date(2026, 1, 28).toISOString(), 1, new Date(2026, 2, 31)), true);
assert.equal(isInMonths(new Date(2026, 1, 27).toISOString(), 1, new Date(2026, 2, 31)), false);
assert.equal(isInMonths(new Date(2026, 0, 16).toISOString(), 1, now), false);

const messages = new Map<string, number>();
const requests = new Map<string, number>();
const costs = new Map<string, number>();
const timestamp = new Date().toISOString();
const session = parseSessionLines([
	JSON.stringify({ type: "model_change", provider: "test", modelId: "sol" }),
	JSON.stringify({ type: "message", timestamp, message: { role: "user" } }),
	JSON.stringify({ type: "message", timestamp, message: { role: "assistant", provider: "test", model: "sol", usage: { cost: { total: 1.75 } } } }),
	JSON.stringify({ type: "message", timestamp: "2000-01-01T00:00:00Z", message: { role: "user" } }),
	"{ truncated write",
	JSON.stringify({ type: "message", timestamp, message: { role: "assistant", provider: "test", model: "sol" } }),
	JSON.stringify({ type: "message", timestamp, message: { role: "toolResult" } }),
	JSON.stringify({ type: "message", timestamp: "2000-01-01T00:00:00Z", message: { role: "assistant", provider: "test", model: "sol" } }),
	"",
].join("\n"));
scanSession(session, messages, costs, requests);
// The truncated line above must cost only itself, never the entries that follow it.
assert.equal(messages.get("test/sol"), 1);
assert.equal(requests.get("test/sol"), 2);
assert.equal(costs.get("test/sol"), 1.75);

assert.equal(requestsPerMessage(5, 2), "2.5 req/msg");
assert.equal(requestsPerMessage(0, 1), "0.0 req/msg");
assert.equal(requestsPerMessage(5, 0), "req/msg n/a");

assert.equal(rank(["a", "b", "c"], new Map([["b", 2], ["c", 1]]), value => value).join(""), "bca");
const commands = ["understand", "understand-fast", "understand-thorough", "skill:commit-unstaged", "subagents-doctor"];
const usage = new Map([["skill:commit-unstaged", 1000], ["understand-fast", 100]]);
for (const [query, first] of [["", "skill:commit-unstaged"], ["und", "understand-fast"],
	["UNDERSTAND", "understand"], ["skill:commit", "skill:commit-unstaged"]] as const) {
	assert.equal(rank(commands, usage, value => value, query)[0], first, `search ranking: ${query}`);
}
const matches = rank(commands, new Map([["skill:commit-unstaged", 1000]]), value => value, "und");
assert.equal(matches[0], "understand", "relevance outranks usage");
assert.equal(matches.length, commands.length, "ranking filters nothing out");

const skillCommands = ["compact", "skill:commit-unstaged", "skill:commit-push-pr", "understand"];
for (const [query, first] of [["com", "skill:commit-unstaged"], ["COM", "skill:commit-unstaged"],
	["compact", "compact"], ["ski", "skill:commit-unstaged"], ["skill:com", "skill:commit-unstaged"],
	["und", "understand"], ["", "skill:commit-unstaged"]] as const) {
	assert.equal(rank(skillCommands, usage, value => value, query, value => commandSearchText(value, query))[0], first,
		`skill namespace ranking: ${query}`);
}

const models = [{ id: "a", name: "Sol" }, { id: "b", name: "Something old" }];
assert.equal(rank(models, new Map([["b", 1000]]), model => model.id, "sol", model => model.name)[0]!.id, "a",
	"display-name relevance outranks usage");

for (const [submit, lines, expected] of [
	[true, ["/model "], ""],
	[true, ["/model sol"], "sol"],
	[false, ["/model "], undefined],
	[true, ["/models"], undefined],
] as const) {
	assert.equal(completedModelQuery(submit, [...lines]), expected, "model completion routing");
}

console.log("PASS: usage ranking windows, aggregation, and command ranking");
