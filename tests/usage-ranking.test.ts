// Run: node tests/usage-ranking.test.ts
import assert from "node:assert/strict";
import { annotateAgentCompletion } from "../dotfiles/agents/.pi/agent/extensions/agent-team.ts";
import { completionEventForItem, MAX_COMPLETION_USAGE_KEYS, parseUsageEvents, rankCompletionItems, type UsageAutocompleteItem } from "../dotfiles/agents/.pi/agent/extensions/lib/completion-usage.ts";

const now = new Date("2026-02-01T00:00:00.000Z");
const nested: UsageAutocompleteItem[] = [
	{ value: "queue remove", label: "remove", usageKey: "agents.queue.remove" },
	{ value: "queue edit", label: "edit", usageKey: "agents.queue.edit" },
];
const ranked = rankCompletionItems(nested, "e", new Map([["agents.queue.edit", 10]]));
assert.equal(ranked[0]?.usageKey, "agents.queue.edit", "annotated choices rank at arbitrary nesting");
assert.equal(rankCompletionItems([
	{ value: "sol", label: "Sol", usageKey: "test.sol" },
	{ value: "something", label: "Something", usageKey: "test.something" },
], "sol", new Map([["test.something", 1000]]))[0]?.usageKey, "test.sol", "fuzzy relevance remains above usage");

const selected = { value: "queue edit user task", label: "private task", description: "private description", usageKey: "agents.queue.edit" };
const event = completionEventForItem(selected, now);
assert.equal(event, '{"v":1,"type":"completion","key":"agents.queue.edit","timestamp":"2026-02-01T00:00:00.000Z"}');
assert.ok(!event!.includes(selected.value) && !event!.includes(selected.label) && !event!.includes(selected.description!), "only the stable key is persisted");
assert.equal(completionEventForItem({ value: "agent-7", label: "agent-7" }), undefined, "unannotated choices are never recorded");
assert.deepEqual(rankCompletionItems([
	{ value: "dynamic-a", label: "dynamic-a" },
	{ value: "dynamic-b", label: "dynamic-b" },
], "", new Map([["dynamic-b", 1000]])).map(item => item.value), ["dynamic-a", "dynamic-b"], "unannotated choices are never ranked");

const events = parseUsageEvents([
	JSON.stringify({ type: "command", key: "legacy-command", timestamp: now.toISOString() }),
	JSON.stringify({ v: 1, type: "completion", key: "agents.grid.2", timestamp: now.toISOString() }),
	JSON.stringify({ v: 1, type: "completion", key: "agents.grid.3", timestamp: "2025-12-31T23:59:59.000Z" }),
	JSON.stringify({ v: 2, type: "completion", key: "agents.grid.4", timestamp: now.toISOString() }),
	JSON.stringify({ v: 1, type: "completion", key: "bad key", timestamp: now.toISOString() }),
	"{ malformed",
].join("\n"), now);
assert.equal(events.commands.get("legacy-command"), 1, "old command events remain compatible");
assert.deepEqual([...events.completions], [["agents.grid.2", 1]], "expired, unknown, and malformed completion events fail closed");
const capped = parseUsageEvents(Array.from({ length: MAX_COMPLETION_USAGE_KEYS + 1 }, (_, index) =>
	JSON.stringify({ v: 1, type: "completion", key: `test.key.${index}`, timestamp: now.toISOString() }),
).join("\n"), now).completions;
assert.equal(capped.size, MAX_COMPLETION_USAGE_KEYS);
assert.equal(capped.has("test.key.0") && capped.has(`test.key.${MAX_COMPLETION_USAGE_KEYS}`), false, "completion key cap is deterministic");

const topLevel = annotateAgentCompletion("", [{ value: "add", label: "add" }, { value: "queue", label: "queue" }, { value: "tell", label: "tell" }]);
assert.deepEqual(topLevel.map(item => (item as UsageAutocompleteItem).usageKey), ["agents.command.add", "agents.command.queue", "agents.command.tell"]);
assert.equal((annotateAgentCompletion("add ", [{ value: "add custom", label: "Custom…" }])[0] as UsageAutocompleteItem).usageKey, "agents.add.custom");
const staticItems = annotateAgentCompletion("fast agent-7 ", [{ value: "fast agent-7 on", label: "on" }, { value: "fast agent-7 off", label: "off" }]);
assert.deepEqual(staticItems.map(item => (item as UsageAutocompleteItem).usageKey), ["agents.fast.on", "agents.fast.off"]);
assert.deepEqual(annotateAgentCompletion("auto-spawn ", [{ value: "auto-spawn on", label: "on" }, { value: "auto-spawn limit", label: "limit" }]).map(item => (item as UsageAutocompleteItem).usageKey), ["agents.auto-spawn.on", "agents.auto-spawn.limit"]);
assert.deepEqual(annotateAgentCompletion("grid ", [{ value: "grid 1", label: "1" }, { value: "grid 6", label: "6" }]).map(item => (item as UsageAutocompleteItem).usageKey), ["agents.grid.1", "agents.grid.6"]);
assert.equal((annotateAgentCompletion("team ", [{ value: "team off", label: "off" }])[0] as UsageAutocompleteItem).usageKey, "agents.team.off");
assert.equal((annotateAgentCompletion("tell ", [{ value: "tell agent-7", label: "agent-7" }])[0] as UsageAutocompleteItem).usageKey, undefined, "agent names stay dynamic");
assert.equal((annotateAgentCompletion("model agent-7 ", [{ value: "model agent-7 inherit", label: "inherit" }])[0] as UsageAutocompleteItem).usageKey, "agents.model.inherit");
assert.equal((annotateAgentCompletion("model agent-7 ", [{ value: "model agent-7 vendor/model", label: "vendor/model" }])[0] as UsageAutocompleteItem).usageKey, undefined, "models stay dynamic");
assert.equal((annotateAgentCompletion("queue edit id-7 task ", [{ value: "queue edit id-7 task private", label: "private" }])[0] as UsageAutocompleteItem).usageKey, undefined, "queue IDs and task text stay dynamic");

console.log("PASS: completion usage ranking records only static keys and preserves dynamic privacy");
