/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md.
 * Teams are defined in .pi/agents/teams.yaml — on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
 *
 * Commands:
 *   /agent NAME           — open an agent's chat session
 *   /AGENT TASK           — queue one agent directly (for example /iterate)
 *   /agents-team          — switch active team or use normal mode
 *   /agents-list          — list loaded agents
 *   /agents-grid N        — set column count (default 2)
 *
 * Usage: pi -e extensions/agent-team.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
	AgentRpcTransport,
	contextTokensFromUsage,
	hasRunningAgent,
	latestAssistantContextTokens,
	shouldFinalizeAgentEvent,
	terminateChild,
} from "./agent-team-helpers";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	model?: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface ActiveAgentRun {
	child: ChildProcessWithoutNullStreams;
	transport: AgentRpcTransport;
	textChunks: string[];
	initialTask: string;
	sessionFile: string;
	startTime: number;
	accepted: boolean;
	finished: boolean;
	stopping: boolean;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextTokens?: number;
	contextWindow: number;
	sessionFile: string | null;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
	activeRun?: ActiveAgentRun;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Teams YAML Parser ────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			model: frontmatter.model,
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		join(homedir(), ".pi", "agent", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}

// ── Extension ────────────────────────────────────

const TEAM_TOOLS = ["dispatch_agent", "set_agent_model"];

export default function (pi: ExtensionAPI) {
	const agentStates: Map<string, AgentState> = new Map();
	const agentModelOverrides = new Map<string, string>();
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let widgetCtx: any;
	let sessionDir = "";
	let directAgent: AgentDef | undefined;
	let normalMode = false;
	let defaultTools: string[] = [];
	const registeredAgentCommands = new Set<string>();

	function parentModel(ctx: any): string {
		return ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";
	}

	function effectiveAgentModel(def: AgentDef, ctx: any): string {
		return agentModelOverrides.get(def.name.toLowerCase()) ?? def.model ?? parentModel(ctx);
	}

	function modelContextWindow(model: string, ctx: any): number {
		const slash = model.indexOf("/");
		return slash > 0
			? ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))?.contextWindow ?? 0
			: 0;
	}

	function modelSetting(def: AgentDef, ctx: any): string {
		const override = agentModelOverrides.get(def.name.toLowerCase());
		if (override) return `${override} (session override)`;
		if (def.model) return `${def.model} (default)`;
		return `${parentModel(ctx)} (inherited)`;
	}

	function validModel(model: string, ctx: any): boolean {
		const slash = model.indexOf("/");
		return slash > 0 && Boolean(ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1)));
	}

	function setAgentModel(agentName: string, model: string, ctx: any): string {
		const def = allAgentDefs.find(agent => agent.name.toLowerCase() === agentName.toLowerCase());
		if (!def) throw new Error(`Unknown agent "${agentName}"`);
		if (model === "inherit") {
			agentModelOverrides.delete(def.name.toLowerCase());
		} else if (validModel(model, ctx)) {
			agentModelOverrides.set(def.name.toLowerCase(), model);
		} else {
			throw new Error(`Unknown model "${model}"`);
		}
		pi.appendEntry("agent-team-model-overrides", { overrides: Object.fromEntries(agentModelOverrides) });
		const state = agentStates.get(def.name.toLowerCase());
		if (state && state.status !== "running") {
			state.contextWindow = modelContextWindow(effectiveAgentModel(def, ctx), ctx);
			updateWidget();
		}
		return modelSetting(def, ctx);
	}

	function sessionPath(def: AgentDef): string {
		const key = def.name.toLowerCase().replace(/\s+/g, "-");
		return join(sessionDir, `${key}.json`);
	}

	function ensureSession(def: AgentDef, cwd: string): string {
		const path = sessionPath(def);
		if (!existsSync(path)) {
			writeFileSync(path, JSON.stringify({
				type: "session",
				version: 3,
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				cwd,
			}) + "\n");
		}
		return path;
	}

	function loadAgents(cwd: string) {
		// Create session storage dir
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// Load all agent definitions
		allAgentDefs = scanAgentDirs(cwd);
		for (const def of allAgentDefs) {
			if (registeredAgentCommands.has(def.name)) continue;
			registeredAgentCommands.add(def.name);
			pi.registerCommand(def.name, {
				description: `Queue a background task for ${displayName(def.name)}`,
				handler: async (args, ctx) => {
					const task = args.trim();
					if (!task) {
						ctx.ui.notify(`Usage: /${def.name} <task> (or /agent ${def.name} for direct chat)`, "info");
						return;
					}
					widgetCtx = ctx;
					if (!agentStates.has(def.name.toLowerCase())) {
						agentStates.set(def.name.toLowerCase(), createState(def));
					}
					try {
						const submitted = await submitAgent(def.name, task, ctx);
						ctx.ui.notify(
							submitted.status === "steered"
								? `${displayName(def.name)} steering accepted`
								: `${displayName(def.name)} started in the background`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				},
			});
		}

		// Prefer project teams, then use the global agent configuration.
		const projectTeamsPath = join(cwd, ".pi", "agents", "teams.yaml");
		const teamsPath = existsSync(projectTeamsPath)
			? projectTeamsPath
			: join(homedir(), ".pi", "agent", "agents", "teams.yaml");
		if (existsSync(teamsPath)) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
		}

		// If no teams defined, create a default "all" team
		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map(d => d.name) };
		}
	}

	function createState(def: AgentDef): AgentState {
		const file = sessionPath(def);
		return {
			def,
			status: "idle",
			task: "",
			toolCount: 0,
			elapsed: 0,
			lastWork: "",
			contextTokens: latestAssistantContextTokens(file),
			contextWindow: modelContextWindow(effectiveAgentModel(def, widgetCtx), widgetCtx),
			sessionFile: existsSync(file) ? file : null,
			runCount: 0,
		};
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const members = teams[teamName] || [];
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));

		agentStates.clear();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (def) agentStates.set(def.name.toLowerCase(), createState(def));
		}

		// Auto-size grid columns based on team size
		const size = agentStates.size;
		gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		const formatTokens = (tokens: number) => tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${Math.round(tokens)}`;
		const ctxStr = `${state.contextTokens === undefined ? "?" : formatTokens(state.contextTokens)}/${
			state.contextWindow > 0 ? formatTokens(state.contextWindow) : "?"
		}`;
		const ctxLine = theme.fg("dim", ctxStr);
		const ctxVisible = ctxStr.length;

		const workRaw = state.task
			? (state.lastWork || state.task)
			: state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");
		const separator = theme.fg("dim", " · ");
		const summary = " " + nameStr + separator + statusLine + separator + ctxLine;
		const summaryVisible = 1 + nameVisible + 3 + statusVisible + 3 + ctxVisible;

		return [
			theme.fg("dim", top),
			border(summary, summaryVisible),
			border(" " + workLine, 1 + workVisible),
			theme.fg("dim", bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		try {
			widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 0);

			return {
				render(width: number): string[] {
					if (agentStates.size === 0) {
						text.setText(theme.fg("dim", "No agents found. Add .md files to agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(4).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
			});
		} catch {
			widgetCtx = undefined;
		}
	}

	// ── Dispatch Agent ───────────────────────────

	function terminateRun(run: ActiveAgentRun): void {
		run.stopping = true;
		run.transport.fail(new Error("Agent process stopped"));
		terminateChild(run.child);
	}

	function finishRun(state: AgentState, run: ActiveAgentRun, error?: Error): void {
		if (run.finished || state.activeRun !== run) return;
		run.finished = true;
		clearInterval(state.timer);
		state.elapsed = Date.now() - run.startTime;
		state.status = error ? "error" : "done";
		if (!error) state.sessionFile = run.sessionFile;
		const full = run.textChunks.join("");
		state.lastWork = error?.message ?? full.split("\n").filter(line => line.trim()).pop() ?? "";
		state.activeRun = undefined;
		updateWidget();

		if (!run.stopping && run.accepted) {
			const output = full.length > 8000 ? `${full.slice(0, 8000)}\n\n... [truncated]` : full;
			const result = { output: error ? error.message : output, exitCode: error ? 1 : 0, elapsed: state.elapsed };
			try {
				pi.sendMessage({
					customType: "agent-team-result",
					content: `[${displayName(state.def.name)}] ${error ? "failed" : "completed"} in ${Math.round(state.elapsed / 1000)}s\nTask: ${run.initialTask}\n\n${result.output || "(no output)"}`,
					display: true,
					details: { agent: state.def.name, task: run.initialTask, result },
				}, { deliverAs: "followUp", triggerTurn: true });
				widgetCtx?.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					error ? "error" : "success",
				);
			} catch {
				widgetCtx = undefined;
			}
		}
		terminateRun(run);
	}

	function startAgent(state: AgentState, task: string, model: string, ctx: any): ActiveAgentRun {
		state.status = "running";
		state.contextWindow = modelContextWindow(model, ctx);
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.runCount++;

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);
		const args = [
			"--mode", "rpc",
			"--no-extensions",
			"--extension", join(homedir(), ".pi", "agent", "extensions", "openai-codex-fast.ts"),
			"--extension", join(homedir(), ".pi", "agent", "extensions", "ponytail.ts"),
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			"--session", agentSessionFile,
		];
		if (state.sessionFile) args.push("-c");

		const child = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
		const transport = new AgentRpcTransport((line, callback) => child.stdin.write(line, callback));
		const run: ActiveAgentRun = {
			child,
			transport,
			textChunks: [],
			initialTask: task,
			sessionFile: agentSessionFile,
			startTime,
			accepted: false,
			finished: false,
			stopping: false,
		};
		state.activeRun = run;
		updateWidget();

		let buffer = "";
		const handleEvent = (event: any) => {
			if (transport.handle(event)) return;
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					run.textChunks.push(delta.delta || "");
					const full = run.textChunks.join("");
					state.lastWork = full.split("\n").filter((line: string) => line.trim()).pop() || "";
					updateWidget();
				}
			} else if (event.type === "tool_execution_start") {
				state.toolCount++;
				updateWidget();
			} else if (event.type === "message_end") {
				const tokens = contextTokensFromUsage(event.message?.usage);
				if (tokens !== undefined) {
					state.contextTokens = tokens;
					updateWidget();
				}
			} else if (event.type === "agent_end") {
				const last = [...(event.messages || [])]
					.reverse()
					.find((message: any) =>
						message.role === "assistant" && contextTokensFromUsage(message.usage) !== undefined
					);
				const tokens = contextTokensFromUsage(last?.usage);
				if (tokens !== undefined) state.contextTokens = tokens;
				updateWidget();
			} else if (shouldFinalizeAgentEvent(event.type)) {
				finishRun(state, run);
			}
		};
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			try { handleEvent(JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line)); } catch {}
		};

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		});
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", () => {});
		child.stdin.on("error", error => transport.fail(error));
		child.on("error", error => {
			transport.fail(error);
			if (!run.stopping) finishRun(state, run, new Error(`Agent process error: ${error.message}`));
		});
		child.on("close", code => {
			handleLine(buffer);
			transport.fail(new Error(`Agent process exited with code ${code ?? 1}`));
			if (!run.finished && !run.stopping) {
				finishRun(state, run, new Error(`Agent process exited before settling (code ${code ?? 1})`));
			}
		});
		return run;
	}

	async function submitAgent(agentName: string, task: string, ctx: any) {
		const state = agentStates.get(agentName.toLowerCase());
		if (!state) throw new Error(`Agent "${agentName}" not found`);

		if (state.status === "running") {
			const run = state.activeRun;
			if (!run || run.finished || run.stopping) throw new Error(`Agent "${displayName(state.def.name)}" has no active steering transport`);
			try {
				await run.transport.request({ type: "prompt", message: task, streamingBehavior: "steer" });
			} catch (error) {
				throw new Error(`Unable to steer ${displayName(state.def.name)}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { status: "steered" as const };
		}

		const run = startAgent(state, task, effectiveAgentModel(state.def, ctx), ctx);
		try {
			await run.transport.request({ type: "prompt", message: task });
			run.accepted = true;
			return { status: "running" as const };
		} catch (error) {
			const failure = new Error(`Unable to start ${displayName(state.def.name)}: ${error instanceof Error ? error.message : String(error)}`);
			finishRun(state, run, failure);
			throw failure;
		}
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Start a specialist agent in the background, or steer that agent when it is already running. Different agents run concurrently. Results are posted back to the main chat.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			const submitted = await submitAgent(agent, task, ctx);
			const message = submitted.status === "steered"
				? `${displayName(agent)} steering accepted.`
				: `${displayName(agent)} started in the background. The result will be posted to this chat.`;
			return {
				content: [{ type: "text", text: message }],
				details: { agent, task, status: submitted.status },
			};
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			if (details.status === "running" || details.status === "steered") {
				const suffix = details.status === "steered" ? " steering accepted" : " background";
				return new Text(theme.fg("accent", `● ${details.agent}`) + theme.fg("dim", suffix), 0, 0);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	pi.registerTool({
		name: "set_agent_model",
		label: "Set Agent Model",
		description: "Set a session-specific model for an agent, or use inherit to restore its configured default.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			model: Type.String({ description: "Provider/model identifier, or inherit" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, model } = params as { agent: string; model: string };
			const setting = setAgentModel(agent, model, ctx);
			return {
				content: [{ type: "text", text: `${displayName(agent)} model: ${setting}` }],
				details: { agent, model: setting },
			};
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("agent-model", {
		description: "Show or set an agent model for this session",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const teamAgents = normalMode || directAgent
				? []
				: Array.from(agentStates.values()).map(state => state.def);
			const space = prefix.indexOf(" ");
			if (space < 0) {
				const items = teamAgents
					.filter(def => def.name.startsWith(prefix))
					.map(def => ({ value: def.name, label: def.name }));
				return items.length > 0 ? items : null;
			}
			const agent = prefix.slice(0, space);
			if (!teamAgents.some(def => def.name === agent)) return null;
			const modelPrefix = prefix.slice(space + 1);
			const models = ["inherit", ...new Set(allAgentDefs.map(def => def.model).filter(Boolean) as string[])];
			const items = models
				.filter(model => model.startsWith(modelPrefix))
				.map(model => ({ value: `${agent} ${model}`, label: model }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (directAgent) {
				ctx.ui.notify("Use /agent exit first; direct chats use normal model controls", "warning");
				return;
			}
			const [agent, model, ...extra] = args.trim().split(/\s+/);
			if (!agent) {
				ctx.ui.notify(allAgentDefs.map(def => `${displayName(def.name)}: ${modelSetting(def, ctx)}`).join("\n"), "info");
				return;
			}
			if (!model || extra.length > 0) {
				ctx.ui.notify("Usage: /agent-model <agent> <provider/model|inherit>", "error");
				return;
			}
			try {
				ctx.ui.notify(`${displayName(agent)} model: ${setAgentModel(agent, model, ctx)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent", {
		description: "Open an agent's chat session, or return with /agent exit",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const names = directAgent || normalMode
				? [...(directAgent ? ["exit"] : []), ...allAgentDefs.map(def => def.name)]
				: Array.from(agentStates.values()).map(state => state.def.name);
			const items = names
				.filter(name => name.startsWith(prefix))
				.map(name => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (hasRunningAgent(agentStates.values())) {
				ctx.ui.notify("Wait for running team agents before switching sessions", "warning");
				return;
			}
			if (directAgent && (!requested || requested === directAgent.name)) {
				ctx.ui.notify(`Chatting with ${displayName(directAgent.name)}. Use /agent exit to return.`, "info");
				return;
			}

			if (requested === "exit") {
				const current = ctx.sessionManager.getSessionFile();
				const parentFile = current ? `${current}.parent` : "";
				if (!parentFile || !existsSync(parentFile)) {
					ctx.ui.notify("No parent chat found. Use /resume to switch sessions.", "warning");
					return;
				}
				const parent = readFileSync(parentFile, "utf-8").trim();
				const result = await ctx.switchSession(parent);
				if (!result.cancelled) unlinkSync(parentFile);
				return;
			}

			let name = requested;
			if (!name) {
				const choices = normalMode
					? allAgentDefs.map(def => def.name)
					: Array.from(agentStates.values()).map(state => state.def.name);
				name = await ctx.ui.select("Open Agent Chat", choices) ?? "";
				if (!name) return;
			}

			const def = allAgentDefs.find(agent => agent.name.toLowerCase() === name.toLowerCase());
			const allowed = directAgent || normalMode || agentStates.has(name.toLowerCase());
			if (!def || !allowed) {
				ctx.ui.notify(`Agent "${name}" is not in the active team`, "error");
				return;
			}

			const current = ctx.sessionManager.getSessionFile();
			const parent = directAgent && current && existsSync(`${current}.parent`)
				? readFileSync(`${current}.parent`, "utf-8").trim()
				: current;
			if (!parent) {
				ctx.ui.notify("Direct agent chat requires a saved parent session", "error");
				return;
			}

			const target = ensureSession(def, ctx.cwd);
			writeFileSync(`${target}.parent`, parent + "\n");
			await ctx.switchSession(target);
		},
	});

	pi.registerCommand("agents-team", {
		description: "Select a team, or choose none for normal Pi mode",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["none", ...Object.keys(teams)]
				.filter(name => name.startsWith(prefix))
				.map(name => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			let name = args.trim();
			if (!name) {
				const options = [
					"none — Normal Pi mode",
					...teamNames.map(team => `${team} — ${teams[team].map(displayName).join(", ")}`),
				];
				const choice = await ctx.ui.select("Select Team", options);
				if (choice === undefined) return;
				name = choice === options[0] ? "none" : teamNames[options.indexOf(choice) - 1];
			}

			if (name === "none") {
				normalMode = true;
				activeTeamName = "";
				agentStates.clear();
				pi.setActiveTools(defaultTools);
				pi.appendEntry("agent-team-mode", { team: null });
				ctx.ui.setWidget("agent-team", undefined);
				ctx.ui.setStatus("agent-team", undefined);
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Normal Pi mode restored", "info");
				return;
			}

			if (!teams[name]) {
				ctx.ui.notify(`Unknown team "${name}"`, "error");
				return;
			}
			normalMode = false;
			activateTeam(name);
			pi.setActiveTools(TEAM_TOOLS);
			pi.appendEntry("agent-team-mode", { team: name });
			updateWidget();
			ctx.ui.setStatus("agent-team", undefined);
			ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List all loaded agents",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const names = Array.from(agentStates.values())
				.map(s => {
					const session = s.sessionFile ? "resumed" : "new";
					return `${displayName(s.def.name)} (${s.status}, ${session}, runs: ${s.runCount}): ${s.def.description}`;
				})
				.join("\n");
			_ctx.ui.notify(names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({
				value: n,
				label: `${n} columns`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (normalMode) return;
		if (directAgent) {
			return {
				systemPrompt: `${_event.systemPrompt}\n\n# Direct agent: ${displayName(directAgent.name)}\n\n${directAgent.systemPrompt}`,
			};
		}

		// Build dynamic agent catalog from active team only
		const agentCatalog = Array.from(agentStates.values())
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Model:** ${modelSetting(s.def, _ctx)}\n**Tools:** ${s.def.tools}`)
			.join("\n\n");

		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

		return {
			systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents outside this team.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Choose the right agent(s) for each sub-task
- Dispatch tasks using the dispatch_agent tool
- Use set_agent_model when the user asks to change an agent's model
- Review results and dispatch follow-up agents if needed
- If a task fails, try a different agent or adjust the task description
- Summarize the outcome for the user

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- Model overrides apply to this parent session; use set_agent_model with inherit to clear one
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`,
		};
	});

	// ── Session Start ────────────────────────────

	pi.on("model_select", (_event, ctx) => {
		for (const state of agentStates.values()) {
			if (state.status !== "running") {
				state.contextWindow = modelContextWindow(effectiveAgentModel(state.def, ctx), ctx);
			}
		}
		updateWidget();
	});

	pi.on("session_shutdown", () => {
		for (const state of agentStates.values()) {
			if (!state.activeRun) continue;
			clearInterval(state.timer);
			terminateRun(state.activeRun);
		}
	});

	pi.on("session_start", async (_event, _ctx) => {
		// Clear widgets from previous session
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
		}
		widgetCtx = _ctx;
		defaultTools = pi.getActiveTools().filter(tool => !TEAM_TOOLS.includes(tool));
		loadAgents(_ctx.cwd);
		agentModelOverrides.clear();

		const currentSession = _ctx.sessionManager.getSessionFile();
		directAgent = currentSession
			? allAgentDefs.find(def => resolve(sessionPath(def)) === resolve(currentSession))
			: undefined;

		normalMode = false;
		if (directAgent) {
			const available = new Set(pi.getAllTools().map(tool => tool.name));
			pi.setActiveTools(directAgent.tools.split(",").map(tool => tool.trim()).filter(tool => available.has(tool)));
			_ctx.ui.setStatus("agent-team", `Chat: ${displayName(directAgent.name)}`);
			_ctx.ui.notify(
				`Direct chat with ${displayName(directAgent.name)}\n` +
				`Use the normal model controls to change models.\n` +
				`/agent exit          Return to the parent chat`,
				"info",
			);
		} else {
			const savedOverrides = _ctx.sessionManager.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "agent-team-model-overrides")
				.pop()?.data as { overrides?: Record<string, string> } | undefined;
			for (const [agent, model] of Object.entries(savedOverrides?.overrides ?? {})) {
				if (allAgentDefs.some(def => def.name.toLowerCase() === agent) && validModel(model, _ctx)) {
					agentModelOverrides.set(agent, model);
				}
			}

			const savedMode = _ctx.sessionManager.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "agent-team-mode")
				.pop()?.data as { team?: string | null } | undefined;

			const team = savedMode?.team && teams[savedMode.team] ? savedMode.team : undefined;
			if (!team) {
				normalMode = true;
				activeTeamName = "";
				agentStates.clear();
				pi.setActiveTools(defaultTools);
				_ctx.ui.setWidget("agent-team", undefined);
				_ctx.ui.setStatus("agent-team", undefined);
				_ctx.ui.setFooter(undefined);
			} else {
				activateTeam(team);

				pi.setActiveTools(TEAM_TOOLS);
				_ctx.ui.setStatus("agent-team", undefined);
				const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
				_ctx.ui.notify(
					`Team: ${activeTeamName} (${members})\n` +
					`Team sets loaded from: .pi/agents/teams.yaml\n\n` +
					`/agent <name>        Open an agent chat\n` +
					`/agent-model         Show or change agent models\n` +
					`/agents-team         Select a team or normal mode\n` +
					`/agents-list         List active agents and status\n` +
					`/agents-grid <1-6>   Set grid column count`,
					"info",
				);
				updateWidget();
			}
		}

		// Footer: model | team | context bar
		if (normalMode) return;
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const label = directAgent ? `@${directAgent.name}` : activeTeamName;
				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", label);
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
