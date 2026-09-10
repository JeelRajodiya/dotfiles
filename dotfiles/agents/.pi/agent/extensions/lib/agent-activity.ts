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
/**
 * `at` is when this entry last moved, and only live events carry it: entries rebuilt by parse()
 * come from a transcript this process did not watch, so stamping them with the clock would
 * invent an age. Peeking reports "unknown" for those rather than a plausible lie.
 */
export interface ActivityEntry { kind: ActivityKind; text: string; toolCallId?: string; startedAt?: number; finishedAt?: number; at?: number }

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

/** A row still in flight. The live counter in front of it is the only thing that says so. */
export const isActivityRunning = (entry: ActivityEntry): boolean =>
	entry.kind === "tool-start" || (entry.kind === "thought" && entry.finishedAt === undefined);

/** Where its clock started: tools only carry `at`, thoughts carry an explicit start. */
export const activityStartedAt = (entry: ActivityEntry): number | undefined => entry.startedAt ?? entry.at;

export function thoughtActivityLabel(entry: ActivityEntry, now = Date.now()): string {
	// A running thought is rendered behind a live counter, so repeating the elapsed time here
	// would read "12s Thinking (12s) — …".
	if (entry.finishedAt === undefined) return `Thinking${entry.text ? ` — ${entry.text}` : ""}`;
	const duration = Math.max(0, entry.finishedAt - (entry.startedAt ?? entry.finishedAt));
	return `Thought (${formatActivityDuration(duration)})${entry.text ? ` — ${entry.text}` : ""}`;
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
			last.at = Date.now();
			return;
		}
		this.push({ kind, text: this.clamp(text), at: Date.now() });
	}

	/** Keep one row per identified tool call; missing IDs deliberately remain separate. */
	startTool(toolCallId: string, value: unknown): void {
		const text = cleanActivity(value);
		if (!text) return;
		this.push({ kind: "tool-start", text: this.clamp(text), toolCallId, at: Date.now() });
	}

	finishTool(toolCallId: string | undefined, kind: "tool-done" | "tool-error", value: unknown): void {
		const text = cleanActivity(value);
		if (!text) return;
		const pending = toolCallId
			? this.entries.findLast(entry => entry.kind === "tool-start" && entry.toolCallId === toolCallId)
			: undefined;
		if (pending) {
			pending.kind = kind;
			pending.text = this.clamp(text);
			pending.at = Date.now();
			return;
		}
		this.append(kind, text);
	}

	startThought(now = Date.now()): void {
		const last = this.entries.at(-1);
		if (last?.kind === "thought" && !last.finishedAt) return;
		this.push({ kind: "thought", text: "", startedAt: now, at: now });
	}

	appendThought(value: unknown): void {
		const text = cleanThoughtActivity(value);
		if (!text) return;
		const last = this.entries.at(-1);
		if (last?.kind !== "thought" || last.finishedAt) this.startThought();
		const thought = this.entries.at(-1)!;
		thought.text = this.clamp(mergeThoughtActivity(thought.text, text));
		thought.at = Date.now();
	}

	private push(entry: ActivityEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
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

	/** Rebuild from the `kind: text` lines that readChildSession() recovers from a session file. */
	static parse(serialized: string, maxEntries?: number, maxTextLength?: number): ActivityLog {
		const log = new ActivityLog(maxEntries, maxTextLength);
		for (const line of serialized.split("\n")) {
			const match = line.match(LINE);
			if (!match || !KINDS.has(match[1].toLowerCase())) continue;
			const kind = match[1].toLowerCase() as ActivityKind;
			const [toolCallId, text] = match[2].split("\t", 2);
			if (kind === "tool-start" && text && toolCallId) log.startTool(toolCallId, text);
			else if ((kind === "tool-done" || kind === "tool-error") && text && toolCallId) log.finishTool(toolCallId, kind, text);
			else log.append(kind, match[2]);
		}
		// The transcript carries no wall clock, and these entries are replayed all at once: drop the
		// stamps the mutators just wrote rather than dating a whole prior run to this instant.
		for (const entry of log.entries) entry.at = undefined;
		return log;
	}

	/**
	 * Entries newest-last, at most `limit` of them. `fallback` stands in for an agent that has
	 * produced only a final message.
	 */
	list(fallback = "", limit?: number): ActivityEntry[] {
		let entries = this.entries;
		if (!entries.length) {
			const text = cleanActivity(fallback);
			if (!text) return [];
			entries = [{ kind: "assistant", text: this.clamp(text) }];
		}
		const start = limit === undefined ? 0 : Math.max(0, entries.length - Math.max(0, limit));
		return entries.slice(start).map(entry => ({ ...entry }));
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
