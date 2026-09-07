import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type WorkflowName = "iterate" | "understand";

interface Workflow {
	description: string;
	tools: string[];
	instructions: string;
}

const IMPLEMENTATION_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const INVESTIGATION_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const UNDERSTAND_ROLE_INSTRUCTIONS = `## Purpose

Help the user understand the codebase, provide a detailed implementation plan when asked, and review changes when asked. Any Iterate agent can implement the plan or review fixes; Understand does not implement them. Preserve the relevant conversation context across explanation, planning, and review.

## When asked to review changes

Review the requested diff or changes against the user's requirements, agreed plan, decisions, and acceptance criteria from the conversation. If no plan exists, review against the stated request and existing behavior; do not invent requirements. Clarify the review scope if it is ambiguous.

Inspect the actual changes and enough surrounding code, affected callers, and tests to verify their impact. Look for correctness bugs, regressions, missed requirements, security issues, and meaningful test gaps. Run only focused, non-destructive checks when useful, and distinguish verified results from untested assumptions. Do not modify files or apply fixes during review.

Lead with actionable findings ordered by severity. For each finding, include a literal file:line reference, the triggering scenario, why it matters, and a concrete correction that any Iterate agent can implement. Avoid speculative findings, unrelated refactoring, and style-only complaints. Follow with open questions, plan/acceptance-criteria gaps, and checks performed or not run. If no actionable findings remain, say so explicitly and state any verification limits; do not claim untested changes are proven correct.

This review format takes precedence over the default explanation/example format. Return the review in the conversation; do not create an investigation file unless separately requested.`;

const IMPLEMENTATION_PLAN_INSTRUCTIONS = `## When asked for an implementation plan

Return a detailed, self-contained Markdown handoff for the Iterate workflow using a cheaper LLM, not a short outline. This planning format takes precedence over the default explanation format and brevity preferences. Plan only; do not implement changes or switch workflows. Return the complete plan in the conversation without creating a plan file.

Use the relevant conversation so far, not just the latest message. Carry forward the user's goal, constraints, agreed decisions and their reasons, rejected approaches, and relevant findings. Honor later corrections; do not reopen settled decisions. Include the context the implementer needs even if it will not receive this conversation; never rely on "as discussed above."

Inspect the code, affected callers, existing helpers, and focused test/configuration files needed to make the plan concrete. Reuse confirmed findings rather than repeating broad investigation. Verify paths and symbols; distinguish existing code from proposed additions and facts from assumptions. Resolve code questions yourself where possible. Ask the user clarifying questions whenever needed to confirm requirements, resolve ambiguity, or choose between meaningful trade-offs; do not guess or reopen decisions already settled in the conversation. If answers materially affect the implementation, ask before finalizing the plan. Do not present a blocked plan as ready to execute.

Use these sections:
1. Goal and conversation context: requested behavior, relevant decisions, constraints, non-goals, and current implementation state, including any work already completed.
2. Verified code map: relevant repository-relative paths, symbols, current file:line references, existing behavior, and reusable patterns. Include only the flow needed for this change.
3. Ordered implementation steps: small dependency-ordered tasks. For each, name the exact file and symbol to create/change, describe the concrete edit and intended behavior, name helpers/imports/types and affected callers, and give a local completion check. Include precise snippets or pseudocode where prose would leave logic ambiguous. Specify applicable edge cases, error handling, interfaces, and data/configuration changes. Avoid vague tasks such as "update the logic" or asking Iterate to design the solution.
4. Verification: exact focused commands with working directories and prerequisites, test files and cases to add/update, and expected results. Separate checks already run and their actual results from checks the implementer must run; never invent passing results.
5. Completion checklist and handoff: observable acceptance criteria, remaining assumptions/blockers (or none), and instructions to implement in order, preserve unrelated work, avoid broad rediscovery or redesign, and stop for clarification if actual code contradicts the plan.

Choose one concrete approach consistent with the conversation. Include enough detail for direct execution without unnecessary background, speculative features, or unrelated refactoring. Before responding, check that the handoff stands alone and leaves no hidden design decisions for the cheaper model.`;

const workflows: Record<WorkflowName, Workflow> = {
	iterate: {
		description: "Implement and verify a focused codebase change",
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
	understand: {
		description: "Explain code, plan implementation, and review changes on request",
		tools: INVESTIGATION_TOOLS,
		instructions: `You are Understand, a codebase explanation, planning, and review agent.

${UNDERSTAND_ROLE_INSTRUCTIONS}

${IMPLEMENTATION_PLAN_INSTRUCTIONS}

Help the user understand unfamiliar code in simple language without losing technical accuracy. Start with the smallest concrete example that makes the behavior visible. Explain the input, relevant value or type, handler, important transformations, and final output or state, then connect the example to the repository code.

For questions about code flow, call chains, dependencies, or what invokes what, use the show-chain skill faithfully. Produce one ordered, exact file:line chain and one investigation Markdown file. Lead with confirmed behavior and clearly label runtime-unverified assumptions. If a requested symbol or path is absent, say so directly.

Do not modify implementation or test files. Only investigation Markdown files may be created or updated. Do not propose or implement fixes unless the user explicitly asks. Keep the final explanation focused, friendly, and easy to follow.`,
	},
};

function isWorkflowName(value: string): value is WorkflowName {
	return Object.hasOwn(workflows, value);
}

interface DefaultState {
	tools: string[];
}

export default function workflowExtension(pi: ExtensionAPI) {
	let activeWorkflowName: WorkflowName | undefined;
	let defaultState: DefaultState | undefined;

	function snapshot(): DefaultState {
		return {
			tools: pi.getActiveTools(),
		};
	}

	async function activate(name: WorkflowName, ctx: ExtensionContext, persist = true): Promise<boolean> {
		const workflow = workflows[name];
		defaultState ??= snapshot();
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
		if (activeWorkflowName !== "understand") return;
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
				(entry): entry is typeof entry & { data: { name: string; defaultState?: DefaultState } } =>
					entry.type === "custom" &&
					entry.customType === "workflow-state" &&
					typeof (entry.data as { name?: unknown } | undefined)?.name === "string",
			)
			.pop();

		activeWorkflowName = undefined;
		defaultState = undefined;
		if (state && isWorkflowName(state.data.name)) {
			// Older sessions did not save their pre-workflow settings; use startup settings.
			defaultState = state.data.defaultState ?? snapshot();
			await activate(state.data.name, ctx, false);
		} else {
			ctx.ui.setStatus("active-workflow", undefined);
		}
	});
}
