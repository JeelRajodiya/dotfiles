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
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface QueuedTask {
	task: string;
	model: string;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	queue: QueuedTask[];
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
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

export default function (pi: ExtensionAPI) {
	const agentStates: Map<string, AgentState> = new Map();
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let widgetCtx: any;
	let sessionDir = "";
	let contextWindow = 0;
	let directAgent: AgentDef | undefined;
	let normalMode = false;
	let defaultTools: string[] = [];
	const registeredAgentCommands = new Set<string>();

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
					const queued = enqueueAgent(def.name, task, ctx);
					if (!queued.ok) {
						ctx.ui.notify(queued.message, "error");
						return;
					}
					updateWidget();
					ctx.ui.notify(
						queued.status === "running"
							? `${displayName(def.name)} started in the background`
							: `${displayName(def.name)} queued at position ${queued.position}`,
						"info",
					);
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
			queue: [],
			toolCount: 0,
			elapsed: 0,
			lastWork: "",
			contextPct: 0,
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
		const queueStr = state.queue.length > 0 ? ` +${state.queue.length} queued` : "";
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s${queueStr}` : queueStr;
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		// Context bar: 5 blocks + percent
		const filled = Math.ceil(state.contextPct / 20);
		const bar = "#".repeat(filled) + "-".repeat(5 - filled);
		const ctxStr = `[${bar}] ${Math.ceil(state.contextPct)}%`;
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

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		model: string,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "running") {
			return Promise.resolve({
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.runCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		// Session file for this agent
		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);

		// Build args — first run creates session, subsequent runs resume
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--extension", join(homedir(), ".pi", "agent", "extensions", "openai-codex-fast.ts"),
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			"--session", agentSessionFile,
		];

		// Continue existing session if we have one
		if (state.sessionFile) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastWork = last;
								updateWidget();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							updateWidget();
						} else if (event.type === "message_end") {
							const msg = event.message;
							if (msg?.usage && contextWindow > 0) {
								state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						} else if (event.type === "agent_end") {
							const msgs = event.messages || [];
							const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
							if (last?.usage && contextWindow > 0) {
								state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				// Mark session file as available for resume
				if (code === 0) {
					state.sessionFile = agentSessionFile;
				}

				const full = textChunks.join("");
				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				try {
					widgetCtx?.ui.notify(
						`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
						state.status === "done" ? "success" : "error"
					);
				} catch {
					widgetCtx = undefined;
				}

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastWork = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	function runNext(state: AgentState): void {
		const next = state.queue.shift();
		if (!next) return;

		void dispatchAgent(state.def.name, next.task, next.model).then(result => {
			const output = result.output.length > 8000
				? result.output.slice(0, 8000) + "\n\n... [truncated]"
				: result.output;
			const status = result.exitCode === 0 ? "completed" : "failed";
			try {
				pi.sendMessage({
					customType: "agent-team-result",
					content: `[${displayName(state.def.name)}] ${status} in ${Math.round(result.elapsed / 1000)}s\nTask: ${next.task}\n\n${output || "(no output)"}`,
					display: true,
					details: { agent: state.def.name, task: next.task, result },
				}, { deliverAs: "followUp", triggerTurn: true });
			} catch {
				// The parent session may have closed while the background agent was running.
			} finally {
				runNext(state);
			}
		});
	}

	function enqueueAgent(agentName: string, task: string, ctx: any) {
		const state = agentStates.get(agentName.toLowerCase());
		if (!state) return { ok: false as const, message: `Agent "${agentName}" not found` };

		const queued = state.status === "running";
		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";
		state.queue.push({ task, model });
		const position = state.queue.length;
		if (!queued) runNext(state);
		updateWidget();
		return { ok: true as const, status: queued ? "queued" : "running", position };
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Queue a background task for a specialist agent and return immediately. Different agents run concurrently; tasks for the same agent run in order. Results are posted back to the main chat.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			const queued = enqueueAgent(agent, task, ctx);
			if (!queued.ok) throw new Error(queued.message);

			const message = queued.status === "running"
				? `${displayName(agent)} started in the background.`
				: `${displayName(agent)} queued at position ${queued.position}.`;
			return {
				content: [{ type: "text", text: `${message} The result will be posted to this chat.` }],
				details: { agent, task, status: queued.status, position: queued.position },
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

			if (details.status === "running" || details.status === "queued") {
				const suffix = details.status === "queued" ? ` #${details.position}` : " background";
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

	// ── Commands ─────────────────────────────────

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
			pi.setActiveTools(["dispatch_agent"]);
			pi.appendEntry("agent-team-mode", { team: name });
			updateWidget();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${agentStates.size})`);
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
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
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
- Review results and dispatch follow-up agents if needed
- If a task fails, try a different agent or adjust the task description
- Summarize the outcome for the user

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`,
		};
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clear widgets from previous session
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
		}
		widgetCtx = _ctx;
		contextWindow = _ctx.model?.contextWindow || 0;
		defaultTools = pi.getActiveTools().filter(tool => tool !== "dispatch_agent");
		loadAgents(_ctx.cwd);

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
			const savedMode = _ctx.sessionManager.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "agent-team-mode")
				.pop()?.data as { team?: string | null } | undefined;

			if (savedMode?.team === null) {
				normalMode = true;
				pi.setActiveTools(defaultTools);
				_ctx.ui.setStatus("agent-team", undefined);
				_ctx.ui.setFooter(undefined);
			} else {
				const teamNames = Object.keys(teams);
				const team = savedMode?.team && teams[savedMode.team] ? savedMode.team : teamNames[0];
				if (team) activateTeam(team);

				pi.setActiveTools(["dispatch_agent"]);
				_ctx.ui.setStatus("agent-team", `Team: ${activeTeamName} (${agentStates.size})`);
				const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
				_ctx.ui.notify(
					`Team: ${activeTeamName} (${members})\n` +
					`Team sets loaded from: .pi/agents/teams.yaml\n\n` +
					`/agent <name>        Open an agent chat\n` +
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
