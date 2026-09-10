/**
 * Drops stale tool output from the context sent to the model.
 *
 * transformContext only rewrites the outgoing request — the session on disk keeps every byte, so
 * /agents view and the transcript are unaffected and nothing here is recoverable-only-once.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearedPlaceholder, estimateResultTokens, planClears, type ToolOutputResult } from "./lib/tool-output-budget.ts";

export default function toolOutputBudget(pi: ExtensionAPI) {
	// Keyed by tool call rather than position: compaction renumbers history, and a result that has
	// been cleared must stay cleared or the cached prefix would flip back and forth.
	let cleared = new Set<string>();
	pi.on("session_start", () => {
		cleared = new Set();
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
