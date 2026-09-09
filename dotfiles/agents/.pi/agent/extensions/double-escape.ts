import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { canRewind, dropAbandonedTurn } from "./lib/abort-rewind.ts";
import { READ_ONLY_TOOLS } from "./lib/agent-defs.ts";

type Turn = { prompt: string; rootId: string; parentId: string | null; abortRequested: boolean; mutated: boolean };

class AbortRewindEditor extends CustomEditor {
	private readonly abort: () => boolean;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		abort: () => boolean,
	) {
		super(tui, theme, keybindings);
		this.abort = abort;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "escape") && this.abort()) return;
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	let submittedPrompt: string | undefined;
	let turn: Turn | undefined;

	pi.on("input", (event, ctx) => {
		if (event.source === "interactive" && event.streamingBehavior === undefined && ctx.isIdle()) {
			submittedPrompt = event.text;
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const user = [...branch].reverse().find((entry: any) => entry.type === "message" && entry.message.role === "user");
		if (!user) return;
		turn = {
			prompt: submittedPrompt ?? event.prompt,
			rootId: user.id,
			parentId: user.parentId,
			abortRequested: false,
			mutated: false,
		};
		submittedPrompt = undefined;
	});

	// Pi provides no mutation metadata for shell or third-party tools. Treat those as
	// mutation-bearing so this extension never removes history when it cannot know.
	pi.on("tool_execution_start", event => {
		if (!turn) return;
		if (!(READ_ONLY_TOOLS as readonly string[]).includes(event.toolName)) turn.mutated = true;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new AbortRewindEditor(
			tui,
			theme,
			keybindings,
			() => {
				if (ctx.isIdle() || !turn) return false;
				turn.abortRequested = true;
				ctx.abort(); // Native handler also restores queued messages and prevents their delivery.
				return true;
			},
		));
	});

	pi.on("agent_end", (event, ctx) => {
		const aborted = event.messages.some((message: any) => message.role === "assistant" && message.stopReason === "aborted");
		if (!turn || !canRewind(turn.abortRequested && aborted, turn.mutated)) return;

		// SessionManager is intentionally append-only. Pi has no public removal API, so
		// only use its current internal rewrite hooks after the abort is confirmed.
		const session = ctx.sessionManager as any;
		if (!Array.isArray(session.fileEntries) || typeof session._buildIndex !== "function" || typeof session._rewriteFile !== "function") {
			ctx.ui.notify("Aborted prompt kept: this Pi version cannot safely remove session history.", "warning");
			return;
		}
		try {
			session.fileEntries = dropAbandonedTurn(session.fileEntries, turn.rootId);
			session._buildIndex();
			if (turn.parentId) session.branch(turn.parentId);
			else session.resetLeaf();
			session._rewriteFile();
			// Keep the surviving branch active after a restart without adding model context.
			session.appendCustomEntry("abort-rewind", {});
			ctx.ui.setEditorText(turn.prompt);
		} catch {
			ctx.ui.notify("Aborted prompt kept: session history could not be safely rewritten.", "warning");
		}
	});

	pi.on("agent_settled", () => { turn = undefined; submittedPrompt = undefined; });
	pi.on("session_shutdown", () => { turn = undefined; submittedPrompt = undefined; });
}
