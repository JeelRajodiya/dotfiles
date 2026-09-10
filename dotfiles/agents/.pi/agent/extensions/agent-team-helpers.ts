import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { cleanActivity, formatActivityDuration, thoughtActivityLabel, type ActivityEntry } from "./lib/agent-activity.ts";

/**
 * Support code for agent-team.ts, not an extension of its own.
 *
 * Pi auto-loads every `extensions/*.ts`, so this file is loaded as an extension whether
 * or not it wants to be; the empty default export is what makes that load a no-op.
 * (Moving it under `extensions/lib/` would avoid that, but stow links these files
 * individually and a move would leave a dangling symlink until the next sync.)
 */
export default function (_pi: ExtensionAPI): void {}

export const resolveAgentThinking = (configured: ThinkingLevel | undefined, host: ThinkingLevel | undefined): ThinkingLevel => configured ?? host ?? "off";

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

export function canCompactAgent(status: string, isRoot: boolean, hasSession: boolean): boolean {
	return hasSession && canClearAgent(status, isRoot);
}

export function canSteerAgent(status: string, maintenance: boolean): boolean {
	return status === "running" && !maintenance;
}

/** Start every job before awaiting any result. */
export function runConcurrent<T>(tasks: readonly (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
	return Promise.allSettled(tasks.map(task => {
		try { return task(); } catch (error) { return Promise.reject(error); }
	}));
}

/** Only an active child has a process that can be interrupted. */
export function canInterruptAgent(status: string, isRoot: boolean): boolean {
	return !isRoot && status === "running";
}

/** Allocate the first positive instance suffix without changing existing identities. */
/** a, b, … z, aa, ab — spreadsheet columns, so the sequence never runs out. */
export function instanceSuffix(index: number): string {
	let suffix = "";
	for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) suffix = String.fromCharCode(97 + (n % 26)) + suffix;
	return suffix;
}

/**
 * Letters, not numbers. "Tracer A" and "Tracer B" stay distinct when skimmed, where
 * "tracer-1" and "tracer-2" differ by a single glyph at the far end of the word.
 */
export function nextAgentName(base: string, existingNames: Iterable<string>): string {
	const normalizedBase = base.trim().toLowerCase().replace(/\s+/g, "-");
	const existing = new Set(Array.from(existingNames, name => name.toLowerCase()));
	for (let index = 0; ; index++) {
		const candidate = `${normalizedBase}-${instanceSuffix(index)}`;
		if (!existing.has(candidate)) return candidate;
	}
}

export type AgentOrigin = "default" | "user" | "host";
export type TaskHistoryEntry = { task: string; outcome: AgentCompletionStatus };
type RoutingAgent = { name: string; base: string; origin: AgentOrigin; status: string; history: readonly TaskHistoryEntry[] };

const redactTask = (task: string) => cleanActivity(task)
	.replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=])\s*\S+/gi, "$1 [redacted]")
	.slice(0, 160);

/** Keep compact completed-task context in memory only. */
export function appendTaskHistory(history: readonly TaskHistoryEntry[], task: string, outcome: AgentCompletionStatus, limit = 6): TaskHistoryEntry[] {
	if (!task.trim()) return [...history];
	return [...history, { task: redactTask(task), outcome }].slice(-limit);
}

export function isAvailableForRouting(agent: RoutingAgent, base: string, preferredInstance?: string): boolean {
	return agent.base.toLowerCase() === base.toLowerCase()
		&& agent.status !== "running" && agent.status !== "waiting"
		&& (!preferredInstance || agent.name.toLowerCase() === preferredInstance.toLowerCase());
}

/** Prefer an explicitly selected relevant instance; never infer relevance from task text. */
export function selectRoutingAgent<T extends RoutingAgent>(agents: readonly T[], base: string, preferredInstance?: string): T | undefined {
	return agents.find(agent => isAvailableForRouting(agent, base, preferredInstance))
		?? agents.find(agent => isAvailableForRouting(agent, base));
}

