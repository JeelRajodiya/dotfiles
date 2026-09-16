// Run: node tests/agent-team-variants-runtime.test.ts
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import agentTeam from "../dotfiles/agents/.pi/agent/extensions/agent-team.ts";
import { OPENAI_FAST_SESSION_EVENT } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

const agentDir = mkdtempSync(join(tmpdir(), "agent-team-variants-"));
cpSync("dotfiles/agents/.pi/agent/agents", join(agentDir, "agents"), { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const fastEvents: unknown[] = [];
	const notifications: string[] = [];
	const selections: string[] = [];
	const modelChanges: string[] = [];
	const thinkingChanges: string[] = [];
	const events = new EventEmitter();
	events.on(OPENAI_FAST_SESSION_EVENT, event => fastEvents.push(event));
	const models = ["sol", "terra", "luna"].map(name => ({ provider: "openai-codex", id: `gpt-5.6-${name}`, contextWindow: 1000 }));
	const ctx: any = {
		cwd: process.cwd(),
		model: models[0],
		thinkingLevel: "medium",
		modelRegistry: {
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
			getAvailable: () => models,
		},
		sessionManager: { getEntries: () => entries, getSessionId: () => "runtime-test" },
		ui: {
			addAutocompleteProvider: () => {}, setStatus: () => {}, setWidget: () => {},
			notify: (message: string) => notifications.push(message),
			select: async (message: string) => { selections.push(message); return undefined; },
		},
		isIdle: () => true,
		waitForIdle: async () => {},
		getContextUsage: () => undefined,
	};
	const pi: any = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		events,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: () => {}, registerMessageRenderer: () => {}, registerShortcut: () => {},
		getActiveTools: () => ["read", "bash"], setActiveTools: () => {},
		setModel: async (model: any) => { modelChanges.push(`${model.provider}/${model.id}`); ctx.model = model; return true; },
		setThinkingLevel: (level: string) => { thinkingChanges.push(level); ctx.thinkingLevel = level; },
	};
	agentTeam(pi);
	await handlers.get("session_start")!({}, ctx);
	const run = (args: string) => commands.get("agents").handler(args, ctx);

	await run("variant sol-terra-fast");
	assert.equal(modelChanges.length, 0, "the orchestrator override keeps the root on sol");
	assert.equal(thinkingChanges.at(-1), "medium");
	assert.deepEqual(fastEvents.at(-1), { enabled: true });
	assert.equal(entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data.variant, "sol-terra-fast");
	await run("model worker");
	assert.match(selections.at(-1)!, /gpt-5\.6-terra \(variant\)/, "child settings use the active variant");

	await run("variant default");
	assert.equal(ctx.model.id, "gpt-5.6-sol", "default restores the pre-variant root model");
	assert.deepEqual(fastEvents.at(-1), { enabled: false });
	assert.equal(entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data.variant, undefined);

	await run("variant missing");
	assert.match(notifications.at(-1)!, /Unknown variant.*sol-fast.*sol-luna/);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
}
console.log("agent-team variant runtime checks passed");
