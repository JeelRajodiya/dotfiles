/**
 * A child agent's recent-activity log.
 *
 * This used to be a single string that every event appended to and then re-sliced to the
 * last 5000 characters. Two things went wrong with that: streaming replies arrive one token
 * at a time, so each token rebuilt a 5000-character string, and each token also became its
 * own `assistant: ` line — which meant a long reply pushed all the tool history out of the
 * window. Entries are structured and capped by count instead, and consecutive assistant
 * deltas extend the entry already there.
 */

export type ActivityKind = "user" | "assistant" | "thought" | "tool-start" | "tool-done" | "tool-error";
export interface ActivityEntry { kind: ActivityKind; text: string; startedAt?: number; finishedAt?: number }

const KINDS = new Set<string>(["user", "assistant", "thought", "tool-start", "tool-done", "tool-error"]);
const LINE = /^(user|assistant|thought|tool-start|tool-done|tool-error):\s*([\s\S]*)$/i;

/** Strip ANSI and control characters, collapse whitespace. Terminal output is not trusted here. */
export const cleanActivity = (value: unknown): string =>
	String(value ?? "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1F\x7F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Strip common Markdown wrappers from reasoning without changing its words. */
export const cleanThoughtActivity = (value: unknown): string =>
	cleanActivity(
		String(value ?? "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
			.replace(/(?:\*\*|__|~~|`)/g, "")
			.replace(/(^|[\s(])([*_])([^*_]+)\2(?=$|[\s).,!?])/g, "$1$3"),
	);

/**
 * Longest overlap the seam search will look for. The scan is O(limit²) in the worst case and
 * runs on every reasoning delta, so it is capped: a full resend is already handled by the
 * containment checks above it, and streamed deltas never overlap by more than a few words.
 */
const MAX_THOUGHT_OVERLAP = 200;

/** Join streamed or resent reasoning without repeating a shared prefix/suffix. */
export function mergeThoughtActivity(previous: string, next: string): string {
	if (!previous || !next) return previous || next;
	if (previous.includes(next)) return previous;
	if (next.includes(previous)) return next;
	const limit = Math.min(previous.length, next.length, MAX_THOUGHT_OVERLAP);
	for (let length = limit; length > 0; length--) {
		if (previous.endsWith(next.slice(0, length))) return `${previous}${next.slice(length)}`;
	}
	return `${previous} ${next}`;
}

export function formatActivityDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function thoughtActivityLabel(entry: ActivityEntry, now = Date.now()): string {
	const duration = Math.max(0, (entry.finishedAt ?? now) - (entry.startedAt ?? now));
	return `${entry.finishedAt ? "Thought" : "Thinking"} (${formatActivityDuration(duration)})${entry.text ? ` — ${entry.text}` : ""}`;
}

export class ActivityLog {
	private entries: ActivityEntry[] = [];
	private readonly maxEntries: number;
	private readonly maxTextLength: number;

	// Plain fields, not constructor parameter properties: Node's strip-only TypeScript mode
	// rejects those, and that made this module impossible to exercise without a build step.
	constructor(maxEntries = 24, maxTextLength = 400) {
		this.maxEntries = maxEntries;
		this.maxTextLength = maxTextLength;
	}

	/** Keep the tail: while a reply streams, the newest words are the interesting ones. */
	private clamp(text: string): string {
		return text.length > this.maxTextLength ? text.slice(text.length - this.maxTextLength) : text;
	}

	append(kind: ActivityKind, value: unknown): void {
		if (kind === "thought") {
			this.appendThought(value);
			return;
		}
		const text = cleanActivity(value);
		if (!text || /^[{[]/.test(text)) return;
		const last = this.entries.at(-1);
		// Thoughts returned above, so only assistant deltas coalesce here.
		if (kind === "assistant" && last?.kind === kind && !last.finishedAt) {
			last.text = this.clamp(`${last.text} ${text}`.replace(/\s+/g, " "));
			return;
		}
		this.entries.push({ kind, text: this.clamp(text) });
		if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
	}

	startThought(now = Date.now()): void {
		const last = this.entries.at(-1);
		if (last?.kind === "thought" && !last.finishedAt) return;
		this.entries.push({ kind: "thought", text: "", startedAt: now });
		if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
	}

	appendThought(value: unknown): void {
		const text = cleanThoughtActivity(value);
		if (!text) return;
		const last = this.entries.at(-1);
		if (last?.kind !== "thought" || last.finishedAt) this.startThought();
		const thought = this.entries.at(-1)!;
		thought.text = this.clamp(mergeThoughtActivity(thought.text, text));
	}

	/**
	 * Open thoughts, oldest first. A tool call between thinking_start and thinking_end pushes an
	 * entry in between, so the thought being closed is not reliably the tail.
	 */
	private openThoughts(): ActivityEntry[] {
		return this.entries.filter(entry => entry.kind === "thought" && !entry.finishedAt);
	}

	finishThought(value: unknown, now = Date.now()): void {
		this.appendThought(value);
		// Target the open thought rather than the last entry: looking only at the tail both missed
		// the real thought when something interleaved, and re-stamped an already-closed one when
		// thinking_end carried no text.
		const thought = this.openThoughts().at(-1);
		if (thought) thought.finishedAt = now;
	}

	/**
	 * Close anything still marked as thinking. A run that ends without a thinking_end — an error,
	 * an abort, a child that dies — would otherwise render "Thinking (4m12s)" on a finished agent,
	 * with the duration climbing forever.
	 */
	closeOpenThoughts(now = Date.now()): void {
		for (const thought of this.openThoughts()) thought.finishedAt = now;
	}

	/** Rebuild from the `kind: text` lines that latestChildActivity() recovers from a session file. */
	static parse(serialized: string, maxEntries?: number, maxTextLength?: number): ActivityLog {
		const log = new ActivityLog(maxEntries, maxTextLength);
		for (const line of serialized.split("\n")) {
			const match = line.match(LINE);
			if (match && KINDS.has(match[1].toLowerCase())) log.append(match[1].toLowerCase() as ActivityKind, match[2]);
		}
		return log;
	}

	/** Entries newest-last. `fallback` stands in for an agent that has produced only a final message. */
	list(fallback = ""): ActivityEntry[] {
		if (this.entries.length) return this.entries.map(entry => ({ ...entry }));
		const text = cleanActivity(fallback);
		return text ? [{ kind: "assistant", text: this.clamp(text) }] : [];
	}

	get size(): number {
		return this.entries.length;
	}
}

/**
 * The child's reply, retained only as far as the result message actually uses. Keeping every
 * chunk of a long reply in an array just to slice the first 8000 characters off it at the end
 * holds memory nothing reads.
 */
export class OutputBuffer {
	private text = "";
	private truncated = false;
	private readonly limit: number;

	constructor(limit = 8000) {
		this.limit = limit;
	}

	append(chunk: string): void {
		if (!chunk || this.text.length >= this.limit) {
			if (chunk) this.truncated = true;
			return;
		}
		this.text += chunk;
		if (this.text.length > this.limit) {
			this.text = this.text.slice(0, this.limit);
			this.truncated = true;
		}
	}

	get isEmpty(): boolean {
		return this.text.length === 0;
	}

	get wasTruncated(): boolean {
		return this.truncated;
	}

	toString(): string {
		return this.text;
	}
}

/**
 * Running tail of a child's stdout text, used for the one-line "last work" preview.
 * Bounded so appending stays constant-time however long the reply runs.
 */
export class TextTail {
	private tail = "";
	private readonly window: number;

	constructor(window = 500) {
		this.window = window;
	}

	append(delta: string): void {
		if (!delta) return;
		this.tail = (this.tail + delta).slice(-this.window);
	}

	/** The last complete-looking line seen, or "" before any output. */
	get lastLine(): string {
		const lines = this.tail.split("\n").filter(line => line.trim());
		return lines.at(-1)?.trim() ?? "";
	}
}