export function canKillHostAgent(agent: Pick<RoutingAgent, "origin" | "status">): boolean {
	return agent.origin === "host" && agent.status !== "running" && agent.status !== "waiting";
}

export type RoutingDecision = { action: "steer"; agent: string } | { action: "reuse"; agent: string } | { action: "spawn" } | { action: "queue" } | { action: "related-unavailable" };
export function decideRouting<T extends RoutingAgent>(agents: readonly T[], base: string, relation: "related" | "new", preferredInstance: string | undefined, autoSpawn: boolean, hostCount: number, limit: number): RoutingDecision {
	if (relation === "related") {
		const related = preferredInstance && agents.find(agent => agent.name.toLowerCase() === preferredInstance.toLowerCase() && agent.base.toLowerCase() === base.toLowerCase() && agent.status === "running");
		return related ? { action: "steer", agent: related.name } : { action: "related-unavailable" };
	}
	const available = selectRoutingAgent(agents, base, preferredInstance);
	if (available) return { action: "reuse", agent: available.name };
	return autoSpawn && hostCount < limit ? { action: "spawn" } : { action: "queue" };
}

export function updateQueuedItem<T extends { id: string }>(queue: readonly T[], id: string, update: (item: T) => T): T[] | undefined {
	const index = queue.findIndex(item => item.id === id);
	if (index < 0) return undefined;
	const next = [...queue]; next[index] = update(next[index]!);
	return next;
}

export function removeQueuedItem<T extends { id: string }>(queue: readonly T[], id: string): T[] | undefined {
	return queue.some(item => item.id === id) ? queue.filter(item => item.id !== id) : undefined;
}

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

