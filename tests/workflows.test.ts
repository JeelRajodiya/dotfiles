// Run: node tests/workflows.test.ts
import assert from "node:assert/strict";
import extension from "../dotfiles/agents/.pi/agent/extensions/workflows.ts";

const commands = new Map();
const events = new Map();
let tools = ["read", "edit", "write", "custom"];
let entries: unknown[] = [];
const messages: string[] = [];
const pi = {
	registerCommand: (name, command) => commands.set(name, command),
	on: (name, handler) => events.set(name, handler),
	getActiveTools: () => tools,
	getAllTools: () => ["read", "edit", "write", "custom"].map(name => ({ name })),
	setActiveTools: names => { tools = names; },
	appendEntry() {},
	sendUserMessage: text => messages.push(text),
	setModel() { assert.fail("Workflows must not change the model"); },
	setThinkingLevel() { assert.fail("Workflows must not change thinking level"); },
};
const ctx = {
	isIdle: () => true,
	sessionManager: { getEntries: () => entries },
	ui: { notify() {}, setStatus() {}, theme: { fg: (_, text) => text } },
};
extension(pi);
assert.deepEqual([...commands.keys()], ["iterate", "understand", "workflow"]);
for (const name of ["understand", "iterate"]) {
	await commands.get(name).handler("requested task", ctx);
	const prompt = events.get("before_agent_start")({ systemPrompt: "conversation context" }).systemPrompt;
	assert(prompt.startsWith("conversation context"));
	assert(prompt.includes(`# Active workflow: ${name}`));
	if (name === "understand") {
		assert(prompt.includes("## When asked to review changes"));
		assert(prompt.includes("## When asked for an implementation plan"));
		assert(events.get("tool_call")({ toolName: "write", input: { path: "code.ts" } }).block);
	} else {
		assert.equal(events.get("tool_call")({ toolName: "write", input: { path: "code.ts" } }), undefined);
	}
}
assert.equal(messages.length, 2);
await commands.get("workflow").handler("default", ctx);
assert.deepEqual(tools, ["read", "edit", "write", "custom"]);
assert.equal(events.get("before_agent_start")({ systemPrompt: "context" }), undefined);
// Legacy saved model settings must not change the currently selected model.
entries = [{ type: "custom", customType: "workflow-state", data: {
	name: "understand", defaultState: { model: "old-model", provider: "old-provider", tools: ["read"] },
} }];
await events.get("session_start")({}, ctx);
await commands.get("workflow").handler("default", ctx);
// A removed variant must not restore an earlier workflow from session history.
entries.push({ type: "custom", customType: "workflow-state", data: { name: "understand-fast" } });
await events.get("session_start")({}, ctx);
assert.equal(events.get("before_agent_start")({ systemPrompt: "context" }), undefined);
console.log("PASS: two model-neutral workflows, prompt injection, permissions, and session restoration");
