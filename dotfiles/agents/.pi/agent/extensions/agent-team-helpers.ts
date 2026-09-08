import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanActivity } from "./lib/agent-activity.ts";

/**
 * Support code for agent-team.ts, not an extension of its own.
 *
 * Pi auto-loads every `extensions/*.ts`, so this file is loaded as an extension whether
 * or not it wants to be; the empty default export is what makes that load a no-op.
 * (Moving it under `extensions/lib/` would avoid that, but stow links these files
 * individually and a move would leave a dangling symlink until the next sync.)
 */
export default function (_pi: ExtensionAPI): void {}

export function rootTools(hostTools: string[], teamTools: string[]): string[] {
	return [...new Set([...hostTools, ...teamTools])];
}

export function parseTellArguments(value: string): { agent: string; message: string } | undefined {
	const match = value.trim().match(/^(\S+)\s+([\s\S]*\S)$/);
	return match ? { agent: match[1], message: match[2] } : undefined;
}

/** Complete only the target; text after it belongs verbatim to the subagent. */
export function shouldCompleteTellTarget(parts: readonly string[], trailing: boolean): boolean {
	return parts.length === 1 && trailing || parts.length === 2 && !trailing;
}

export function canClearAgent(status: string, isRoot: boolean): boolean {
	return !isRoot && status !== "running" && status !== "waiting";
}

/** Only an active child has a process that can be interrupted. */
export function canInterruptAgent(status: string, isRoot: boolean): boolean {
	return !isRoot && status === "running";
}

export const isAgentReturning = (status: string): boolean => status === "waiting";

export function shouldIgnoreAgentRunEvent(finished: boolean, stopping: boolean): boolean {
	return finished || stopping;
}

type InterruptibleAgentState = {
	timer?: unknown; elapsed: number; activity: { closeOpenThoughts(): void; append(kind: string, value: unknown): void };
	sessionFile: string | null; lastWork: string; pendingOutcome?: AgentCompletionStatus; status: string; activeRun?: unknown;
};
type InterruptibleAgentRun = {
	finished: boolean; stopping: boolean; startTime: number; sessionFile: string;
	transport: { fail(error: Error): void };
	child: { exitCode: number | null; kill(signal: "SIGTERM" | "SIGKILL"): unknown; once(event: "close", callback: () => void): unknown };
};

/** Settle an interrupted child without scheduling a result delivery. */
export function interruptAgentRun(state: InterruptibleAgentState, run: InterruptibleAgentRun, clearTimer: () => void, now = Date.now()): boolean {
	if (shouldIgnoreAgentRunEvent(run.finished, run.stopping) || state.activeRun !== run) return false;
	run.finished = true;
	run.stopping = true;
	clearTimer();
	state.timer = undefined;
	state.elapsed = now - run.startTime;
	state.activity.closeOpenThoughts();
	state.lastWork = "Interrupted directly by the main agent.";
	state.activity.append("tool-error", state.lastWork);
	state.sessionFile = run.sessionFile;
	state.pendingOutcome = undefined;
	state.status = "error";
	state.activeRun = undefined;
	run.transport.fail(new Error("Agent interrupted directly"));
	terminateChild(run.child);
	return true;
}

export const OPENAI_FAST_ENV = "PI_AGENT_OPENAI_FAST";

/**
 * Parse the child-only OpenAI fast override variable. Only accepts `on`/`off`.
 * Empty/unknown values are ignored and treated as “not set”.
 */
export function parseOpenAIFastEnvValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "on") return true;
	if (normalized === "off") return false;
	return undefined;
}

/** Extract the provider portion of `provider/model` IDs. */
export const modelProvider = (model: string): string | undefined => {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
};

export const modelBaseName = (model: string): string => {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(slash + 1) : model;
};

export const supportsFastModel = (model: string): boolean => {
	const provider = modelProvider(model);
	return provider === "openai" || provider === "openai-codex";
};

export function formatAgentModelLabel(model: string, fast?: boolean): string {
	const label = modelBaseName(model);
	return supportsFastModel(model) && fast ? `${label} (fast)` : label;
}

