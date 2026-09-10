// Run: node tests/agent-team-config.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../dotfiles/agents/.pi/agent/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const frontmatter = (path: string) => Object.fromEntries(
	read(path).match(/^---\n([\s\S]*?)\n---/)![1].split("\n").map(line => line.split(/:\s*/, 2)),
);

const team = read("agents/teams.yaml");
const orchestrator = read("agents/orchestrator.md");
const agentTeam = read("extensions/agent-team.ts");
assert.match(team, /^default:\n  main: orchestrator\n  auto-spawn: true\n  auto-spawn-limit: 3\n  subs:\n    - understand\n    - iterate\n    - reviewer$/m);
assert.match(read("settings.json"), /"npm:@juicesharp\/rpiv-ask-user-question"/);
assert.deepEqual(frontmatter("agents/orchestrator.md"), {
	name: "orchestrator",
	description: "User-facing coordinator with approval-gated implementation planning",
	model: "openai-codex/gpt-5.6-sol",
	tools: "dispatch_agent,peek_agent,route_agent,spawn_agent,kill_agent,interrupt_agent,set_agent_model,get_context_remaining,new_context",
});
const iterate = frontmatter("agents/iterate.md");
assert.deepEqual({ model: iterate.model, thinking: iterate.thinking, fast: iterate.fast }, {
	model: "openai-codex/gpt-5.6-sol", thinking: "low", fast: "true",
});
assert.ok(iterate.limitations);
const understand = frontmatter("agents/understand.md");
assert.deepEqual({ model: understand.model, thinking: understand.thinking, fast: understand.fast }, {
	model: "openai-codex/gpt-5.6-sol", thinking: "medium", fast: "false",
});
assert.ok(understand.limitations);
assert.match(orchestrator, /use Mermaid diagrams when they clarify the answer/);
assert.match(orchestrator, /When ask_user_question is available, you MUST use it for blocking clarifications, material alternatives, implementation-plan approval, and renewed approval after material scope changes\./);
assert.match(orchestrator, /Batch all known decisions into one call; never make back-to-back questionnaire calls\./);
assert.match(orchestrator, /Keep rhetorical questions, direct answers, status updates, nonblocking suggestions, and already-answered questions in prose\. If unavailable or noninteractive, ask the necessary question in text and wait\./);
assert.match(orchestrator, /An implementation request starts planning; it is not approval to implement an unseen plan\./);
assert.match(orchestrator, /Ask for explicit confirmation and wait for it before dispatching Iterate\./);
assert.match(read("agents/iterate.md"), /wait for renewed user approval before changing scope\./);
assert.equal(frontmatter("agents/reviewer.md").model, "openai-codex/gpt-5.6-sol");
assert.match(agentTeam, /const DEFAULT_TEAM = "default"/);
assert.match(agentTeam, /const TEAM_TOOLS = \["dispatch_agent", "peek_agent", "route_agent", "spawn_agent", "kill_agent", "interrupt_agent", "set_agent_model", "get_context_remaining", "new_context"\]/);
assert.match(agentTeam, /rootAgent \? TEAM_TOOLS : agentStates\.size \? TEAM_TOOLS : undefined/);
assert.match(agentTeam, /agent-team-routing/);
// An idle instance has no activeRun to read its level from; it must fall back to its own
// definition, not to whatever the host happens to be set to.
assert.match(agentTeam, /state\.activeRun\?\.thinking \?\? resolveAgentThinking\(state\.def\.thinking, widgetCtx\.thinkingLevel\)/);
assert.match(agentTeam, /relation=related steers only the named running instance/);
assert.match(orchestrator, /answer with peek_agent: it reads that instance's activity log without prompting it\./);
assert.match(orchestrator, /Never dispatch or steer a running agent just to request a status update\./);
assert.match(agentTeam, /Never dispatch or steer an agent merely to ask for a status update/);
console.log("agent-team default configuration check passed");
