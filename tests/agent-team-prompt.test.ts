// Run: node tests/agent-team-prompt.test.ts
// Guards the boundary, not the wording: volatile fields in the system prompt re-bill the whole
// conversation as uncached input on every turn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../dotfiles/agents/.pi/agent/extensions/agent-team.ts", import.meta.url), "utf8");
const body = (name: string) => {
	const start = source.indexOf(`const ${name} = (states: AgentState[]) => {`);
	assert.notEqual(start, -1, `${name} is missing`);
	const end = source.indexOf("\n\t};", start);
	assert.notEqual(end, -1, `${name} is not closed as expected`);
	return source.slice(start, end);
};

const roster = body("delegationRoster");
for (const volatileField of ["state.status", "state.elapsed", "state.task", "state.history"]) {
	assert.ok(!roster.includes(volatileField), `${volatileField} belongs in the turn-tail snapshot, not the system prompt`);
}
assert.ok(roster.includes("state.def.description") && roster.includes("state.def.tools"), "the roster still carries what an instance can do");

const status = body("delegationStatus");
assert.ok(!status.includes("state.elapsed"), "elapsed seconds change every turn and are already in the widget");
for (const field of ["state.status", "state.task", "state.history"]) {
	assert.ok(status.includes(field), `${field} is what the snapshot exists to report`);
}

assert.match(source, /if \(snapshot === lastStatusSnapshot\) return undefined;/, "an unchanged snapshot is not re-emitted");
assert.match(source, /customType: "agent-team-status"/, "the snapshot is delivered as a message, not prompt text");

const hook = source.slice(source.indexOf('pi.on("before_agent_start"'), source.indexOf('pi.events.on("openai-fast:changed"'));
assert.ok(!hook.includes("delegationStatus("), "the hook must not splice live status back into the prompt");
assert.equal(hook.match(/delegationRoster\(/g)?.length, 2, "both the rooted and dispatcher prompts carry the roster");
assert.equal(hook.match(/message: statusMessage\(/g)?.length, 2, "both paths deliver status at the turn tail");
console.log("PASS: only stable roster fields reach the system prompt");