export const AGENT_VIEW_COMMAND = "view";
export const isAgentViewCommand = (command: string): boolean => command === AGENT_VIEW_COMMAND;
export type TokenCounts = { input: number; output: number };
export type AgentCompletionStatus = "done" | "error";

/** Keep a completed child visible until Pi starts its native follow-up delivery turn. */
export function resultDeliveryStatus(
	outcome: AgentCompletionStatus,
	queuedForDelivery: boolean,
): AgentCompletionStatus | "waiting" {
	return queuedForDelivery ? "waiting" : outcome;
}

type WaitingAgent = { status: string; pendingOutcome?: AgentCompletionStatus };

/** Restore exactly one native follow-up delivery, preserving its saved outcome. */
export function restoreNextWaitingAgent<T extends WaitingAgent>(agents: readonly T[]): T | undefined {
	const agent = agents.find(candidate => candidate.status === "waiting");
	if (!agent) return undefined;
	agent.status = agent.pendingOutcome ?? "done";
	agent.pendingOutcome = undefined;
	return agent;
}

/** A settled host has no queued follow-ups, so no card may remain returning. */
export function restoreWaitingAgents<T extends WaitingAgent>(agents: readonly T[]): void {
	while (restoreNextWaitingAgent(agents)) {}
}

export function tokenCountsFromUsage(usage: unknown): TokenCounts | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const values = usage as Record<string, unknown>;
	const input = values.input; const output = values.output;
	if (typeof input !== "number" || !Number.isFinite(input) || typeof output !== "number" || !Number.isFinite(output)) return undefined;
	return { input: Math.max(0, input), output: Math.max(0, output) };
}

export function addTokenCounts(total: TokenCounts, next: TokenCounts | undefined): TokenCounts {
	return next ? { input: total.input + next.input, output: total.output + next.output } : total;
}

/** 1234 -> "1k", 999 -> "999". Shared by the context and token readouts. */
export const formatCompactCount = (value: number) =>
	value >= 1000 ? `${Math.round(value / 1000)}k` : `${Math.round(value)}`;

export function formatAgentTokens(tokens: TokenCounts): string {
	return `↑${formatCompactCount(tokens.input)} ↓${formatCompactCount(tokens.output)}`;
}

export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const values = usage as Record<string, unknown>;
	if (typeof values.totalTokens === "number" && Number.isFinite(values.totalTokens)) {
		return Math.max(0, values.totalTokens);
	}
	const parts = ["input", "output", "cacheRead", "cacheWrite"]
		.map(key => values[key])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return parts.length > 0 ? parts.reduce((sum, value) => sum + Math.max(0, value), 0) : undefined;
}

export function latestAssistantContextTokens(sessionFile: string): number | undefined {
	if (!existsSync(sessionFile)) return undefined;
	let latest: number | undefined;
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const tokens = contextTokensFromUsage(entry.message.usage);
			if (tokens !== undefined) latest = tokens;
		} catch {}
	}
	return latest;
}

export function sessionTokenCounts(sessionFile: string): TokenCounts {
	if (!existsSync(sessionFile)) return { input: 0, output: 0 };
	let total: TokenCounts = { input: 0, output: 0 };
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		try {
			const entry = JSON.parse(line);
			const usage = entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
				? entry.message.usage
				: entry?.type === "compaction" || entry?.type === "branch_summary" ? entry.usage : undefined;
			total = addTokenCounts(total, tokenCountsFromUsage(usage));
		} catch {}
	}
	return total;
}

