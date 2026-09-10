// Run: node tests/agent-peek.test.ts
import assert from "node:assert/strict";
import {
	formatAgentPeek, formatPeekEntry, PEEK_DEFAULT_ENTRIES, peekInFlightTool, selectPeekEntries,
} from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { ActivityLog, type ActivityEntry } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-activity.ts";

const NOW = 1_000_000;
const at = (secondsAgo: number) => NOW - secondsAgo * 1000;

// --- the log keeps depth for peeking without widening the detail pane ---
const log = new ActivityLog(400);
// Alternated deliberately: consecutive assistant deltas coalesce into one streaming entry.
for (let index = 0; index < 30; index++) {
	log.startTool(`call-${index}`, `Read src/${index}.ts`);
	log.append("assistant", `reply ${index}`);
}
assert.equal(log.size, 60, "a 400-entry log holds far more than the 24 the detail pane draws");
assert.equal(log.list("", 24).length, 24, "the detail pane still asks for its own 24 lines");
assert.equal(log.list().length, 60, "peeking sees everything the log kept");
assert.equal(log.list("", 0).length, 0, "a zero limit is honoured rather than treated as unlimited");
assert.equal(log.list("fallback").at(-1)!.text, "reply 29", "a non-empty log ignores the fallback");
assert.deepEqual(new ActivityLog().list("only a final message").map(entry => entry.text), ["only a final message"]);

// --- live entries are dated, restored ones are honestly undated ---
const live = new ActivityLog(400);
live.startTool("call-1", "Bash npm test");
assert.equal(typeof live.list()[0]!.at, "number", "a live tool call records when it started");
const restored = ActivityLog.parse("user: trace delivery\ntool-start: call-9\tRead src/foo.ts");
assert.deepEqual(restored.list().map(entry => entry.at), [undefined, undefined], "replayed transcript history is not dated with the clock");

// --- selection: newest first out of the tail, with a window and a budget ---
const entries: ActivityEntry[] = [
	{ kind: "user", text: "trace the delivery path", at: at(600) },
	{ kind: "tool-done", text: "Read src/a.ts · 1s", toolCallId: "a", at: at(300) },
	{ kind: "tool-done", text: "Read src/b.ts · 1s", toolCallId: "b", at: at(120) },
	{ kind: "tool-error", text: "Bash npm test — exit 1", toolCallId: "c", at: at(60) },
	{ kind: "tool-start", text: "Bash npm test --watch", toolCallId: "d", at: at(45) },
];

assert.deepEqual(selectPeekEntries(entries, { now: NOW }), { shown: entries, omitted: 0, total: 5 },
	`fewer entries than the ${PEEK_DEFAULT_ENTRIES}-entry default returns all of them`);
const two = selectPeekEntries(entries, { limit: 2, now: NOW });
assert.deepEqual(two.shown.map(entry => entry.text), ["Bash npm test — exit 1", "Bash npm test --watch"], "a limit keeps the newest, oldest first");
assert.equal(two.omitted, 3, "the caller is told how much it did not read");
assert.deepEqual(selectPeekEntries(entries, { limit: 500, now: NOW }).shown.length, 5, "a limit past the end is not an error");

const windowed = selectPeekEntries(entries, { limit: 50, withinMs: 200_000, now: NOW });
assert.deepEqual(windowed.shown.map(entry => entry.toolCallId), ["b", "c", "d"], "a window drops work older than it");
assert.equal(windowed.omitted, 2);
const undated = selectPeekEntries([{ kind: "assistant", text: "no timestamp" }, entries[4]!], { withinMs: 60_000, now: NOW });
assert.deepEqual(undated.shown.map(entry => entry.text), ["Bash npm test --watch"], "an undatable entry cannot satisfy a time window");

const fat = Array.from({ length: 40 }, (_, index): ActivityEntry => ({ kind: "assistant", text: "x".repeat(400), at: at(index) }));
const budgeted = selectPeekEntries(fat, { limit: 40, maxChars: 2_000, now: NOW });
assert.equal(budgeted.shown.length, 4, "an oversized peek is trimmed to the character budget");
assert.equal(budgeted.shown.at(-1), fat.at(-1), "trimming drops the oldest, never the newest");
assert.equal(selectPeekEntries(fat, { limit: 40, maxChars: 10, now: NOW }).shown.length, 1, "a peek always returns at least one entry");

// --- lines carry the age, and a thought carries its own duration ---
assert.equal(formatPeekEntry(entries[1]!, NOW), "- 5m00s ago · tool·ok — Read src/a.ts · 1s");
assert.equal(formatPeekEntry(entries[4]!, NOW), "- 45s ago · tool·running — Bash npm test --watch");
assert.equal(formatPeekEntry({ kind: "assistant", text: "no clock" }, NOW), "- earlier · reply — no clock");
assert.equal(formatPeekEntry({ kind: "thought", text: "weighing two paths", startedAt: at(70), finishedAt: at(62), at: at(62) }, NOW),
	"- 1m02s ago · Thought (8s) — weighing two paths");

// --- the unfinished tool call is what answers "why is it slow" ---
assert.equal(peekInFlightTool(entries, "running", NOW), "Bash npm test --watch — running 45s");
assert.equal(peekInFlightTool(entries, "done", NOW), undefined, "a settled agent is not blocked on anything");
assert.equal(peekInFlightTool(entries.slice(0, 4), "running", NOW), undefined, "every tool call finished, so nothing is in flight");

// --- the assembled report ---
const view = {
	name: "understand-1", type: "understand", status: "running", goal: "Investigate the codebase",
	task: "trace the delivery path", model: "GPT-5.6 Sol (fast)", elapsed: 252_000, toolCount: 37,
	contextTokens: 62_000, contextWindow: 200_000, lastWork: "", history: [{ task: "map the router", outcome: "done" as const }],
};
const peeked = formatAgentPeek(view, entries, { limit: 2, now: NOW });
assert.equal(peeked.text, [
	"understand-1 (understand) — running · GPT-5.6 Sol (fast) · 4m12s on this run · 37 tool calls · 62k/200k context",
	"Goal: Investigate the codebase",
	"Current task: trace the delivery path",
	"In flight: Bash npm test --watch — running 45s",
	"Recent completed tasks: done:map the router",
	"",
	"Activity — 2 of 5 entries, oldest first (3 earlier not shown):",
	"- 1m00s ago · tool·failed — Bash npm test — exit 1",
	"- 45s ago · tool·running — Bash npm test --watch",
	"",
	"Read from understand-1's activity log — it was not prompted, steered, or interrupted.",
].join("\n"));
assert.deepEqual(peeked.selection.shown.length, 2);

const settled = formatAgentPeek(
	{ ...view, status: "waiting", pendingOutcome: "error", elapsed: 9_000, lastWork: "tests still failing", history: [] },
	[], { now: NOW },
);
assert.match(settled.text, /waiting \(error queued\)/);
assert.match(settled.text, /Last output: tests still failing/);
assert.match(settled.text, /Activity — nothing recorded yet\./);
assert.doesNotMatch(settled.text, /In flight:/, "a waiting agent is not blocked on a tool call");

const windowedReport = formatAgentPeek(view, entries, { limit: 50, withinMs: 200_000, now: NOW });
assert.match(windowedReport.text, /Activity — 3 of 5 entries within the last 3m20s, oldest first \(2 earlier not shown\):/);

console.log("PASS: peeking reads a child's activity by count, window, and budget without prompting it");
