import assert from "node:assert/strict";
import { AGENT_VIEW_COMMAND, isAgentViewCommand } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityLog, cleanThoughtActivity, mergeThoughtActivity, thoughtActivityLabel } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-activity.ts";
import { renderActivityLine, renderThoughtActivity } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-render.ts";

assert.equal(AGENT_VIEW_COMMAND, "view");
assert.equal(isAgentViewCommand("view"), true);
assert.equal(isAgentViewCommand("detail"), false);
assert.equal(cleanThoughtActivity("**Assessing** [delivery](https://example.com)\n- `queue` with *review* and _notes_"), "Assessing delivery queue with review and notes");
assert.equal(mergeThoughtActivity("Assessing delivery", "delivery queue"), "Assessing delivery queue");
assert.equal(mergeThoughtActivity("Assessing delivery queue", "Assessing delivery queue"), "Assessing delivery queue");

const activity = new ActivityLog();
activity.startThought(1_000);
activity.appendThought("checking the RPC stream");
let thought = activity.list()[0]!;
// A running thought drops the parenthetical: renderActivityLine puts a live counter in front of
// it, and "12s Thinking (12s)" reads as a bug.
assert.equal(thoughtActivityLabel(thought, 3_500), "Thinking — checking the RPC stream");

activity.appendThought("and retaining a bounded preview");
activity.finishThought("", 5_200);
thought = activity.list()[0]!;
assert.equal(thoughtActivityLabel(thought, 8_000), "Thought (4s) — checking the RPC stream and retaining a bounded preview");

const preview = renderThoughtActivity({ kind: "thought", text: "你好世界 and a long reasoning preview", startedAt: 1_000, finishedAt: 5_200 }, 24, 8_000);
assert.equal(visibleWidth(preview) <= 24, true);
// Compare the visible text: truncateToWidth closes its ellipsis with an ANSI reset, so the
// raw string ends with "…[0m" even when the reader sees the ellipsis last.
const visiblePreview = preview.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assert.equal(visiblePreview.endsWith("…"), true);

// --- live counters: the only thing separating a running row from a finished one
const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
const runningTool = renderActivityLine({ kind: "tool-start", text: "bash cargo test", at: 1_000 }, 60, theme, 5_000);
assert.match(runningTool, /^<warning>4s<\/warning> /, "a running command leads with its elapsed time");
assert.match(runningTool, /bash cargo test/);

const finishedTool = renderActivityLine({ kind: "tool-done", text: "bash cargo test · 4s", at: 5_000 }, 60, theme, 9_000);
assert.ok(!finishedTool.includes("<warning>"), "a finished command has no live counter");

const runningThought = renderActivityLine({ kind: "thought", text: "weighing options", startedAt: 1_000 }, 60, theme, 13_000);
assert.match(runningThought, /^<warning>12s<\/warning> /, "a running thought leads with its elapsed time");
assert.match(runningThought, /Thinking — weighing options/);
assert.ok(!/Thinking \(/.test(runningThought), "and does not repeat the duration behind the counter");

const doneThought = renderActivityLine({ kind: "thought", text: "settled", startedAt: 1_000, finishedAt: 4_000 }, 60, theme, 90_000);
assert.ok(!doneThought.includes("<warning>"), "a finished thought shows its final duration, not a live one");
assert.match(doneThought, /Thought \(3s\) — settled/);

const narrow = renderActivityLine({ kind: "tool-start", text: "x".repeat(200), at: 0 }, 20, theme, 3_000);
assert.ok(visibleWidth(narrow.replace(/<\/?\w+>/g, "")) <= 20, "the counter is counted against the width, not added on top");
console.log("PASS: agent view thought cleanup, dedup, width truncation, and live elapsed counters");
