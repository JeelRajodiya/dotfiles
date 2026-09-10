/**
 * A context window the agent can end on purpose.
 *
 * Pi only sheds context when it is forced to, at the compaction threshold, and pays a summarising
 * LLM call for it. Codex also lets the model say "I am done with this phase" and start clean for
 * free. The cut happens in the outgoing request only — the session on disk keeps the whole thread.
 */

export interface WindowMessage {
	role: string;
	content?: unknown;
}

/**
 * Everything before the turn that called `new_context` is dropped and replaced by what the model
 * asked to carry over. The cut lands on the assistant turn holding the call rather than after it,
 * so that turn keeps its own tool result and no provider sees an orphaned call.
 */
export function planNewContext<T extends WindowMessage>(messages: T[], cutIndex: number, carryOver: string): T[] {
	if (cutIndex <= 0 || cutIndex >= messages.length) return messages;
	const carried = {
		role: "user",
		content: [{ type: "text", text: `Context was reset here. Carried over from the earlier work:\n${carryOver}` }],
	} as unknown as T;
	return [carried, ...messages.slice(cutIndex)];
}

/**
 * The assistant turn that issued the call. Anything earlier is what the model chose to forget;
 * an id that is no longer in the transcript (compaction, a rewind) means the reset is spent.
 */
export function findCutIndex(messages: { role: string; content?: unknown }[], toolCallId: string): number {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as { type?: string; id?: string }[]) {
			if (block?.type === "toolCall" && block.id === toolCallId) return index;
		}
	}
	return -1;
}

export function formatRemaining(tokens: number | null, contextWindow: number): string {
	if (tokens === null) {
		return `Remaining context is not known yet (it is recomputed after the next response). Window is ${contextWindow} tokens.`;
	}
	const remaining = Math.max(0, contextWindow - tokens);
	return `${remaining} tokens remaining of ${contextWindow} (${Math.round((100 * remaining) / contextWindow)}% free; ${tokens} used).`;
}
