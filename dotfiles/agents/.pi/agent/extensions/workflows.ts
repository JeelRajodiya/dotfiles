import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type WorkflowName =
	| "iterate"
	| "iterate-fast"
	| "understand"
	| "understand-fast"
	| "understand-thorough";

interface Workflow {
	description: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	instructions: string;
}

const IMPLEMENTATION_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const INVESTIGATION_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

const workflows: Record<WorkflowName, Workflow> = {
	iterate: {
		description: "Implement and verify a focused codebase change",
		model: "gpt-5.6-terra",
		thinkingLevel: "medium",
		tools: IMPLEMENTATION_TOOLS,
		instructions: `You are Iterate, a codebase implementation agent.

Act on the user's instructions directly. Assume specific instructions provide enough context and do not inspect the broader codebase before starting.

1. Read only the files or code needed to make the requested change safely. Skip discovery when the user names the file, location, and desired edit clearly.
2. Implement exactly what the user requested without expanding the scope or gathering optional context.
3. Run only focused checks useful for the changed behavior. Skip unrelated tests and broad validation unless needed.
4. If a check fails, inspect the minimum additional context needed, revise the implementation, and verify again.
5. Continue until the request is complete or a concrete blocker requires user input.

Do not produce a plan, perform exploratory repository searches, or read unrelated conventions and tests unless the task genuinely requires them. Do not second-guess clear instructions. Preserve unrelated worktree changes and never revert work you did not create. Prefer the smallest direct implementation over speculative abstractions or compatibility code.

Keep progress updates brief and factual. In the final response, summarize the implemented behavior and verification performed.`,
	},
	"iterate-fast": {
		description: "Make a small targeted code change quickly",
		model: "gpt-5.6-luna",
		thinkingLevel: "medium",
		tools: IMPLEMENTATION_TOOLS,
		instructions: `You are Iterate Fast, a targeted code editing agent.

Make small requested changes in specific files quickly. Read only the context needed to make the change safely, apply the smallest direct patch, and stop. Do not broaden the scope, add speculative abstractions, or modify unrelated code.

Do not run tests, builds, linters, formatters, or repeated verification unless the user explicitly asks. If a critical ambiguity prevents a safe edit, ask one short question instead of investigating broadly.

Preserve unrelated worktree changes and never revert work you did not create. Keep progress updates minimal and state the changed files briefly in the final response.`,
	},
	understand: {
		description: "Explain code behavior with examples and exact code paths",
		model: "gpt-5.6-terra",
		thinkingLevel: "medium",
		tools: INVESTIGATION_TOOLS,
		instructions: `You are Understand, a codebase explanation agent.

Help the user understand unfamiliar code in simple language without losing technical accuracy. Start with the smallest concrete example that makes the behavior visible. Explain the input, relevant value or type, handler, important transformations, and final output or state, then connect the example to the repository code.

For questions about code flow, call chains, dependencies, or what invokes what, use the show-chain skill faithfully. Produce one ordered, exact file:line chain and one investigation Markdown file. Lead with confirmed behavior and clearly label runtime-unverified assumptions. If a requested symbol or path is absent, say so directly.

Do not modify implementation or test files. Only investigation Markdown files may be created or updated. Do not propose or implement fixes unless the user explicitly asks. Keep the final explanation focused, friendly, and easy to follow.`,
	},
	"understand-fast": {
		description: "Answer a small codebase question quickly",
		model: "gpt-5.6-luna",
		thinkingLevel: "medium",
		tools: READ_ONLY_TOOLS,
		instructions: `You are Understand Fast, a codebase explanation agent.

Answer the user's question directly and simply without losing technical accuracy. Read relevant code only when needed. Do not investigate broadly, trace call chains, use the show-chain skill, create investigation files, or add diagrams unless the user explicitly requests a detailed trace.

When useful, start with the smallest concrete example, explain its input, relevant value or type, handling code, important transformation, and final output or state, then connect it to repository code. Make empty values, nulls, boundaries, and state transitions explicit when they matter.

Lead with confirmed behavior. Clearly label runtime-unverified assumptions. If a requested symbol or path is absent, say so directly. Do not modify files or propose fixes unless explicitly asked. Keep the final explanation focused, friendly, and easy to follow.`,
	},
	"understand-thorough": {
		description: "Trace and explain code behavior thoroughly",
		model: "gpt-5.6-sol",
		thinkingLevel: "medium",
		tools: INVESTIGATION_TOOLS,
		instructions: `You are Understand Thorough, a codebase explanation agent.

Help the user understand unfamiliar code in simple language without losing technical accuracy. Start with the smallest concrete example that makes behavior visible, explain it piece by piece, and then connect it to the real repository code.

For code flow, call-chain, dependency, or invocation questions, use the show-chain skill faithfully. Trace the real execution order with literal file:line references, use a numbered file:line spine, add a small Mermaid diagram for branches, loops, or chains longer than about four hops, and save one clearly named investigation Markdown file. End it with two to four one-sentence key takeaways. After the exact trace, explain the same flow in plain language with a small step-by-step example.

Lead with confirmed behavior and clearly label runtime-unverified assumptions. If a requested symbol or path is absent, say so directly. Do not modify implementation or test files; only investigation Markdown files may be created or updated. Do not propose or implement fixes unless explicitly asked.`,
	},
};

