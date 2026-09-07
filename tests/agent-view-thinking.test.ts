import assert from "node:assert/strict";
import { AGENT_VIEW_COMMAND, isAgentViewCommand } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityLog, cleanThoughtActivity, mergeThoughtActivity, thoughtActivityLabel } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-activity.ts";
import { renderThoughtActivity } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-render.ts";

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
assert.equal(thoughtActivityLabel(thought, 3_500), "Thinking (2s) — checking the RPC stream");

activity.appendThought("and retaining a bounded preview");
activity.finishThought("", 5_200);
thought = activity.list()[0]!;
assert.equal(thoughtActivityLabel(thought, 8_000), "Thought (4s) — checking the RPC stream and retaining a bounded preview");

const preview = renderThoughtActivity({ kind: "thought", text: "你好世界 and a long reasoning preview", startedAt: 1_000, finishedAt: 5_200 }, 24, 8_000);
assert.equal(visibleWidth(preview) <= 24, true);
assert.equal(preview.endsWith("…"), true);
console.log("PASS: agent view thought cleanup, deduplication, width truncation, and live/completed labels");
