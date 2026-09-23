// Run: node tests/openai-fast-session.test.ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OPENAI_FAST_ENV, OPENAI_FAST_SESSION_EVENT } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";
import openAICodexFast from "../dotfiles/agents/.pi/agent/extensions/openai-codex-fast.ts";

const previous = process.env[OPENAI_FAST_ENV];
process.env[OPENAI_FAST_ENV] = "on";
try {
	const handlers = new Map<string, Function>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const events = new EventEmitter();
	const pi = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		events,
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		registerCommand: () => {},
	} as any;
	openAICodexFast(pi);
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-6-sol" },
		sessionManager: { getEntries: () => [{ type: "custom", customType: "openai-fast-session", data: { enabled: false } }] },
		ui: { notify: () => {} },
	};
	handlers.get("session_start")!({}, ctx);
	const request = () => handlers.get("before_provider_request")!({ payload: { model: "gpt-6-sol" } }, ctx).service_tier;
	assert.equal(request(), "default", "restored session override wins over the inherited/global setting");

	events.emit(OPENAI_FAST_SESSION_EVENT, { enabled: true });
	assert.equal(request(), "priority");
	assert.deepEqual(appended.at(-2), { type: "openai-fast-session", data: { enabled: true } });
	events.emit(OPENAI_FAST_SESSION_EVENT, { enabled: undefined });
	assert.equal(request(), "priority", "clearing the override reveals the inherited/global setting");
	assert.deepEqual(appended.at(-2), { type: "openai-fast-session", data: { enabled: null } });
	events.emit(OPENAI_FAST_SESSION_EVENT, { enabled: "invalid" });
	assert.equal(request(), "priority", "invalid session events are ignored");
} finally {
	if (previous === undefined) delete process.env[OPENAI_FAST_ENV];
	else process.env[OPENAI_FAST_ENV] = previous;
}
console.log("openai fast session override checks passed");
