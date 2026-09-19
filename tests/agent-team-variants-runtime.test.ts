// Run: node tests/agent-team-variants-runtime.test.ts
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import agentTeam from "../dotfiles/agents/.pi/agent/extensions/agent-team.ts";
import { OPENAI_FAST_SESSION_EVENT } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

const agentDir = mkdtempSync(join(tmpdir(), "agent-team-variants-"));
cpSync("dotfiles/agents/.pi/agent/agents", join(agentDir, "agents"), { recursive: true });
const teamsFile = join(agentDir, "agents", "teams.yaml");
writeFileSync(teamsFile, `${readFileSync(teamsFile, "utf8")}\nrootless:\n  default-variant: rootless-default\n  variants:\n    rootless-default:\n      all:\n        fast: false\n    rootless-other:\n      all:\n        fast: true\n`);
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
	let seededEntries: any[] = [];
	let autocompleteProvider: any;
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
		sessionManager: { getEntries: () => entries, getSessionId: () => "runtime-test", getSessionFile: () => "runtime-test.jsonl", getLeafId: () => undefined },
		ui: {
			addAutocompleteProvider: (provider: any) => { autocompleteProvider = provider; }, setStatus: () => {}, setWidget: () => {},
			notify: (message: string) => notifications.push(message),
			select: async (message: string) => { selections.push(message); return message === "Switch team session?" ? "start fresh" : undefined; },
		},
		isIdle: () => true,
		waitForIdle: async () => {},
		getContextUsage: () => undefined,
	};
	ctx.newSession = async ({ setup, withSession }: any) => {
		seededEntries = [];
		await setup({ appendCustomEntry: (customType: string, data: unknown) => seededEntries.push({ type: "custom", customType, data }) });
		await withSession({ ...ctx, sessionManager: { ...ctx.sessionManager, getEntries: () => seededEntries }, reload: async () => {} });
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
	const savedVariant = () => entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data.variant;

	assert.equal(ctx.model.id, "gpt-5.6-terra", "fresh startup selects balanced-terra automatically");
	assert.equal(thinkingChanges.at(-1), "medium");
	assert.deepEqual(fastEvents.at(-1), { enabled: false });
	assert.equal(savedVariant(), "balanced-terra", "the resolved default variant is persisted");
	const autocomplete = autocompleteProvider({ getSuggestions: () => null });
	const variantSuggestions = await autocomplete.getSuggestions(["/agents variant "], 0, 16, { force: true });
	assert.ok(variantSuggestions.items.some((item: any) => item.label === "balanced-terra"));
	assert.ok(!variantSuggestions.items.some((item: any) => item.label === "default"), "default is a hidden compatibility alias");
	await run("team default");
	const seededTeam = seededEntries.find(entry => entry.customType === "agent-team-instances").data;
	assert.deepEqual(seededTeam.rootBaseline, { model: "openai-codex/gpt-5.6-terra", thinking: "medium", fast: false });
	assert.equal(seededTeam.variant, "balanced-terra");
	entries.splice(0, entries.length, ...seededEntries);
	await handlers.get("session_start")!({}, ctx);
	assert.equal(savedVariant(), "balanced-terra", "a seeded team snapshot restores its configured default variant");
	await run("model worker");
	assert.match(selections.at(-1)!, /gpt-5\.6-terra \(variant\)/, "child settings use the active variant");

	await run("variant balanced-terra-fast");
	assert.equal(ctx.model.id, "gpt-5.6-terra", "a Terra root remains Terra in a fast variant");
	assert.deepEqual(fastEvents.at(-1), { enabled: true }, "a Terra root enables fast mode in a -fast variant");
	assert.equal(savedVariant(), "balanced-terra-fast", "selected variants persist");
	await handlers.get("session_start")!({}, ctx);
	assert.deepEqual(fastEvents.at(-1), { enabled: true }, "the persisted fast variant restores on startup");

	await run("variant default");
	assert.equal(ctx.model.id, "gpt-5.6-terra", "default resolves to balanced-terra");
	assert.deepEqual(fastEvents.at(-1), { enabled: false });
	assert.equal(savedVariant(), "balanced-terra", "default persists the configured variant");

	// A pre-default snapshot migrates once while the host is still on its original settings.
	entries.splice(0, entries.length, {
		type: "custom", customType: "agent-team-instances", data: {
			instances: ["orchestrator", "tracer", "worker", "reviewer"].map(name => ({ name, type: name, goal: name, sessionKey: name })),
			root: "orchestrator", team: "default",
		},
	});
	ctx.model = models[0];
	await handlers.get("session_start")!({}, ctx);
	const migrated = entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data;
	assert.equal(migrated.variant, "balanced-terra", "a snapshot without a variant persists the configured default");
	assert.deepEqual(migrated.rootBaseline, { model: "openai-codex/gpt-5.6-sol", thinking: "medium", fast: false });
	await handlers.get("session_start")!({}, ctx);
	const restored = entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data;
	assert.equal(restored.variant, "balanced-terra", "the migrated variant remains stable on reload");
	assert.deepEqual(restored.rootBaseline, migrated.rootBaseline, "reload keeps the original pre-variant baseline");

	await run("variant missing");
	assert.match(notifications.at(-1)!, /Unknown variant.*quality-sol.*turbo-plus-terra-fast/);

	entries.splice(0, entries.length, { type: "custom", customType: "agent-team-instances", data: { instances: [], team: "rootless" } });
	await handlers.get("session_start")!({}, ctx);
	const rootless = entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data;
	assert.equal(rootless.variant, "rootless-default", "a rootless snapshot persists its resolved default variant");
	assert.equal(rootless.rootBaseline, undefined, "a rootless team has no root baseline");
	writeFileSync(teamsFile, readFileSync(teamsFile, "utf8").replace("default-variant: rootless-default", "default-variant: rootless-other"));
	await handlers.get("session_start")!({}, ctx);
	assert.equal(entries.filter(entry => entry.customType === "agent-team-instances").at(-1).data.variant, "rootless-default", "the persisted rootless variant survives a later default change");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
}
console.log("agent-team variant runtime checks passed");