// Same normalisation as everywhere else; see lib/agent-activity.ts for the single definition.
const cleanActivityText = cleanActivity;
const shortActivityText = (value: unknown, max = 180) => {
	const text = cleanActivityText(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
export function formatToolActivity(name: unknown, args: unknown): string {
	const values = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const details = ["path", "file", "pattern", "command", "description", "query", "url", "agent", "task"]
		.flatMap(key => values[key] === undefined ? [] : [`${key}: ${shortActivityText(values[key], 96)}`]);
	return `${cleanActivityText(name) || "tool"}${details.length ? ` — ${details.slice(0, 2).join(" · ")}` : ""}`;
}

/** Compact, safe timeline recovered from a child Pi JSONL session. */
export function latestChildActivity(sessionFile: string, maxEntries = 24): string {
	if (!existsSync(sessionFile)) return "";
	const entries: string[] = []; const calls = new Map<string, { summary: string; timestamp?: number }>();
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		try {
			const entry = JSON.parse(line); const message = entry?.message; if (!message) continue;
			const timestamp = Date.parse(entry.timestamp ?? message.timestamp ?? "") || undefined;
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ") : "";
				if (text) entries.push(`user: ${shortActivityText(text)}`);
			} else if (message.role === "assistant") {
				if (typeof message.content === "string" && message.content) entries.push(`assistant: ${shortActivityText(message.content)}`);
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part?.type === "text" && part.text) entries.push(`assistant: ${shortActivityText(part.text)}`);
					if (part?.type === "toolCall") { const summary = formatToolActivity(part.name, part.arguments); calls.set(part.id, { summary, timestamp }); entries.push(`tool-start: ${summary}`); }
				}
			} else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId); const elapsed = call?.timestamp && timestamp ? ` · ${Math.max(0, Math.round((timestamp - call.timestamp) / 1000))}s` : "";
				const error = message.isError ? ` — ${shortActivityText(Array.isArray(message.content) ? message.content.find((part: any) => part?.type === "text")?.text : message.content, 96)}` : "";
				entries.push(`${message.isError ? "tool-error" : "tool-done"}: ${(call?.summary ?? cleanActivityText(message.toolName)) || "tool"}${elapsed}${error}`);
			}
		} catch {}
	}
	return entries.slice(-maxEntries).join("\n").slice(-5000);
}

/** Everything makeState needs from a child transcript, recovered in one pass. */
export interface ChildSessionSnapshot {
	activity: string;
	contextTokens: number | undefined;
	tokens: TokenCounts;
}

/**
 * Read a child session once instead of three times.
 *
 * latestChildActivity, latestAssistantContextTokens and sessionTokenCounts each did their own
 * readFileSync + JSON.parse of the same file, and makeState called all three per instance — so a
 * restored team re-parsed every transcript three times at session_start. Those functions remain
 * for callers that want a single value; this is the combined path.
 */
export function readChildSession(sessionFile: string, maxEntries = 24): ChildSessionSnapshot {
	const empty: ChildSessionSnapshot = { activity: "", contextTokens: undefined, tokens: { input: 0, output: 0 } };
	if (!existsSync(sessionFile)) return empty;
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf-8");
	} catch {
		return empty;
	}

	const activity: string[] = [];
	const calls = new Map<string, { summary: string; timestamp?: number }>();
	let contextTokens: number | undefined;
	let tokens: TokenCounts = { input: 0, output: 0 };

	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);

			// -- token totals (was sessionTokenCounts) --
			const usage = entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
				? entry.message.usage
				: entry?.type === "compaction" || entry?.type === "branch_summary" ? entry.usage : undefined;
			tokens = addTokenCounts(tokens, tokenCountsFromUsage(usage));

			const message = entry?.message;
			if (!message) continue;

			// -- last assistant context size (was latestAssistantContextTokens) --
			if (entry.type === "message" && message.role === "assistant") {
				const latest = contextTokensFromUsage(message.usage);
				if (latest !== undefined) contextTokens = latest;
			}

			// -- timeline (was latestChildActivity) --
			const timestamp = Date.parse(entry.timestamp ?? message.timestamp ?? "") || undefined;
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ") : "";
				if (text) activity.push(`user: ${shortActivityText(text)}`);
			} else if (message.role === "assistant") {
				if (typeof message.content === "string" && message.content) activity.push(`assistant: ${shortActivityText(message.content)}`);
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part?.type === "text" && part.text) activity.push(`assistant: ${shortActivityText(part.text)}`);
					if (part?.type === "toolCall") { const summary = formatToolActivity(part.name, part.arguments); calls.set(part.id, { summary, timestamp }); activity.push(`tool-start: ${summary}`); }
				}
			} else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId); const elapsed = call?.timestamp && timestamp ? ` · ${Math.max(0, Math.round((timestamp - call.timestamp) / 1000))}s` : "";
				const error = message.isError ? ` — ${shortActivityText(Array.isArray(message.content) ? message.content.find((part: any) => part?.type === "text")?.text : message.content, 96)}` : "";
				activity.push(`${message.isError ? "tool-error" : "tool-done"}: ${(call?.summary ?? cleanActivityText(message.toolName)) || "tool"}${elapsed}${error}`);
			}
		} catch {}
	}
	return { activity: activity.slice(-maxEntries).join("\n").slice(-5000), contextTokens, tokens };
}

