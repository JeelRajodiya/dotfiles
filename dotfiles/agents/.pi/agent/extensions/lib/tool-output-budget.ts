/**
 * Deciding which tool results to drop from the outgoing context.
 *
 * Tool output is the bulk of a long agent session and most of it is dead weight a few turns later.
 * Clearing it only pays if the decision is stable: cleared results sit inside the cached prefix, so
 * a cut point that moved every turn would re-bill the whole conversation. Hence the hysteresis —
 * clear one batch when the live total crosses the ceiling, down to the floor, then hold.
 */

const APPROX_CHARS_PER_TOKEN = 4;
/** An image costs roughly this much however long its base64 happens to be. */
const APPROX_IMAGE_TOKENS = 1_500;

export const CLEAR_ABOVE_TOKENS = 120_000;
export const KEEP_TOKENS = 60_000;
/** Under this a placeholder saves nothing and only churns the prefix. */
export const MIN_CLEARABLE_TOKENS = 200;

export interface ToolOutputBlock {
	type: string;
	text?: string;
}

export interface ToolOutputResult {
	toolCallId: string;
	toolName: string;
	content: ToolOutputBlock[];
}

export function estimateResultTokens(content: ToolOutputBlock[]): number {
	let tokens = 0;
	for (const block of content) {
		tokens += block.type === "text" ? Math.ceil((block.text ?? "").length / APPROX_CHARS_PER_TOKEN) : APPROX_IMAGE_TOKENS;
	}
	return tokens;
}

export function clearedPlaceholder(toolName: string, tokens: number): string {
	return `[${toolName} output cleared to save context (~${tokens} tokens). Run it again if you still need the detail.]`;
}

/**
 * Oldest first, never revisiting what is already cleared. An empty result means the context is
 * still under the ceiling and nothing should move.
 */
export function planClears(
	results: ToolOutputResult[],
	cleared: ReadonlySet<string>,
	options: { above?: number; keep?: number } = {},
): string[] {
	const above = options.above ?? CLEAR_ABOVE_TOKENS;
	const keep = options.keep ?? KEEP_TOKENS;
	const sizes = new Map<string, number>();
	let live = 0;
	for (const result of results) {
		const tokens = estimateResultTokens(result.content);
		sizes.set(result.toolCallId, tokens);
		if (!cleared.has(result.toolCallId)) live += tokens;
	}
	if (live <= above) return [];
	const plan: string[] = [];
	for (const result of results) {
		if (live <= keep) break;
		if (cleared.has(result.toolCallId)) continue;
		const tokens = sizes.get(result.toolCallId) ?? 0;
		// Skipping the small ones costs a little headroom and saves rewriting results whose whole
		// body is shorter than the note that would replace them.
		if (tokens < MIN_CLEARABLE_TOKENS) continue;
		plan.push(result.toolCallId);
		live -= tokens;
	}
	return plan;
}