// Same normalisation as everywhere else; see lib/agent-activity.ts for the single definition.
const cleanActivityText = cleanActivity;
const shortActivityText = (value: unknown, max = 180) => {
	const text = cleanActivityText(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
export function formatToolActivity(name: unknown, args: unknown): string {
	const tool = cleanActivityText(name).toLowerCase();
	const values = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const detail = (key: string) => values[key] === undefined ? "" : shortActivityText(values[key]);
	const path = detail("path") || detail("file") || detail("file_path");
	if (tool === "bash" || tool === "powershell") return detail("command") || tool;
	if (tool === "read" || tool === "edit" || tool === "write") return `${tool[0]!.toUpperCase()}${tool.slice(1)}${path ? ` ${path}` : ""}`;
	if (tool === "grep") return `Search${detail("pattern") ? ` ${detail("pattern")}` : ""}${path ? ` in ${path}` : ""}`;
	if (tool === "find") return `Find${detail("pattern") ? ` ${detail("pattern")}` : ""}${path ? ` in ${path}` : ""}`;
	if (tool === "ls") return `List${path ? ` ${path}` : ""}`;
	const details = ["command", "path", "file", "pattern", "description", "query", "url", "agent", "task"]
		.flatMap(key => values[key] === undefined ? [] : [shortActivityText(values[key])]);
	return details.slice(0, 2).join(" · ") || tool || "tool";
}

const activityToolRecord = (toolCallId: unknown, text: string) =>
	typeof toolCallId === "string" && toolCallId ? `${toolCallId}\t${text}` : text;

/** Everything makeState needs from a child transcript, recovered in one pass. */
export interface ChildSessionSnapshot {
	activity: string;
	contextTokens: number | undefined;
	tokens: TokenCounts;
}

/**
 * The only reader of a child transcript.
 *
 * The timeline, the last assistant context size and the token totals each used to live in their
 * own exported function with its own readFileSync + JSON.parse of the same file, and makeState
 * called all three per instance — so a restored team re-parsed every transcript three times at
 * session_start. Keeping them as separate entry points also meant two copies of the same
 * message-shape handling that had to be kept in step by a test asserting they agreed.
 */
export function readChildSession(sessionFile: string, maxEntries = 24, maxChars = 5000): ChildSessionSnapshot {
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

			// -- token totals --
			const usage = entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
				? entry.message.usage
				: entry?.type === "compaction" || entry?.type === "branch_summary" ? entry.usage : undefined;
			tokens = addTokenCounts(tokens, tokenCountsFromUsage(usage));

			const message = entry?.message;
			if (!message) continue;

			// -- last assistant context size --
			if (entry.type === "message" && message.role === "assistant") {
				const latest = contextTokensFromUsage(message.usage);
				if (latest !== undefined) contextTokens = latest;
			}

			// -- timeline --
			const timestamp = Date.parse(entry.timestamp ?? message.timestamp ?? "") || undefined;
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ") : "";
				if (text) activity.push(`user: ${shortActivityText(text)}`);
			} else if (message.role === "assistant") {
				if (typeof message.content === "string" && message.content) activity.push(`assistant: ${shortActivityText(message.content)}`);
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part?.type === "text" && part.text) activity.push(`assistant: ${shortActivityText(part.text)}`);
					if (part?.type === "toolCall") { const summary = formatToolActivity(part.name, part.arguments); if (typeof part.id === "string" && part.id) calls.set(part.id, { summary, timestamp }); activity.push(`tool-start: ${activityToolRecord(part.id, summary)}`); }
				}
			} else if (message.role === "toolResult") {
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined; const call = toolCallId ? calls.get(toolCallId) : undefined; const elapsed = call?.timestamp && timestamp ? ` · ${Math.max(0, Math.round((timestamp - call.timestamp) / 1000))}s` : "";
				const error = message.isError ? ` — ${shortActivityText(Array.isArray(message.content) ? message.content.find((part: any) => part?.type === "text")?.text : message.content, 96)}` : "";
				activity.push(`${message.isError ? "tool-error" : "tool-done"}: ${activityToolRecord(toolCallId, `${call?.summary ?? formatToolActivity(message.toolName, {})}${elapsed}${error}`)}`);
			}
		} catch {}
	}
	return { activity: activity.slice(-maxEntries).join("\n").slice(-maxChars), contextTokens, tokens };
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

/* --- peeking: reading a child's activity without prompting it ------------------------------ */

/**
 * Asking a child what it is doing costs a whole turn of its attention and, mid-task, derails it.
 * Peeking reads the activity log the widget already maintains, so the host can answer "what is
 * Tracer doing" or "why is this slow" from state that is already in the parent process.
 */

/** Enough to say what an agent is doing right now. The caller raises it to read further back. */
export const PEEK_DEFAULT_ENTRIES = 8;
/** A peek that replayed a whole run would cost the host more context than the answer is worth. */
export const PEEK_MAX_CHARS = 12_000;
/** Charged per line on top of its text, for the age and kind that prefix it. */
const PEEK_LINE_OVERHEAD = 32;

const PEEK_KIND_LABEL: Record<string, string> = {
	user: "task", assistant: "reply", "tool-start": "tool·running", "tool-done": "tool·ok", "tool-error": "tool·failed",
};

export interface PeekSelection { shown: ActivityEntry[]; omitted: number; total: number }

/**
 * The newest `limit` entries, optionally narrowed to a recent window and always trimmed to a
 * character budget. Entries carrying no `at` are transcript history this process never watched
 * (see ActivityEntry), so a window request drops them rather than assuming they are recent.
 */
