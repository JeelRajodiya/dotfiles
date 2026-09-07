// Run: node tests/agent-defs.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTeams } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-defs.ts";
import { canClearAgent, parseTellArguments, resultDeliveryStatus, rootTools, shouldCompleteTellTarget } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import { renderCard } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-render.ts";

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

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const waitingCard = renderCard({
	name: "iterate", def: { name: "iterate", description: "" }, goal: "", task: "", status: "waiting",
	pendingOutcome: "error", toolCount: 0, elapsed: 12_000, contextTokens: 0, contextWindow: 0, tokens: { input: 0, output: 0 },
}, 80, plainTheme).join("\n");
assert.match(waitingCard, /↗/);
assert.match(waitingCard, /return error/);
console.log("PASS: teams parse; live token totals and queued child result states render correctly");
