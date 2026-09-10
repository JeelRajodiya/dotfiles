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
import { Type } from "@sinclair/typebox";
import { clearedPlaceholder, estimateResultTokens, planClears, type ToolOutputResult } from "./lib/tool-output-budget.ts";
import { middleOutFile, withTruncationNotice } from "./lib/tool-output-shape.ts";
import { findCutIndex, formatRemaining, planNewContext } from "./lib/context-window.ts";

interface TruncatedDetails {
	truncation?: { truncated?: boolean };
	fullOutputPath?: string;
}

export default function toolOutputBudget(pi: ExtensionAPI) {
	// Keyed by tool call rather than position: compaction renumbers history, and a result that has
	// been cleared must stay cleared or the cached prefix would flip back and forth.
	let cleared = new Set<string>();
	let reset: { toolCallId: string; carryOver: string } | undefined;
	pi.on("session_start", () => {
		cleared = new Set();
		reset = undefined;
	});

	pi.registerTool({
		name: "get_context_remaining",
		label: "Context Remaining",
		description: "Report how many tokens are left in the current context window.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const usage = ctx.getContextUsage();
			const text = usage ? formatRemaining(usage.tokens, usage.contextWindow) : "Context usage is unavailable for this model.";
			return { content: [{ type: "text" as const, text }], details: usage };
		},
	});

	pi.registerTool({
		name: "new_context",
		label: "New Context",
		description: "Start a new context window, keeping only what you carry over. Shell state, working directory and files are untouched. Use it when you have finished a phase of work and the earlier detail no longer matters.",
		parameters: Type.Object({
			carry_over: Type.String({ description: "Everything that must survive: the task you were given, findings so far, decisions taken, what is left to do. Anything you omit is gone." }),
		}),
		async execute(id, params, _signal, _update, ctx) {
			const carryOver = (params as { carry_over: string }).carry_over.trim();
			if (!carryOver) throw new Error("carry_over cannot be empty; state what should survive the reset");
			// Only the newest reset matters: an older cut point is always inside the range this one drops.
			reset = { toolCallId: id, carryOver };
			const usage = ctx.getContextUsage();
			return {
				content: [{ type: "text" as const, text: `Context reset. Earlier turns are no longer visible; your carry-over note stands in for them.${usage?.tokens ? ` Released roughly ${usage.tokens} tokens.` : ""}` }],
				details: { carriedOverChars: carryOver.length },
			};
		},
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
		let outgoing = event.messages;
		if (reset) {
			const cutIndex = findCutIndex(outgoing, reset.toolCallId);
			if (cutIndex === -1) reset = undefined;
			else outgoing = planNewContext(outgoing, cutIndex, reset.carryOver);
		}
		const results = outgoing.filter(message => message.role === "toolResult") as unknown as ToolOutputResult[];
		for (const id of planClears(results, cleared)) cleared.add(id);
		let changed = outgoing !== event.messages;
		const messages = outgoing.map(message => {
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
