import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { formatElapsedDuration } from "./format";
import { installPrototypePatch } from "./prototype-patch-registry";

type ThinkingContent = { type?: unknown; thinking?: unknown };
type AssistantMessageLike = { content?: readonly ThinkingContent[] };
type TimedAssistantMessage = {
	updateContent: (message: AssistantMessageLike, isStreaming?: boolean) => void;
	hiddenThinkingLabel?: string;
};

type ThinkingTimerState = {
	message: AssistantMessageLike;
	startedAt: number;
	timer?: ReturnType<typeof setInterval>;
};

const states = new WeakMap<object, ThinkingTimerState>();
const activeComponents = new Set<object>();

export function formatThinkingTimerLabel(active: boolean, durationMs: number): string {
	return `${active ? "Thinking" : "Thought"} (${formatElapsedDuration(durationMs)})`;
}

function hasThinking(message: AssistantMessageLike): boolean {
	return Boolean(
		message.content?.some(
			(content) => content.type === "thinking" && typeof content.thinking === "string" && content.thinking.trim(),
		),
	);
}

function stopTimer(component: object, state: ThinkingTimerState): void {
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	activeComponents.delete(component);
}

/** Close labels for turns that end without a final non-streaming update (abort, error). */
export function settleThinkingTimers(now = Date.now()): void {
	for (const component of [...activeComponents]) {
		const state = states.get(component);
		if (!state) {
			activeComponents.delete(component);
			continue;
		}
		stopTimer(component, state);
		(component as TimedAssistantMessage).hiddenThinkingLabel = formatThinkingTimerLabel(false, now - state.startedAt);
	}
}

/** Add per-message elapsed labels to Pi's hidden-thinking renderer. */
export function installThinkingTimer(): () => void {
	const cleanupPatch = installPrototypePatch(
		AssistantMessageComponent.prototype,
		"updateContent",
		"assistant-message-update-content",
		({ predecessor, receiver, args }) => {
			if (!receiver || typeof receiver !== "object") return Reflect.apply(predecessor, receiver, args);
			const component = receiver as TimedAssistantMessage;
			const message = args[0] as AssistantMessageLike;
			const isStreaming = args[1] as boolean | undefined;
			const now = Date.now();
			let state = states.get(receiver);

			if (isStreaming && hasThinking(message)) {
				state ??= { message, startedAt: now };
				state.message = message;
				states.set(receiver, state);
				component.hiddenThinkingLabel = formatThinkingTimerLabel(true, now - state.startedAt);
				if (!state.timer) {
					const ticking = state;
					state.timer = setInterval(() => component.updateContent(ticking.message, true), 1000);
					state.timer.unref?.();
					activeComponents.add(receiver);
				}
			} else if (state) {
				stopTimer(receiver, state);
				component.hiddenThinkingLabel = formatThinkingTimerLabel(false, now - state.startedAt);
			}

			return Reflect.apply(predecessor, receiver, args);
		},
	);

	return () => {
		settleThinkingTimers();
		cleanupPatch();
	};
}
