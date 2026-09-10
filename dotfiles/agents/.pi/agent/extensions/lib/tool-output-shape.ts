/**
 * Reshaping an oversized tool result the way Codex does.
 *
 * Pi's built-in tools keep one end and drop the other — the head for `read`, the tail for `bash`.
 * Either way the model loses a half it often needs: the command that produced a log, or the error
 * that ended it. Keeping both ends and dropping the middle costs the same tokens and loses less.
 */
import { open } from "node:fs/promises";
import { APPROX_CHARS_PER_TOKEN } from "./tool-output-budget.ts";

/** Codex's default output budget for one tool call. */
export const TOOL_OUTPUT_TOKEN_BUDGET = 10_000;

export interface ShapedOutput {
	text: string;
	originalTokens: number;
	truncated: boolean;
}

export const tokensOf = (text: string) => Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);

/** Split on a line boundary where one is close, so neither half starts or ends mid-line. */
function cutAt(text: string, index: number, searchForward: boolean): number {
	const window = 400;
	if (searchForward) {
		const next = text.indexOf("\n", index);
		return next !== -1 && next - index <= window ? next + 1 : index;
	}
	const previous = text.lastIndexOf("\n", index);
	return previous !== -1 && index - previous <= window ? previous + 1 : index;
}

export function middleOut(text: string, budgetTokens = TOOL_OUTPUT_TOKEN_BUDGET): ShapedOutput {
	const originalTokens = tokensOf(text);
	if (originalTokens <= budgetTokens) return { text, originalTokens, truncated: false };
	const budgetChars = budgetTokens * APPROX_CHARS_PER_TOKEN;
	const half = Math.floor(budgetChars / 2);
	const head = text.slice(0, cutAt(text, half, false));
	const tail = text.slice(cutAt(text, text.length - half, true));
	const droppedTokens = originalTokens - tokensOf(head) - tokensOf(tail);
	return {
		text: `${head}\n…${droppedTokens} tokens truncated…\n${tail}`,
		originalTokens,
		truncated: true,
	};
}

/**
 * The same shape for a body too big to hold in memory: read only the two ends off disk. Sizing the
 * budget in bytes rather than tokens is what makes that possible — the whole point of reshaping is
 * to avoid loading a 5MB log to throw away 99% of it.
 */
export async function middleOutFile(path: string, budgetTokens = TOOL_OUTPUT_TOKEN_BUDGET): Promise<ShapedOutput | undefined> {
	let handle;
	try {
		handle = await open(path, "r");
	} catch {
		return undefined;
	}
	try {
		const { size } = await handle.stat();
		const budgetChars = budgetTokens * APPROX_CHARS_PER_TOKEN;
		if (size <= budgetChars) {
			const buffer = Buffer.alloc(size);
			await handle.read(buffer, 0, size, 0);
			const text = buffer.toString("utf-8");
			return { text, originalTokens: tokensOf(text), truncated: false };
		}
		const half = Math.floor(budgetChars / 2);
		const headBuffer = Buffer.alloc(half);
		const tailBuffer = Buffer.alloc(half);
		await handle.read(headBuffer, 0, half, 0);
		await handle.read(tailBuffer, 0, half, size - half);
		const rawHead = headBuffer.toString("utf-8");
		const rawTail = tailBuffer.toString("utf-8");
		const head = rawHead.slice(0, cutAt(rawHead, rawHead.length, false));
		const tail = rawTail.slice(cutAt(rawTail, 0, true));
		const originalTokens = Math.ceil(size / APPROX_CHARS_PER_TOKEN);
		const droppedTokens = originalTokens - tokensOf(head) - tokensOf(tail);
		return { text: `${head}\n…${droppedTokens} tokens truncated…\n${tail}`, originalTokens, truncated: true };
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

/** The trailing note Codex gives the model so it narrows the command instead of repeating it. */
export function withTruncationNotice(shaped: ShapedOutput, fullOutputPath?: string): string {
	if (!shaped.truncated) return shaped.text;
	const source = fullOutputPath ? ` Full output: ${fullOutputPath}` : "";
	return `${shaped.text}\n\nWarning: truncated output (original token count: ${shaped.originalTokens}).${source}`;
}
