import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const frontmatter = (path) => Object.fromEntries(
	read(path).match(/^---\n([\s\S]*?)\n---/)[1].split("\n").map(line => line.split(/:\s*/, 2)),
);

const team = read("agents/teams.yaml");
const orchestrator = read("agents/orchestrator.md");
assert.match(team, /^default:\n  main: orchestrator\n  auto-spawn: true\n  auto-spawn-limit: 3\n  subs:\n    - understand\n    - iterate\n    - reviewer$/m);
assert.match(read("settings.json"), /"npm:@juicesharp\/rpiv-ask-user-question"/);
assert.deepEqual(frontmatter("agents/orchestrator.md"), {
	name: "orchestrator",
	description: "User-facing coordinator with approval-gated implementation planning",
	model: "openai-codex/gpt-5.6-sol",
	tools: "dispatch_agent,route_agent,spawn_agent,kill_agent,interrupt_agent,set_agent_model",
});
for (const name of ["understand", "iterate"]) {
	const config = frontmatter(`agents/${name}.md`);
	assert.equal(config.model, "openai-codex/gpt-5.6-terra");
	assert.equal(config.fast, "true");
	assert.ok(config.limitations);
}
assert.match(orchestrator, /When ask_user_question is available, you MUST use it for blocking clarifications, material alternatives, implementation-plan approval, and renewed approval after material scope changes\./);
assert.match(orchestrator, /Batch all known decisions into one call; never make back-to-back questionnaire calls\./);
assert.match(orchestrator, /Keep rhetorical questions, direct answers, status updates, nonblocking suggestions, and already-answered questions in prose\. If unavailable or noninteractive, ask the necessary question in text and wait\./);
assert.match(orchestrator, /An implementation request starts planning; it is not approval to implement an unseen plan\./);
assert.match(orchestrator, /Ask for explicit confirmation and wait for it before dispatching Iterate\./);
assert.match(read("agents/iterate.md"), /wait for renewed user approval before changing scope\./);
assert.equal(frontmatter("agents/reviewer.md").model, "openai-codex/gpt-5.6-sol");
assert.match(read("extensions/agent-team.ts"), /const DEFAULT_TEAM = "default"/);
assert.match(read("extensions/agent-team.ts"), /rootAgent \? TEAM_TOOLS : agentStates\.size \? TEAM_TOOLS : undefined/);
assert.match(read("extensions/agent-team.ts"), /agent-team-routing/);
assert.match(read("extensions/agent-team.ts"), /relation=related steers only the named running instance/);
console.log("agent-team default configuration check passed");
