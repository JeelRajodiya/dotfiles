import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {}

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

const cleanActivityText = (value: unknown) => String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
const shortActivityText = (value: unknown, max = 180) => {
	const text = cleanActivityText(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
export function formatToolActivity(name: unknown, args: unknown): string {
	const values = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const details = ["path", "file", "pattern", "command", "description", "query", "url", "agent", "task"]
		.flatMap(key => values[key] === undefined ? [] : [`${key}: ${shortActivityText(values[key], 96)}`]);
	return `${cleanActivityText(name) || "tool"}${details.length ? ` — ${details.slice(0, 2).join(" · ")}` : ""}`;
}

export function latestChildTranscript(sessionFile: string, maxChars = 2000): string {
	if (!existsSync(sessionFile)) return "";
	const lines: string[] = [];
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		try {
			const message = JSON.parse(line)?.message;
			if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
			const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") : "";
			if (content) lines.push(`${message.role}: ${content}`);
		} catch {}
	}
	return lines.join("\n").slice(-maxChars);
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

export function hasRunningAgent(states: Iterable<{ status: string }>): boolean {
	return Array.from(states).some(state => state.status === "running");
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
	const format = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : `${Math.round(value)}`;
	return `${format(tokens)}/${contextWindow > 0 ? format(contextWindow) : "?"}`;
}

export function aggregateAgentUsageCost(entries: Iterable<unknown>): number {
	const seen = new Set<string>();
	let total = 0;
	for (const entry of entries) {
		const data = entry as { sourceEventId?: unknown; usage?: { cost?: { total?: unknown } } };
		if (typeof data.sourceEventId !== "string" || seen.has(data.sourceEventId)) continue;
		seen.add(data.sourceEventId);
		const cost = data.usage?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
	}
	return total;
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
