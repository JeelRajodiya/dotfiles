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

export type ActivityKind = "user" | "assistant" | "tool-start" | "tool-done" | "tool-error";
export interface ActivityEntry { kind: ActivityKind; text: string }

const KINDS = new Set<string>(["user", "assistant", "tool-start", "tool-done", "tool-error"]);
const LINE = /^(user|assistant|tool-start|tool-done|tool-error):\s*([\s\S]*)$/i;

/** Strip ANSI and control characters, collapse whitespace. Terminal output is not trusted here. */
export const cleanActivity = (value: unknown): string =>
	String(value ?? "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1F\x7F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export class ActivityLog {
	private entries: ActivityEntry[] = [];

	constructor(
		private readonly maxEntries = 24,
		private readonly maxTextLength = 400,
	) {}

	/** Keep the tail: while a reply streams, the newest words are the interesting ones. */
	private clamp(text: string): string {
		return text.length > this.maxTextLength ? text.slice(text.length - this.maxTextLength) : text;
	}

	append(kind: ActivityKind, value: unknown): void {
		const text = cleanActivity(value);
		if (!text || /^[{[]/.test(text)) return;
		const last = this.entries.at(-1);
		if (kind === "assistant" && last?.kind === "assistant") {
			last.text = this.clamp(`${last.text} ${text}`.replace(/\s+/g, " "));
			return;
		}
		this.entries.push({ kind, text: this.clamp(text) });
		if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
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

	constructor(private readonly limit = 8000) {}

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
	constructor(private readonly window = 500) {}

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