export function selectPeekEntries(
	entries: readonly ActivityEntry[],
	options: { limit?: number; withinMs?: number; now?: number; maxChars?: number } = {},
): PeekSelection {
	const now = options.now ?? Date.now();
	const maxChars = options.maxChars ?? PEEK_MAX_CHARS;
	const limit = Math.max(1, Math.floor(options.limit ?? PEEK_DEFAULT_ENTRIES));
	const withinMs = options.withinMs;
	const candidates = withinMs === undefined
		? entries
		: entries.filter(entry => entry.at !== undefined && now - entry.at <= withinMs);
	const shown = candidates.slice(Math.max(0, candidates.length - limit));
	let chars = shown.reduce((sum, entry) => sum + entry.text.length + PEEK_LINE_OVERHEAD, 0);
	// Never return nothing: one over-budget entry still answers "what is it doing".
	while (shown.length > 1 && chars > maxChars) chars -= shown.shift()!.text.length + PEEK_LINE_OVERHEAD;
	return { shown, omitted: entries.length - shown.length, total: entries.length };
}

const peekAge = (entry: ActivityEntry, now: number) =>
	entry.at === undefined ? "earlier" : `${formatActivityDuration(now - entry.at)} ago`;

export function formatPeekEntry(entry: ActivityEntry, now: number): string {
	const body = entry.kind === "thought"
		? thoughtActivityLabel(entry, now)
		: `${PEEK_KIND_LABEL[entry.kind] ?? entry.kind} — ${entry.text}`;
	return `- ${peekAge(entry, now)} · ${body}`;
}

export interface PeekAgentView {
	name: string; type: string; status: string; goal: string; task: string; model: string;
	elapsed: number; toolCount: number; contextTokens: number; contextWindow: number;
	lastWork: string; history: readonly TaskHistoryEntry[]; pendingOutcome?: AgentCompletionStatus;
}

/** The unfinished tool call, if one is holding the run up: finishTool rewrites the kind in place. */
export function peekInFlightTool(entries: readonly ActivityEntry[], status: string, now: number): string | undefined {
	if (status !== "running") return undefined;
	const pending = entries.findLast(entry => entry.kind === "tool-start");
	if (!pending) return undefined;
	return pending.at === undefined ? pending.text : `${pending.text} — running ${formatActivityDuration(now - pending.at)}`;
}

export function formatAgentPeek(
	view: PeekAgentView,
	entries: readonly ActivityEntry[],
	options: { limit?: number; withinMs?: number; now?: number; maxChars?: number } = {},
): { text: string; selection: PeekSelection } {
	const now = options.now ?? Date.now();
	const selection = selectPeekEntries(entries, { ...options, now });
	const status = view.status === "waiting" && view.pendingOutcome ? `waiting (${view.pendingOutcome} queued)` : view.status;
	const inFlight = peekInFlightTool(entries, view.status, now);
	const history = view.history.slice(-3).map(entry => `${entry.outcome}:${shortActivityText(entry.task, 96)}`).join(" | ");
	const window = options.withinMs === undefined ? "" : ` within the last ${formatActivityDuration(options.withinMs)}`;
	const heading = selection.total
		? `Activity — ${selection.shown.length} of ${selection.total} entries${window}, oldest first${selection.omitted ? ` (${selection.omitted} earlier not shown)` : ""}:`
		: "Activity — nothing recorded yet.";
	const lines = [
		`${view.name} (${view.type}) — ${[status, view.model, `${formatActivityDuration(view.elapsed)} on this run`, `${view.toolCount} tool calls`, `${formatAgentContext(view.contextTokens, view.contextWindow)} context`].join(" · ")}`,
		`Goal: ${shortActivityText(view.goal, 200) || "(none)"}`,
		`Current task: ${shortActivityText(view.task, 200) || "(none)"}`,
	];
	if (inFlight) lines.push(`In flight: ${inFlight}`);
	if (view.status !== "running" && view.lastWork) lines.push(`Last output: ${shortActivityText(view.lastWork, 200)}`);
	if (history) lines.push(`Recent completed tasks: ${history}`);
	lines.push("", heading, ...selection.shown.map(entry => formatPeekEntry(entry, now)));
	lines.push("", `Read from ${view.name}'s activity log — it was not prompted, steered, or interrupted.`);
	return { text: lines.join("\n"), selection };
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