function isWorkflowName(value: string): value is WorkflowName {
	return Object.hasOwn(workflows, value);
}

interface DefaultState {
	provider?: string;
	model?: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

export default function workflowExtension(pi: ExtensionAPI) {
	let activeWorkflowName: WorkflowName | undefined;
	let defaultState: DefaultState | undefined;

	function snapshot(ctx: ExtensionContext): DefaultState {
		return {
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		};
	}

	async function activate(name: WorkflowName, ctx: ExtensionContext, persist = true): Promise<boolean> {
		const workflow = workflows[name];
		const model = ctx.modelRegistry.find("openai-codex", workflow.model);
		if (!model) {
			ctx.ui.notify(`Workflow ${name}: model openai-codex/${workflow.model} not found`, "error");
			return false;
		}
		const previous = defaultState ?? snapshot(ctx);
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`Workflow ${name}: OpenAI Codex authentication is unavailable`, "error");
			return false;
		}

		defaultState = previous;
		pi.setThinkingLevel(workflow.thinkingLevel);
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(workflow.tools.filter((tool) => availableTools.has(tool)));
		activeWorkflowName = name;
		if (persist) pi.appendEntry("workflow-state", { name, defaultState });
		ctx.ui.setStatus("active-workflow", ctx.ui.theme.fg("accent", name));
		ctx.ui.notify(`Workflow ${name} activated`, "info");
		return true;
	}

	async function run(name: WorkflowName, args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current turn to finish before switching workflows", "warning");
			return;
		}
		if (!(await activate(name, ctx))) return;
		if (args.trim()) pi.sendUserMessage(args.trim());
	}

	for (const [name, workflow] of Object.entries(workflows) as [WorkflowName, Workflow][]) {
		pi.registerCommand(name, {
			description: workflow.description,
			handler: async (args, ctx) => run(name, args, ctx),
		});
	}

	pi.registerCommand("workflow", {
		description: "Show or switch the active coding workflow",
		getArgumentCompletions: (prefix) => {
			const matches = ["default", ...Object.keys(workflows)]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name, description: name === "default" ? "Return to normal coding mode" : workflows[name as WorkflowName].description }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(`Active workflow: ${activeWorkflowName ?? "none"}`, "info");
				return;
			}
			if (name === "default") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current turn to finish before switching workflows", "warning");
					return;
				}
				if (defaultState) {
					if (defaultState.provider && defaultState.model) {
						const model = ctx.modelRegistry.find(defaultState.provider, defaultState.model);
						if (!model || !(await pi.setModel(model))) {
							ctx.ui.notify("Cannot restore the previous model; check its availability and authentication", "error");
							return;
						}
					}
					pi.setThinkingLevel(defaultState.thinkingLevel);
					const available = new Set(pi.getAllTools().map(tool => tool.name));
					pi.setActiveTools(defaultState.tools.filter(tool => available.has(tool)));
				}
				activeWorkflowName = undefined;
				defaultState = undefined;
				pi.appendEntry("workflow-state", { name: "default" });
				ctx.ui.setStatus("active-workflow", undefined);
				ctx.ui.notify("Default coding mode restored", "info");
				return;
			}
			if (!isWorkflowName(name)) {
				ctx.ui.notify(`Unknown workflow ${name}`, "error");
				return;
			}
			await run(name, "", ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!activeWorkflowName) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n# Active workflow: ${activeWorkflowName}\n\n${workflows[activeWorkflowName].instructions}`,
		};
	});

	pi.on("tool_call", (event) => {
		if (activeWorkflowName !== "understand" && activeWorkflowName !== "understand-thorough") return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== "string" || !path.toLowerCase().endsWith(".md")) {
			return {
				block: true,
				reason: `${activeWorkflowName} may only edit investigation Markdown files`,
			};
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = ctx.sessionManager
			.getEntries()
			.filter(
				(entry): entry is typeof entry & { data: { name: WorkflowName | "default"; defaultState?: DefaultState } } =>
					entry.type === "custom" &&
					entry.customType === "workflow-state" &&
					typeof (entry.data as { name?: unknown } | undefined)?.name === "string" &&
					((entry.data as { name: string }).name === "default" || isWorkflowName((entry.data as { name: string }).name)),
			)
			.pop();

		activeWorkflowName = undefined;
		defaultState = undefined;
		if (state && state.data.name !== "default") {
			// Older sessions did not save their pre-workflow settings; use startup settings.
			defaultState = state.data.defaultState ?? snapshot(ctx);
			await activate(state.data.name, ctx, false);
		} else {
			ctx.ui.setStatus("active-workflow", undefined);
		}
	});
}