function safePathComponent(value: string, label: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

/**
 * Encode a working directory the way pi names its own session folders,
 * e.g. /Users/me/linuxConfig -> --Users-me-linuxConfig--
 */
export function encodeCwd(cwd: string): string {
	const segments = resolve(cwd)
		.split("/")
		.filter(Boolean)
		.map(segment => segment.replace(/[^a-zA-Z0-9]+/g, "-"));
	return `--${segments.join("-")}--`;
}

/**
 * Keep only the `keep` most recently modified parent-session folders under `root`.
 * Child sessions are disposable transcripts, so old ones are dropped rather than
 * left to grow without bound.
 */
export function pruneSessionDirs(root: string, keep: number): void {
	if (!existsSync(root)) return;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	const dirs: { path: string; mtime: number }[] = [];
	for (const entry of entries) {
		const path = join(root, entry);
		try {
			const stats = statSync(path);
			if (stats.isDirectory()) dirs.push({ path, mtime: stats.mtimeMs });
		} catch {}
	}
	if (dirs.length <= keep) return;
	dirs.sort((a, b) => b.mtime - a.mtime);
	for (const dir of dirs.slice(keep)) {
		try {
			rmSync(dir.path, { recursive: true, force: true });
		} catch {}
	}
}

export function childSessionPath(root: string, parentSessionId: string, agentName: string): string {
	const parent = safePathComponent(parentSessionId, "parent session ID");
	const agent = safePathComponent(agentName.toLowerCase().replace(/\s+/g, "-"), "agent name");
	const base = resolve(root);
	const path = resolve(base, parent, `${agent}.json`);
	if (relative(base, path).startsWith("..")) throw new Error("Child session path escapes root");
	return path;
}

export function formatAgentContext(tokens: number, contextWindow: number): string {
	return `${formatCompactCount(tokens)}/${contextWindow > 0 ? formatCompactCount(contextWindow) : "?"}`;
}

type PendingRpc = {
	command: string;
	resolve: () => void;
	reject: (error: Error) => void;
};

export class AgentRpcTransport {
	private nextId = 0;
	private readonly pending = new Map<string, PendingRpc>();
	private readonly write: (line: string, callback: (error?: Error | null) => void) => void;

	constructor(write: (line: string, callback: (error?: Error | null) => void) => void) {
		this.write = write;
	}

	request(command: Record<string, unknown>): Promise<void> {
		const id = `agent-team-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { command: String(command.type), resolve, reject });
			try {
				this.write(`${JSON.stringify({ id, ...command })}\n`, error => {
					if (error) this.reject(id, error);
				});
			} catch (error) {
				this.reject(id, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	handle(message: any): boolean {
		if (message?.type !== "response" || typeof message.id !== "string") return false;
		const pending = this.pending.get(message.id);
		if (!pending) return false;
		this.pending.delete(message.id);
		if (message.command !== pending.command) {
			pending.reject(new Error(`Unexpected RPC response for ${message.command ?? "unknown command"}`));
		} else if (message.success) {
			pending.resolve();
		} else {
			pending.reject(new Error(message.error || `${pending.command} rejected`));
		}
		return true;
	}

	fail(error: Error): void {
		for (const id of [...this.pending.keys()]) this.reject(id, error);
	}

	private reject(id: string, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.reject(error);
	}
}

export function shouldFinalizeAgentEvent(type: string): boolean {
	return type === "agent_settled";
}

export function terminateChild(
	child: {
		exitCode: number | null;
		kill(signal: "SIGTERM" | "SIGKILL"): unknown;
		once(event: "close", callback: () => void): unknown;
	},
	timeoutMs = 1000,
): void {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	const timer = setTimeout(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	}, timeoutMs);
	timer.unref();
	child.once("close", () => clearTimeout(timer));
}
