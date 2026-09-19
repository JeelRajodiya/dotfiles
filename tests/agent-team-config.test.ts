// Run: node tests/agent-team-config.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTeams } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-defs.ts";

const root = new URL("../dotfiles/agents/.pi/agent/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const frontmatter = (path: string) => Object.fromEntries(
	read(path).match(/^---\n([\s\S]*?)\n---/)![1].split("\n").map(line => line.split(/:\s*/, 2)),
);

const team = read("agents/teams.yaml");
const orchestrator = read("agents/orchestrator.md");
const agentTeam = read("extensions/agent-team.ts");
assert.match(team, /^default:\n  main: orchestrator\n  auto-spawn: true\n  auto-spawn-limit: 3\n  default-variant: balanced-terra\n  subs:\n    - tracer\n    - worker\n    - reviewer\n  variants:/m);
assert.match(read("settings.json"), /"npm:@juicesharp\/rpiv-ask-user-question"/);
assert.deepEqual(frontmatter("agents/orchestrator.md"), {
	name: "orchestrator",
	description: "User-facing coordinator with approval-gated implementation planning",
	model: "openai-codex/gpt-5.6-sol",
	tools: "dispatch_agent,peek_agent,route_agent,spawn_agent,kill_agent,interrupt_agent,set_agent_model,get_context_remaining,new_context,read,bash",
});
const worker = frontmatter("agents/worker.md");
assert.deepEqual({ model: worker.model, thinking: worker.thinking, fast: worker.fast }, {
	model: "openai-codex/gpt-5.6-sol", thinking: "low", fast: "true",
});
assert.ok(worker.limitations);
const tracer = frontmatter("agents/tracer.md");
assert.deepEqual({ model: tracer.model, thinking: tracer.thinking, fast: tracer.fast }, {
	model: "openai-codex/gpt-5.6-sol", thinking: "medium", fast: "false",
});
assert.ok(tracer.limitations);
const reviewer = frontmatter("agents/reviewer.md");
assert.deepEqual({ model: reviewer.model, thinking: reviewer.thinking, fast: reviewer.fast }, {
	model: "openai-codex/gpt-5.6-sol", thinking: "medium", fast: "false",
}, "Reviewer pins its own depth instead of inheriting whatever the host is set to");
const parsed = parseTeams(team).default;
const variants = parsed.variants!;
assert.equal(parsed.defaultVariant, "balanced-terra");
const base = { orchestrator: frontmatter("agents/orchestrator.md"), worker, tracer, reviewer };
const outcome = (variant: string, agent: keyof typeof base) => ({
	model: variants[variant][agent]?.model ?? variants[variant].all?.model ?? base[agent].model,
	thinking: variants[variant][agent]?.thinking ?? variants[variant].all?.thinking ?? base[agent].thinking,
	fast: variants[variant][agent]?.fast ?? variants[variant].all?.fast ?? base[agent].fast === "true",
});
const sol = "openai-codex/gpt-5.6-sol";
const terra = "openai-codex/gpt-5.6-terra";
const luna = "openai-codex/gpt-5.6-luna";
const spark = "openai-codex/gpt-5.3-codex-spark";
const profile = (orchestrator: [string, boolean], tracer: [string, boolean], worker: [string, boolean], reviewer: [string, boolean], workerThinking = "medium") => ({
	orchestrator: { model: orchestrator[0], thinking: "medium", fast: orchestrator[1] },
	tracer: { model: tracer[0], thinking: "medium", fast: tracer[1] },
	worker: { model: worker[0], thinking: workerThinking, fast: worker[1] },
	reviewer: { model: reviewer[0], thinking: "medium", fast: reviewer[1] },
});
const profiles = {
	"quality-sol": profile([sol, false], [sol, false], [sol, false], [sol, false], "low"),
	"quality-sol-fast": profile([sol, false], [sol, true], [sol, true], [sol, true], "low"),
	"balanced-sol": profile([sol, false], [terra, false], [terra, false], [sol, false]),
	"balanced-sol-fast": profile([sol, false], [terra, true], [terra, true], [sol, true]),
	"balanced-terra": profile([terra, false], [terra, false], [terra, false], [sol, false]),
	"balanced-terra-fast": profile([terra, true], [terra, true], [terra, true], [sol, true]),
	"economy-sol": profile([sol, false], [luna, false], [luna, false], [luna, false]),
	"economy-sol-fast": profile([sol, false], [luna, true], [luna, true], [luna, true]),
	"economy-terra": profile([terra, false], [luna, false], [luna, false], [luna, false]),
	"economy-terra-fast": profile([terra, true], [luna, true], [luna, true], [luna, true]),
	"sprint-sol": profile([sol, false], [terra, false], [spark, false], [spark, false]),
	"sprint-sol-fast": profile([sol, false], [terra, true], [spark, false], [spark, false]),
	"turbo-sol": profile([sol, false], [sol, false], [spark, false], [sol, false]),
	"turbo-sol-fast": profile([sol, false], [sol, true], [spark, false], [sol, true]),
	"turbo-terra": profile([terra, false], [sol, false], [spark, false], [sol, false]),
	"turbo-terra-fast": profile([terra, true], [sol, true], [spark, false], [sol, true]),
	"turbo-plus-sol": profile([sol, false], [spark, false], [spark, false], [sol, false]),
	"turbo-plus-sol-fast": profile([sol, false], [spark, false], [spark, false], [sol, true]),
	"turbo-plus-terra": profile([terra, false], [spark, false], [spark, false], [sol, false]),
	"turbo-plus-terra-fast": profile([terra, true], [spark, false], [spark, false], [sol, true]),
};
assert.deepEqual(Object.keys(variants), Object.keys(profiles), "catalog has exactly the 20 approved profiles");
for (const [name, expected] of Object.entries(profiles)) for (const agent of Object.keys(base) as (keyof typeof base)[]) {
	assert.deepEqual(outcome(name, agent), expected[agent], `${name}/${agent}`);
}
const reviewerPrompt = read("agents/reviewer.md");
for (const level of ["P0", "P1", "P2"]) assert.match(reviewerPrompt, new RegExp(`\\[${level}\\]`), `Reviewer defines ${level}`);
// Delegation is decided by how long the orchestrator stays unavailable, not by task category.
assert.match(orchestrator, /The test is how long you stay unavailable, not what kind of work it is\./);
assert.doesNotMatch(orchestrator, /capability catalog/, "the runtime injects an agent-team-status snapshot now");
assert.doesNotMatch(read("agents/worker.md"), /the user (named|requested)/, "Worker is dispatched by Orchestrator and never sees the user");
assert.match(orchestrator, /use Mermaid diagrams when they clarify the answer/);
assert.match(orchestrator, /When ask_user_question is available, you MUST use it for blocking clarifications, material alternatives, implementation-plan approval, and renewed approval after material scope changes\./);
assert.match(orchestrator, /Batch all known decisions into one call; never make back-to-back questionnaire calls\./);
assert.match(orchestrator, /Keep rhetorical questions, direct answers, status updates, nonblocking suggestions, and already-answered questions in prose\. If unavailable or noninteractive, ask the necessary question in text and wait\./);
assert.match(orchestrator, /An implementation request starts planning; it is not approval to implement an unseen plan\./);
assert.match(orchestrator, /Ask for explicit confirmation and wait for it before dispatching Worker\./);
assert.match(read("agents/worker.md"), /wait for renewed user approval before changing scope\./);
assert.equal(frontmatter("agents/reviewer.md").model, "openai-codex/gpt-5.6-sol");
assert.match(agentTeam, /const DEFAULT_TEAM = "default"/);
assert.match(agentTeam, /const TEAM_TOOLS = \["dispatch_agent", "peek_agent", "route_agent", "spawn_agent", "kill_agent", "interrupt_agent", "set_agent_model", "get_context_remaining", "new_context", "read", "bash"\]/);
assert.match(agentTeam, /rootAgent \? TEAM_TOOLS : agentStates\.size \? TEAM_TOOLS : undefined/);
assert.match(agentTeam, /agent-team-routing/);
// The approval gate has to cover every path into Worker. route_agent and spawn_agent take an
// approved flag; dispatch_agent used to take none, so naming the instance directly walked past it.
assert.equal(agentTeam.match(/=== "worker" && !approved/g)?.length, 3, "dispatch, route and spawn are all gated");
// An idle instance has no activeRun to read its level from; it must fall back to its own
// definition, not to whatever the host happens to be set to.
assert.match(agentTeam, /state\.activeRun\?\.thinking \?\? effectiveThinking\(state, widgetCtx\)/);
assert.match(agentTeam, /relation=related steers only the named running instance/);
assert.match(orchestrator, /peek_agent reads that instance's activity log without prompting it\./);
assert.match(orchestrator, /Never dispatch or steer a running agent just to request a status update\./);
assert.match(agentTeam, /Never dispatch or steer an agent merely to ask for a status update/);
console.log("agent-team default configuration check passed");
