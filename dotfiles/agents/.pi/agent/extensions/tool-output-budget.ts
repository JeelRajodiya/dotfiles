/**
 * Keeps tool output from eating the context window, in two places.
 *
 * `tool_result` reshapes one oversized result as it lands: pi's tools keep one end, so the other is
 * already on disk or still on the filesystem and can be recovered and re-cut down the middle.
 * `context` drops results the agent finished with turns ago. transformContext only rewrites the
 * outgoing request — the session on disk keeps every byte, so the transcript is unaffected.
 */
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearedPlaceholder, estimateResultTokens, planClears, type ToolOutputResult } from "./lib/tool-output-budget.ts";
import { middleOutFile, withTruncationNotice } from "./lib/tool-output-shape.ts";

interface TruncatedDetails {
	truncation?: { truncated?: boolean };
	fullOutputPath?: string;
}

export default function toolOutputBudget(pi: ExtensionAPI) {
	// Keyed by tool call rather than position: compaction renumbers history, and a result that has
	// been cleared must stay cleared or the cached prefix would flip back and forth.
	let cleared = new Set<string>();
	pi.on("session_start", () => {
		cleared = new Set();
	});

	pi.on("tool_result", async (event, ctx) => {
		const details = event.details as TruncatedDetails | undefined;
		if (!details?.truncation?.truncated) return;
		const input = event.input as { path?: string; offset?: number; limit?: number };
		// bash persists what it dropped; read can be re-read from source — but only when the model
		// asked for the whole file. An explicit offset/limit is a request for that slice, not a cap.
		const source = details.fullOutputPath
			?? (typeof input.path === "string" && input.offset === undefined && input.limit === undefined
				? resolve(ctx.cwd, input.path)
				: undefined);
		if (!source) return;
		const shaped = await middleOutFile(source);
		if (!shaped?.truncated) return;
		return { content: [{ type: "text" as const, text: withTruncationNotice(shaped, details.fullOutputPath) }] };
	});

	pi.on("context", event => {
		const results = event.messages.filter(message => message.role === "toolResult") as unknown as ToolOutputResult[];
		if (!results.length) return;
		for (const id of planClears(results, cleared)) cleared.add(id);
		if (!cleared.size) return;
		let changed = false;
		const messages = event.messages.map(message => {
			const result = message as unknown as ToolOutputResult;
			if (message.role !== "toolResult" || !cleared.has(result.toolCallId)) return message;
			changed = true;
			// event.messages always carries the original content, so the note is recomputed from the
			// same input every turn and the replacement stays byte-identical.
			return { ...message, content: [{ type: "text", text: clearedPlaceholder(result.toolName, estimateResultTokens(result.content)) }] };
		});
		return changed ? { messages: messages as typeof event.messages } : undefined;
	});
}
