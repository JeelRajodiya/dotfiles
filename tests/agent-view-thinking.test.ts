import assert from "node:assert/strict";
import { AGENT_VIEW_COMMAND, isAgentViewCommand } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { ActivityLog, thoughtActivityLabel } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-activity.ts";

assert.equal(AGENT_VIEW_COMMAND, "view");
assert.equal(isAgentViewCommand("view"), true);
assert.equal(isAgentViewCommand("detail"), false);

const activity = new ActivityLog();
activity.startThought(1_000);
activity.appendThought("checking the RPC stream");
let thought = activity.list()[0]!;
assert.equal(thoughtActivityLabel(thought, 3_500), "Thinking (2s) — checking the RPC stream");

activity.appendThought("and retaining a bounded preview");
activity.finishThought("", 5_200);
thought = activity.list()[0]!;
assert.equal(thoughtActivityLabel(thought, 8_000), "Thought (4s) — checking the RPC stream and retaining a bounded preview");
console.log("PASS: agent view command and live/completed thought rendering");
