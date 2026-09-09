/** Dynamic, session-local specialist teams. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
	appendTaskHistory, addTokenCounts, AGENT_VIEW_COMMAND, AgentRpcTransport, decideRouting, canClearAgent, canCompactAgent, canInterruptAgent, canKillHostAgent, canSteerAgent, childSessionPath, contextTokensFromUsage, encodeCwd,
	formatAgentModelLabel, formatToolActivity, interruptAgentRun, isAgentViewCommand, readChildSession,
	nextAgentName, OPENAI_FAST_ENV, parseTellArguments, pruneSessionDirs, removeQueuedItem, resultDeliveryStatus, restoreNextWaitingAgent, runConcurrent, shouldIgnoreAgentRunEvent, updateQueuedItem,
	restoreWaitingAgents, tokenCountsFromUsage, shouldCompleteTellTarget, shouldFinalizeAgentEvent,
	terminateChild, type AgentCompletionStatus, type AgentOrigin, type TaskHistoryEntry, type TokenCounts,
} from "./agent-team-helpers.ts";
import { ActivityLog, OutputBuffer, TextTail, type ActivityKind } from "./lib/agent-activity.ts";
import { CUSTOM_AGENT, scanAgentDirs, scanTeams, type AgentDef, type TeamDef } from "./lib/agent-defs.ts";
import { FRAME_MS, renderDetail, renderEmpty, renderGrid, type AgentStatus } from "./lib/agent-render.ts";

interface ActiveAgentRun {
	child: ChildProcessWithoutNullStreams; transport: AgentRpcTransport; text: TextTail; stderrChunks: string[]; initialTask: string; tasks: string[];
	sessionFile: string; startTime: number; runId: string; usageSequence: number; accepted: boolean; finished: boolean; stopping: boolean; maintenance: boolean;
	output: OutputBuffer; toolStarts: Map<string, { summary: string; startTime: number }>; fast: boolean; thinking: string;
}
interface AgentState {
	name: string; def: AgentDef; goal: string; status: AgentStatus; pendingOutcome?: AgentCompletionStatus; task: string;
	toolCount: number; elapsed: number; lastWork: string; activity: ActivityLog; contextTokens: number; contextWindow: number; tokens: TokenCounts;
	sessionFile: string | null; runCount: number; autoName: boolean; origin: AgentOrigin; history: TaskHistoryEntry[]; sessionKey: string; timer?: ReturnType<typeof setInterval>; activeRun?: ActiveAgentRun;
}
type SavedInstance = { name: string; type: string; goal: string; autoName?: boolean; origin?: AgentOrigin; sessionKey?: string };
type SavedTeam = { instances: SavedInstance[]; root?: string };
type SavedAgentFastOverrides = { overrides?: Record<string, boolean> };
type QueueItem = { id: string; type: string; instance?: string; task: string; approved: boolean; createdAt: number };
type SavedRouting = { autoSpawn?: boolean; limit?: number; queue?: QueueItem[] };
type LegacyTeamMode = { team?: string | null };

const TEAM_TOOLS = ["dispatch_agent", "route_agent", "spawn_agent", "kill_agent", "interrupt_agent", "set_agent_model"];
const DEFAULT_TEAM = "default";
const DEFAULT_AUTO_SPAWN_LIMIT = 3;
const MAX_KEPT_SESSIONS = 20;
const displayName = (name: string) => name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const key = (name: string) => name.toLowerCase();
const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

/** Attach only static menu keys. Never derive a key from agent names, models, teams, tasks, or queue IDs. */
export function annotateAgentCompletion(prefix: string, items: AutocompleteItem[]): AutocompleteItem[] {
	const trailing = /\s$/.test(prefix); const parts = prefix.trim() ? prefix.trim().split(/\s+/) : [];
	const command = parts[0];
	const keyFor = (item: AutocompleteItem): string | undefined => {
		if (!command || parts.length === 1 && !trailing) {
			return new Set(["add", "tell", "interrupt", "clear", "clear-all-sub", "remove", "compact", "compact-all-sub", "promote", "list", "model", "fast", "auto-spawn", "queue", AGENT_VIEW_COMMAND, "grid", "team", "help", "demote", "exit"]).has(item.value)
				? `agents.command.${item.value}` : undefined;
		}
		if (command === "add" && item.value === "add custom") return "agents.add.custom";
		if (command === "fast" && /\s(?:on|off)$/.test(item.value)) return `agents.fast.${item.label}`;
		if (command === "auto-spawn" && /\s(?:on|off|limit)$/.test(item.value)) return `agents.auto-spawn.${item.label}`;
		if (command === "queue" && /\s(?:edit|remove)$/.test(item.value)) return `agents.queue.${item.label}`;
		if (command === "model" && /\sinherit$/.test(item.value)) return "agents.model.inherit";
		if (command === "grid" && /^[1-6]$/.test(item.label)) return `agents.grid.${item.label}`;
		if (command === "team" && /\soff$/.test(item.value)) return "agents.team.off";
		return undefined;
	};
	return items.map(item => {
		const usageKey = keyFor(item);
		return usageKey ? { ...item, usageKey } : item;
	});
}

export default function (pi: ExtensionAPI) {
	const agentStates = new Map<string, AgentState>();
	const agentModelOverrides = new Map<string, string>();
	const agentFastOverrides = new Map<string, boolean>();
	let allAgentDefs: AgentDef[] = []; let teams: Record<string, TeamDef> = {};
	let widgetCtx: any; let sessionDir = ""; let parentSessionId = "";
	let viewedAgent: AgentState | undefined; let rootAgent: AgentState | undefined;
	let agentAutocompleteInstalled = false; let gridCols = 3; let rootStartTime = 0; let hostBusy = false;
	let autoSpawn = false; let autoSpawnLimit = DEFAULT_AUTO_SPAWN_LIMIT; let routingQueue: QueueItem[] = []; let drainingQueue = false;
	let lifecycleGeneration = 0; let bulkCompactionActive = false;
	const pendingDeliveries: AgentState[] = [];
	/** The host's own tools, captured before this extension first narrowed them, so demote can give them back. */
	let hostTools: string[] | undefined; let rootModelRestored = true;

	const stateFor = (name: string) => agentStates.get(key(name));
	const definitionFor = (type: string) => key(type) === "custom" ? CUSTOM_AGENT : allAgentDefs.find(candidate => key(candidate.name) === key(type));
	const predefinedDefs = () => allAgentDefs.filter(def => key(def.name) !== "custom");
	const promotableBaseDefs = () => predefinedDefs().filter(def => ![...agentStates.values()].some(state => key(state.name) === key(def.name) || key(state.def.name) === key(def.name)));
	const stateForPromotion = (name: string) => {
		const named = stateFor(name);
		if (named) return named;
		const matchingType = [...agentStates.values()].filter(state => key(state.def.name) === key(name));
		return matchingType.length === 1 ? matchingType[0] : undefined;
	};
	const parentModel = (ctx: any) => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";
	const effectiveModel = (state: AgentState, ctx: any) => agentModelOverrides.get(key(state.name)) ?? state.def.model ?? parentModel(ctx);
	const hostFastMode = (ctx: any): boolean => {
		const entries = ctx.sessionManager.getEntries() as { type?: string; customType?: string; data?: { enabled?: boolean } }[];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "custom" && entry.customType === "openai-fast") return entry.data?.enabled === true;
		}
		return false;
	};
	const effectiveFast = (state: AgentState, ctx: any) => {
		if (state === rootAgent) return hostFastMode(ctx);
		const fast = agentFastOverrides.get(key(state.name));
		return fast ?? state.def.fast ?? hostFastMode(ctx);
	};
	const modelWindow = (model: string, ctx: any) => {
		const slash = model.indexOf("/"); return slash > 0 ? ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))?.contextWindow ?? 0 : 0;
	};
	const modelSetting = (state: AgentState, ctx: any) => {
		const override = agentModelOverrides.get(key(state.name));
		return override ? `${override} (session override)` : state.def.model ? `${state.def.model} (default)` : `${parentModel(ctx)} (inherited)`;
	};
	function setInstanceModel(state: AgentState, model: string, ctx: any): string {
		if (model === "inherit") agentModelOverrides.delete(key(state.name));
		else {
			const slash = model.indexOf("/");
			if (slash < 1 || !ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) throw new Error(`Unknown model "${model}"`);
			agentModelOverrides.set(key(state.name), model);
		}
		pi.appendEntry("agent-team-model-overrides", { overrides: Object.fromEntries(agentModelOverrides) });
		state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx);
		updateWidget();
		return modelSetting(state, ctx);
	}
	function setInstanceFast(state: AgentState, enabled: boolean) {
		agentFastOverrides.set(key(state.name), enabled);
		pi.appendEntry("agent-team-fast-overrides", { overrides: Object.fromEntries(agentFastOverrides) });
		updateWidget();
	}
	async function setRootModel(state: AgentState, requested: string, ctx: any): Promise<string> {
		const modelName = requested === "inherit" ? state.def.model ?? parentModel(ctx) : requested;
		const slash = modelName.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(modelName.slice(0, slash), modelName.slice(slash + 1)) : undefined;
		if (!model) throw new Error(`Unknown model "${modelName}"`);
		if ((!ctx.model || parentModel(ctx) !== modelName) && !await pi.setModel(model)) throw new Error(`Unable to select ${modelName}`);
		if (requested === "inherit") agentModelOverrides.delete(key(state.name)); else agentModelOverrides.set(key(state.name), requested);
		pi.appendEntry("agent-team-model-overrides", { overrides: Object.fromEntries(agentModelOverrides) });
		state.contextWindow = modelWindow(modelName, ctx); updateWidget();
		return modelSetting(state, ctx);
	}
	const sessionPath = (state: AgentState) => childSessionPath(sessionDir, parentSessionId, state.sessionKey);
	function ensureSession(state: AgentState, cwd: string): string {
		const path = sessionPath(state); const dir = join(sessionDir, parentSessionId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!existsSync(path)) writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd }) + "\n");
		return path;
	}
	function makeState(def: AgentDef, name: string, goal: string, autoName = false, rawSessionKey = name, origin: AgentOrigin = "user"): AgentState {
		// childSessionPath rejects anything outside [A-Za-z0-9_-]; a definition named "code.review"
		// would otherwise throw from session_start and take the whole extension down with it.
		const sessionKey = rawSessionKey.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "agent";
		const provisional = { name, def, sessionKey } as AgentState; const file = sessionPath(provisional);
		// One pass over the transcript; three separate reads here showed up at every session_start.
		const restored = readChildSession(file);
		return { name, def, goal, status: "idle", task: "", toolCount: 0, elapsed: 0, lastWork: "", activity: ActivityLog.parse(restored.activity),
			contextTokens: restored.contextTokens ?? 0, contextWindow: modelWindow(def.model ?? parentModel(widgetCtx), widgetCtx), tokens: restored.tokens,
			sessionFile: existsSync(file) ? file : null, runCount: 0, autoName, origin, history: [], sessionKey };
	}
	function persistTeam() {
		pi.appendEntry("agent-team-instances", { instances: [...agentStates.values()].map(state => ({ name: state.name, type: state.def.name, goal: state.goal, autoName: state.autoName, origin: state.origin, sessionKey: state.sessionKey })), root: rootAgent?.name });
	}
	function addDefaultAgent(def: AgentDef) {
		if ([...agentStates.values()].some(state => key(state.def.name) === key(def.name))) return;
		const name = nextAutoName(def);
		agentStates.set(key(name), makeState(def, name, def.description, true, randomUUID(), "default"));
	}
	function restoreTeam(ctx: any) {
		const entries = ctx.sessionManager.getEntries();
		const snapshot = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-instances").pop();
		const saved = snapshot?.data as SavedTeam | undefined;
		agentStates.clear(); rootAgent = undefined;
		if (snapshot) {
			for (const item of saved?.instances ?? []) {
				const def = definitionFor(item.type);
				// Old snapshots predate ownership; treat them as user-owned, never host-killable.
				const origin: AgentOrigin = item.origin === "host" || item.origin === "default" ? item.origin : "user";
				if (def && /^[a-z0-9_-]+$/i.test(item.name) && !agentStates.has(key(item.name))) agentStates.set(key(item.name), makeState(def, item.name, item.goal || def.description, item.autoName === true, item.sessionKey && /^[a-z0-9_-]+$/i.test(item.sessionKey) ? item.sessionKey : item.name, origin));
			}
			rootAgent = saved?.root ? stateFor(saved.root) : undefined;
			return;
		}
		const legacy = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-mode").pop()?.data as LegacyTeamMode | undefined;
		const team = teams[legacy?.team ?? DEFAULT_TEAM];
		for (const member of team?.members ?? []) {
			const def = definitionFor(member);
			if (def) addDefaultAgent(def);
		}
		if (team?.root) {
			const def = definitionFor(team.root);
			if (def) addDefaultAgent(def);
			rootAgent = def ? [...agentStates.values()].find(state => key(state.def.name) === key(def.name)) : undefined;
		}
		persistTeam();
	}
	function loadAgents(cwd: string) {
		sessionDir = join(getAgentDir(), "agent-team-sessions", encodeCwd(cwd));
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		pruneSessionDirs(sessionDir, MAX_KEPT_SESSIONS); allAgentDefs = scanAgentDirs(cwd, getAgentDir()); teams = scanTeams(cwd, getAgentDir());
	}
	const validLimit = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20 ? value : DEFAULT_AUTO_SPAWN_LIMIT;
	const teamRoutingDefaults = (teamName?: string) => {
		const team = teams[teamName ?? (rootAgent?.def.name === teams[DEFAULT_TEAM]?.root ? DEFAULT_TEAM : "")];
		return { autoSpawn: team?.autoSpawn === true, limit: validLimit(team?.autoSpawnLimit) };
	};
	const persistRouting = () => pi.appendEntry("agent-team-routing", { autoSpawn, limit: autoSpawnLimit, queue: routingQueue });
	function restoreRouting(ctx: any) {
		const saved = (ctx.sessionManager.getEntries() as any[]).filter(entry => entry.type === "custom" && entry.customType === "agent-team-routing").pop()?.data as SavedRouting | undefined;
		const defaults = teamRoutingDefaults();
		autoSpawn = typeof saved?.autoSpawn === "boolean" ? saved.autoSpawn : defaults.autoSpawn;
		autoSpawnLimit = validLimit(saved?.limit ?? defaults.limit);
		routingQueue = (saved?.queue ?? []).filter((item): item is QueueItem => typeof item?.id === "string" && typeof item.type === "string" && typeof item.task === "string" && typeof item.approved === "boolean" && typeof item.createdAt === "number")
			.map(item => ({ ...item, instance: typeof item.instance === "string" ? item.instance : undefined }));
	}
	function applyTeamRoutingDefaults(teamName?: string) {
		const defaults = teamRoutingDefaults(teamName);
		autoSpawn = defaults.autoSpawn;
		autoSpawnLimit = defaults.limit;
		persistRouting();
	}
	/**
	 * Narrow the host's tools to match the current mode, and restore them when there is no mode.
	 * setActiveTools replaces the whole tool list, so with no root and no instances the host must
	 * keep everything it started with — otherwise a plain session is left with dispatch_agent alone.
	 */
	function applyActiveTools() {
		const restricted = rootAgent ? TEAM_TOOLS : agentStates.size ? TEAM_TOOLS : undefined;
		if (restricted) {
			// ??= not .length: a host started with --no-tools has a legitimately empty toolset, and
			// treating that as "not captured yet" would hand it the team tools back on demote.
			hostTools ??= pi.getActiveTools();
			pi.setActiveTools(restricted);
		} else if (hostTools) {
			pi.setActiveTools(hostTools); hostTools = undefined;
		}
	}
	function statusText(): string | undefined {
		if (viewedAgent) return `Viewing: ${viewedAgent === rootAgent ? "ROOT " : ""}${displayName(viewedAgent.name)}${viewedAgent === rootAgent ? "" : " — type to steer, /agents exit to close"}`;
		if (rootAgent) return `Root: ${displayName(rootAgent.name)}${rootModelRestored ? "" : " (model restore failed)"}`;
		if (!agentStates.size) return undefined;
		const running = [...agentStates.values()].filter(state => state.status === "running").length;
		return `Team: ${agentStates.size}${running ? ` · ${running} running` : ""}`;
	}
	const syncStatus = (ctx?: any) => (ctx ?? widgetCtx)?.ui.setStatus("agent-team", statusText());
	async function promote(state: AgentState, ctx: any) {
		await ctx.waitForIdle();
		const current = stateFor(state.name);
		if (rootAgent) throw new Error(`Root is already ${displayName(rootAgent.name)} for this session`);
		if (!current) throw new Error("Instance no longer exists");
		state = current;
		if (state.status === "running" || state.status === "waiting") throw new Error(`Wait for ${displayName(state.name)} to finish before promotion`);
		const modelName = effectiveModel(state, ctx); const slash = modelName.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(modelName.slice(0, slash), modelName.slice(slash + 1)) : undefined;
		if (!model || (parentModel(ctx) !== modelName && !await pi.setModel(model))) throw new Error(`Unable to select ${modelName}`);
		viewedAgent = undefined; rootAgent = state; rootModelRestored = true; applyActiveTools(); persistTeam(); updateWidget();
		syncStatus(ctx);
		ctx.ui.notify(`${displayName(state.name)} is now this session's root. Use /agents demote to step back.`, "info");
	}
	async function demote(ctx: any) {
		await ctx.waitForIdle();
		if (!rootAgent) throw new Error("No instance is promoted for this session");
		if (rootAgent.status === "running") throw new Error(`Wait for ${displayName(rootAgent.name)} to finish before demoting`);
		const previous = rootAgent;
		rootAgent = undefined; rootModelRestored = true; clearInterval(previous.timer); previous.timer = undefined; previous.status = "idle";
		applyActiveTools(); persistTeam(); updateWidget(); syncStatus(ctx);
		ctx.ui.notify(`${displayName(previous.name)} is no longer this session's root; it is a dispatchable instance again.`, "info");
	}
	function nextAutoName(def: AgentDef): string {
		return nextAgentName(def.name, [...agentStates.values()].map(state => state.name));
	}
	async function addAgent(rest: string[], ctx: any, usage: string) {
		let [type, rawName, ...extra] = rest;
		if (!type) {
			const selected = await ctx.ui.select("Add agent", [...predefinedDefs().map(def => def.name), "Custom…"]);
			if (!selected) return;
			type = selected === "Custom…" ? "custom" : selected;
		}
		const def = definitionFor(type); const explicit = rawName !== undefined; const autoName = !explicit && def ? nextAutoName(def) : undefined; const name = explicit ? normalizeName(rawName || "") : autoName || "";
		if (!def || extra.length || explicit && !/^[a-z0-9_-]+$/.test(name)) return void ctx.ui.notify(`Usage: ${usage} <type|custom> [name]`, "error");
		if (agentStates.has(key(name))) return void ctx.ui.notify(`Instance "${name}" already exists`, "error");
		const goal = def === CUSTOM_AGENT ? (await ctx.ui.input("Custom goal", "Goal for this instance"))?.trim() : def.description || `Work as ${displayName(def.name)}`;
		if (!goal) return;
		const state = makeState(def, name, goal, !explicit, randomUUID()); agentStates.set(key(name), state); applyActiveTools(); persistTeam(); updateWidget(); syncStatus(ctx); ctx.ui.notify(`Added ${displayName(name)} (${def.name})`, "info");
	}
	/** Drop a child transcript that is no longer reachable through any instance. */
	function discardSession(state: AgentState) {
		try { rmSync(sessionPath(state), { force: true }); } catch {}
	}
	function clearAgent(state: AgentState) {
		discardSession(state);
		state.sessionFile = null;
		state.contextTokens = 0;
		state.tokens = { input: 0, output: 0 };
		state.activity = new ActivityLog();
		// The delegation catalog reads history: a cleared agent that still advertises completed
		// tasks tells the host it has context it no longer has.
		state.history = [];
		state.runCount = 0;
		state.task = "";
		state.lastWork = "";
		state.toolCount = 0;
		state.elapsed = 0;
		state.status = "idle";
		state.pendingOutcome = undefined;
		updateWidget();
	}
	function removeAgent(state: AgentState, ctx: any) {
		if (state === rootAgent) throw new Error("Cannot remove the promoted root; demote it first");
		if (state.status === "running") throw new Error(`Cannot remove ${displayName(state.name)} while it is running`);
		if (state.status === "waiting") throw new Error(`${displayName(state.name)} is still returning its result; wait for it to land`);
		const wasViewed = viewedAgent === state; const fastKey = key(state.name);
		agentStates.delete(fastKey); agentModelOverrides.delete(fastKey); agentFastOverrides.delete(fastKey); discardSession(state);
		pi.appendEntry("agent-team-model-overrides", { overrides: Object.fromEntries(agentModelOverrides) });
		pi.appendEntry("agent-team-fast-overrides", { overrides: Object.fromEntries(agentFastOverrides) });
		persistTeam();
		if (wasViewed) viewedAgent = undefined;
		applyActiveTools(); updateWidget(); syncStatus(ctx); ctx.ui.notify(`Removed ${displayName(state.name)}`, "info");
	}

	function renderWidget() {
		if (!widgetCtx) return;
		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 0); return { invalidate() { text.invalidate(); }, render(width: number) {
				const renderWidth = Math.max(1, width);
				if (viewedAgent) {
					const fast = viewedAgent === rootAgent
						? hostFastMode(widgetCtx)
						: viewedAgent.activeRun?.fast ?? effectiveFast(viewedAgent, widgetCtx);
					const viewed = { ...viewedAgent, model: effectiveModel(viewedAgent, widgetCtx), fast };
					text.setText(renderDetail(viewed, Math.max(12, renderWidth), theme, {
						model: formatAgentModelLabel(viewed.model, viewed.fast), activity: viewedAgent.activity.list(viewedAgent.lastWork), steerable: viewedAgent !== rootAgent,
					}));
					return text.render(renderWidth);
				}
				if (!agentStates.size) {
					text.setText(renderEmpty(renderWidth, theme));
					return text.render(renderWidth);
				}
				// renderGrid returns one string per line; Text wants a single string.
				const cards = [...agentStates.values()].filter(state => state !== rootAgent).map(state => ({
					...state,
					model: effectiveModel(state, widgetCtx),
					fast: state === rootAgent ? hostFastMode(widgetCtx) : state.activeRun?.fast ?? effectiveFast(state, widgetCtx),
					thinking: state === rootAgent ? widgetCtx.thinkingLevel ?? "off" : state.activeRun?.thinking ?? widgetCtx.thinkingLevel ?? "off",
				}));
				text.setText(renderGrid(cards, renderWidth, gridCols, theme).join("\n"));
				return text.render(renderWidth);
			} };
		});
	}
	/**
	 * Coalesce repaints. Token deltas and per-agent tick timers both call this far faster than a
	 * terminal can usefully redraw, and every call re-registers the widget. Leading edge keeps the
	 * UI responsive, the trailing edge makes sure the last change is never the one that is dropped.
	 */
	let repaintTimer: ReturnType<typeof setTimeout> | undefined;
	let repaintPending = false;
	function updateWidget() {
		if (repaintTimer) { repaintPending = true; return; }
		renderWidget();
		repaintTimer = setTimeout(() => {
			repaintTimer = undefined;
			if (repaintPending) { repaintPending = false; updateWidget(); }
		}, FRAME_MS);
		repaintTimer.unref?.();
	}

	function terminateRun(run: ActiveAgentRun) { run.stopping = true; run.transport.fail(new Error("Agent process stopped")); terminateChild(run.child); }
	function interruptAgent(name: string) {
		const state = stateFor(name);
		if (!state) throw new Error(`Unknown dynamic instance "${name}"`);
		if (state === rootAgent) throw new Error("The root agent cannot be interrupted");
		if (!canInterruptAgent(state.status, false)) throw new Error(`${displayName(state.name)} is ${state.status}; only running agents can be interrupted`);
		const run = state.activeRun;
		if (!run || !interruptAgentRun(state, run, () => clearInterval(state.timer))) throw new Error(`${displayName(state.name)} is not interruptible`);
		updateWidget();
		syncStatus();
		return state;
	}
	function finishRun(state: AgentState, run: ActiveAgentRun, error?: Error) {
		if (run.finished || state.activeRun !== run) return;
		run.finished = true;
		clearInterval(state.timer);
		state.timer = undefined;
		state.elapsed = Date.now() - run.startTime;
		// However the run ended, nothing is still thinking.
		state.activity.closeOpenThoughts();
		const outcome: AgentCompletionStatus = error ? "error" : "done";
		for (const task of run.tasks) state.history = appendTaskHistory(state.history, task, outcome);
		const queuedForDelivery = !run.stopping && run.accepted;
		state.status = resultDeliveryStatus(outcome, queuedForDelivery && (hostBusy || widgetCtx?.isIdle?.() === false));
		state.pendingOutcome = state.status === "waiting" ? outcome : undefined;
		if (state.status === "waiting") pendingDeliveries.push(state);
		state.sessionFile = run.sessionFile;
		const output = run.output.toString();
		state.lastWork = error?.message ?? run.text.lastLine;
		state.activeRun = undefined;
		updateWidget();
		syncStatus();
		if (queuedForDelivery) {
			// OutputBuffer stops at its cap; say so, rather than handing the host a silently
			// clipped answer it will read as complete.
			const truncated = run.output.wasTruncated ? "\n\n(child output truncated)" : "";
			const result = error ? error.message : output ? `${output}${truncated}` : "(no output)";
			pi.sendMessage({ customType: "agent-team-result", content: `Private result from ${state.name} (${state.def.name}) for ${run.initialTask}:\n${result}`, display: false, details: { agent: state.name, status: outcome, elapsed: state.elapsed } }, { deliverAs: "followUp", triggerTurn: true });
			widgetCtx?.ui.notify(`${displayName(state.name)} ${state.status === "waiting" ? `is returning its ${outcome} result` : outcome} in ${Math.round(state.elapsed / 1000)}s`, error ? "error" : "info");
		}
		terminateRun(run);
	}
	function startAgent(state: AgentState, task: string, ctx: any, options: { record?: boolean; maintenance?: boolean } = {}): ActiveAgentRun {
		state.status = "running"; state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); state.toolCount = 0; state.elapsed = 0; state.lastWork = "";
		// Maintenance runs (compaction) must not enter the transcript as a task the agent was given.
		if (options.record === false) state.task = "Compacting";
		else { state.task = task; state.activity = ActivityLog.parse(readChildSession(sessionPath(state)).activity); state.activity.append("user", task); state.runCount++; }
		// Ticks at frame rate so the spinner turns; updateWidget throttles the actual repaints.
		const startTime = Date.now(); clearInterval(state.timer); state.timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateWidget(); }, FRAME_MS);
		state.timer.unref?.();
		const file = ensureSession(state, ctx.cwd);
		// Resolve against the configured agent dir, not a hardcoded ~/.pi, and skip what is not installed
		// so one missing helper extension cannot stop every child from starting.
		const childExtensions = ["openai-codex-fast.ts", "ponytail.ts"]
			.map(name => join(getAgentDir(), "extensions", name)).filter(existsSync)
			.flatMap(path => ["--extension", path]);
		const thinking = ctx.thinkingLevel ?? "off";
		const args = ["--mode", "rpc", "--no-extensions", ...childExtensions, "--model", effectiveModel(state, ctx), "--tools", state.def.tools, "--thinking", thinking, "--append-system-prompt", `${state.def.systemPrompt}\n\n# Assigned goal\n${state.goal}`, "--session", file];
		if (state.sessionFile) args.push("-c");
		const fast = effectiveFast(state, ctx);
		const childEnv = { ...process.env, [OPENAI_FAST_ENV]: fast ? "on" : "off" };
		const child = spawn(process.env.PI_BIN || "pi", args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
		const transport = new AgentRpcTransport((line, callback) => child.stdin.write(line, callback));
		const run: ActiveAgentRun = { child, transport, text: new TextTail(), stderrChunks: [], initialTask: task, tasks: task ? [task] : [], sessionFile: file, startTime, runId: randomUUID(), usageSequence: 0, accepted: false, finished: false, stopping: false, maintenance: options.maintenance === true, output: new OutputBuffer(), toolStarts: new Map(), fast, thinking }; state.activeRun = run; updateWidget();
		let buffer = ""; const appendActivity = (kind: ActivityKind, value: unknown) => state.activity.append(kind, value);
		const persistUsage = (kind: string, message: any, usage: any) => { if (!usage || typeof usage !== "object") return; state.tokens = addTokenCounts(state.tokens, tokenCountsFromUsage(usage)); pi.appendEntry("agent-team-usage", { sourceEventId: `${run.runId}:${kind}:${++run.usageSequence}`, usage, provider: message?.provider, model: message?.model }); pi.events.emit("agent-team:usage", { agent: state.name }); updateWidget(); };
		const toolSummary = (event: any) => formatToolActivity(event.toolName, event.args ?? event.input ?? event.parameters);
		const toolError = (event: any) => event.error ?? event.result?.error ?? (event.isError ? event.result ?? "tool failed" : undefined);

		const onTextDelta = (event: any) => {
			const delta = event.assistantMessageEvent.delta || "";
			if (!delta) return;
			run.output.append(delta);
			run.text.append(delta);
			state.lastWork = run.text.lastLine;
			appendActivity("assistant", delta);
		};
		const onThinkingStart = () => state.activity.startThought();
		const onThinkingDelta = (event: any) => state.activity.appendThought(event.assistantMessageEvent.delta);
		const onThinkingEnd = (event: any) => state.activity.finishThought(event.assistantMessageEvent.content);
		const onToolStart = (event: any) => {
			state.toolCount++;
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
			const summary = toolSummary(event);
			if (toolCallId) {
				run.toolStarts.set(toolCallId, { summary, startTime: Date.now() });
				state.activity.startTool(toolCallId, summary);
			} else appendActivity("tool-start", summary);
		};
		const onToolEnd = (event: any) => {
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
			const started = toolCallId ? run.toolStarts.get(toolCallId) : undefined;
			// Drop the pending entry: a long run makes thousands of calls and none are needed twice.
			if (toolCallId) run.toolStarts.delete(toolCallId);
			const elapsed = started ? ` · ${Math.max(0, Math.round((Date.now() - started.startTime) / 1000))}s` : "";
			const error = toolError(event);
			const summary = started?.summary ?? toolSummary(event);
			state.activity.finishTool(toolCallId, error ? "tool-error" : "tool-done", `${summary}${elapsed}${error ? ` — ${String(error).slice(0, 96)}` : ""}`);
		};
		const onMessageEnd = (event: any) => {
			// A child that answers without streaming still has its text on the final message.
			if (event.message?.role === "assistant" && run.output.isEmpty) {
				const content = event.message.content;
				const finalText = typeof content === "string" ? content
					: content?.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") ?? "";
				if (finalText) { run.output.append(finalText); appendActivity("assistant", finalText); }
			}
			const tokens = contextTokensFromUsage(event.message?.usage);
			if (tokens !== undefined) state.contextTokens = tokens;
			persistUsage("message", event.message, event.message?.usage);
		};

		const handle = (event: any) => {
			if (transport.handle(event)) return;
			if (shouldIgnoreAgentRunEvent(run.finished, run.stopping)) return;
			switch (event.type) {
				case "message_update": {
					const type = event.assistantMessageEvent?.type;
					if (type === "text_delta") onTextDelta(event);
					else if (type === "thinking_start") onThinkingStart();
					else if (type === "thinking_delta") onThinkingDelta(event);
					else if (type === "thinking_end") onThinkingEnd(event);
					else return;
					break;
				}
				case "tool_execution_start": onToolStart(event); break;
				case "tool_execution_end": onToolEnd(event); break;
				case "message_end": onMessageEnd(event); break;
				case "compaction_end":
					persistUsage("compaction", event.result, event.result?.usage);
					return;
				default:
					if (shouldFinalizeAgentEvent(event.type)) finishRun(state, run);
					return;
			}
			updateWidget();
		};
		let reportedHandlerError = false;
		const line = (value: string) => {
			if (!value.trim()) return;
			let event: unknown;
			// Split deliberately: a partial line from the child is expected and ignorable, but a throw
			// out of handle() is our own bug. Swallowing both is how a missing import silently disabled
			// token accounting for three commits without a single visible symptom.
			try { event = JSON.parse(value.endsWith("\r") ? value.slice(0, -1) : value); } catch { return; }
			try {
				handle(event);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				state.activity.append("tool-error", `agent-team handler: ${detail}`);
				if (!reportedHandlerError) {
					reportedHandlerError = true;
					widgetCtx?.ui.notify(`${displayName(state.name)}: internal handler error — ${detail}`, "error");
				}
				updateWidget();
			}
		};
		child.stdout.setEncoding("utf-8"); child.stdout.on("data", (chunk: string) => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); } });
		// Keep the tail of stderr: without it a child that dies on startup (no pi on PATH, bad model,
		// a helper extension that throws) is indistinguishable from any other "exited with code 1".
		child.stderr.setEncoding("utf-8"); child.stderr.on("data", (chunk: string) => { run.stderrChunks.push(chunk); if (run.stderrChunks.length > 50) run.stderrChunks.splice(0, run.stderrChunks.length - 50); });
		const withStderr = (message: string) => { const detail = run.stderrChunks.join("").replace(/\s+/g, " ").trim().slice(-400); return detail ? `${message}: ${detail}` : message; };
		child.stdin.on("error", error => transport.fail(error)); child.on("error", error => { transport.fail(error); if (!run.stopping) finishRun(state, run, new Error(withStderr(`Agent process error: ${error.message}`))); }); child.on("close", code => { line(buffer); transport.fail(new Error(withStderr(`Agent process exited with code ${code ?? 1}`))); if (!run.finished && !run.stopping) finishRun(state, run, new Error(withStderr(`Agent process exited before settling (code ${code ?? 1})`))); });
		return run;
	}
	async function submitAgent(name: string, task: string, ctx: any) {
		const state = stateFor(name); if (!state) throw new Error(`Unknown dynamic instance "${name}"`); if (rootAgent === state) throw new Error("The root agent cannot dispatch itself");
		if (state.status === "waiting") throw new Error(`${displayName(state.name)} is waiting to return its result`);
		if (state.status === "running") {
			const run = state.activeRun;
			if (!run || run.finished || run.stopping) throw new Error(`${displayName(state.name)} cannot be steered`);
			if (!canSteerAgent(state.status, run.maintenance)) throw new Error(`${displayName(state.name)} is compacting`);
			await run.transport.request({ type: "prompt", message: task, streamingBehavior: "steer" });
			// Record it only once the child has accepted it. Without this the detail view — whose whole
			// purpose is steering — shows no trace of what you just typed, and the card keeps advertising
			// the original task. It also stops the reply before and after the steer merging into one entry.
			run.tasks.push(task); state.activity.append("user", task); state.task = task; updateWidget();
			return { status: "steered" as const };
		}
		const run = startAgent(state, task, ctx); try { await run.transport.request({ type: "prompt", message: task }); run.accepted = true; return { status: "running" as const }; } catch (error) { const failure = new Error(`Unable to start ${displayName(state.name)}: ${error instanceof Error ? error.message : String(error)}`); finishRun(state, run, failure); throw failure; }
	}
	const predefinedDefinition = (type: string) => predefinedDefs().find(def => key(def.name) === key(type));
	const hostAgentCount = () => [...agentStates.values()].filter(state => state.origin === "host").length;
	const routingCandidates = () => [...agentStates.values()].filter(state => state !== rootAgent).map(state => ({ ...state, base: state.def.name }));
	function enqueueRoutingTask(item: Omit<QueueItem, "id" | "createdAt">, ctx: any) {
		const queued: QueueItem = { ...item, id: randomUUID(), createdAt: Date.now() };
		routingQueue.push(queued); persistRouting();
		ctx.ui.notify(`${displayName(item.type)} task queued (${routingQueue.length} waiting)`, "info");
		return queued;
	}
	async function spawnHostAgent(type: string, task: string, approved: boolean, ctx: any) {
		const def = predefinedDefinition(type);
		if (!def) throw new Error(`Unknown predefined agent type "${type}"`);
		if (key(def.name) === "iterate" && !approved) throw new Error("Iterate tasks require explicit user approval before dispatch or queueing");
		if (!autoSpawn) throw new Error("Auto-spawn is off; enable it with /agents auto-spawn on");
		if (hostAgentCount() >= autoSpawnLimit) throw new Error(`Auto-spawn limit (${autoSpawnLimit}) reached`);
		// Shared auto-naming defines the base-1/base-2 policy; host spawning never supplies names.
		const generated = nextAutoName(def);
		const state = makeState(def, generated, def.description || `Work as ${displayName(def.name)}`, true, randomUUID(), "host");
		agentStates.set(key(state.name), state); persistTeam(); applyActiveTools(); updateWidget(); syncStatus(ctx);
		await submitAgent(state.name, task, ctx);
		return state;
	}
	async function routeTask(type: string, task: string, relation: "related" | "new", approved: boolean, ctx: any, preferredInstance?: string, queueOnFailure = true) {
		const def = predefinedDefinition(type);
		if (!def) throw new Error(`Unknown predefined agent type "${type}"`);
		if (key(def.name) === "iterate" && !approved) throw new Error("Iterate tasks require explicit user approval before dispatch or queueing");
		const decision = decideRouting(routingCandidates(), def.name, relation, preferredInstance, autoSpawn, hostAgentCount(), autoSpawnLimit);
		if (decision.action === "related-unavailable") throw new Error("A related follow-up requires the named running specialist");
		if (decision.action === "steer" || decision.action === "reuse") { const state = stateFor(decision.agent)!; return { status: (await submitAgent(state.name, task, ctx)).status, state }; }
		if (decision.action === "spawn") return { status: "spawned" as const, state: await spawnHostAgent(def.name, task, approved, ctx) };
		if (!queueOnFailure) return undefined;
		return { status: "queued" as const, queue: enqueueRoutingTask({ type: def.name, instance: preferredInstance, task, approved }, ctx) };
	}
	async function drainRoutingQueue(ctx: any) {
		if (drainingQueue || !ctx.isIdle()) return;
		drainingQueue = true;
		try {
			// Snapshot the ids: routeTask awaits, and /agents queue edit|remove reassigns
			// routingQueue while it does, so an index captured before the await can point at a
			// different task by the time it is removed.
			for (const id of routingQueue.map(item => item.id)) {
				const item = routingQueue.find(candidate => candidate.id === id);
				if (!item) continue;
				try {
					const routed = await routeTask(item.type, item.task, "new", item.approved, ctx, item.instance, false);
					if (!routed) continue;
					routingQueue = removeQueuedItem(routingQueue, id) ?? routingQueue; persistRouting();
					ctx.ui.notify(`${displayName(item.type)} queued task started`, "info");
					return;
				} catch (error) {
					ctx.ui.notify(`Queued ${displayName(item.type)} task retained: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			}
		} finally { drainingQueue = false; }
	}
	function killHostAgent(name: string, ctx: any) {
		const state = stateFor(name);
		if (!state) throw new Error(`Unknown dynamic instance "${name}"`);
		if (!canKillHostAgent(state)) throw new Error("Only idle host-spawned agents can be killed");
		removeAgent(state, ctx);
		return state;
	}
	async function compactAgent(name: string, ctx: any) {
		const state = stateFor(name);
		if (!state) throw new Error(`Unknown dynamic instance "${name}"`);
		if (state === rootAgent) throw new Error("Use /compact for the promoted root");
		if (state.status === "running" || state.status === "waiting") throw new Error(`${displayName(state.name)} is ${state.status}; wait for it to finish before compacting`);
		// Without -c the child would open a blank session and compact nothing, while still
		// leaving the instance looking as though it had a transcript.
		if (!state.sessionFile) throw new Error(`${displayName(state.name)} has not run yet; there is nothing to compact`);
		const run = startAgent(state, "", ctx, { record: false, maintenance: true });
		try {
			await run.transport.request({ type: "compact" });
			finishRun(state, run);
			// One pass, and it refreshes the token totals too — compaction rewrites those, and
			// reading only activity + contextTokens left the card showing pre-compaction counts.
			const compacted = readChildSession(run.sessionFile);
			state.activity = ActivityLog.parse(compacted.activity);
			state.contextTokens = compacted.contextTokens ?? 0;
			state.tokens = compacted.tokens;
			updateWidget();
			ctx.ui.notify(`${displayName(state.name)} compacted`, "info");
		} catch (error) {
			const failure = new Error(`Unable to compact ${displayName(state.name)}: ${error instanceof Error ? error.message : String(error)}`);
			finishRun(state, run, failure);
			throw failure;
		}
	}
	const subagents = () => [...agentStates.values()].filter(state => state !== rootAgent);
	function compactAllSubagents(ctx: any) {
		if (bulkCompactionActive) return void ctx.ui.notify("Bulk subagent compaction is already running", "warning");
		const skipped: string[] = []; const candidates = subagents().filter(state => {
			if (canCompactAgent(state.status, false, !!state.sessionFile)) return true;
			skipped.push(state.name); return false;
		});
		if (!candidates.length) return void ctx.ui.notify(`No eligible subagents to compact\nskipped: ${skipped.join(", ") || "none"}`, "info");
		const generation = lifecycleGeneration;
		bulkCompactionActive = true;
		ctx.ui.notify(`Compacting ${candidates.map(state => state.name).join(", ")} in background`, "info");
		void runConcurrent(candidates.map(state => async () => {
			await compactAgent(state.name, ctx);
			return state.name;
		})).then(results => {
			if (generation !== lifecycleGeneration) return;
			const compacted = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
			const failed = results.flatMap((result, index) => result.status === "rejected" ? [candidates[index]!.name] : []);
			for (const name of failed) ctx.ui.notify(`${displayName(name)} compaction failed`, "error");
			ctx.ui.notify([`compacted: ${compacted.join(", ") || "none"}`, `skipped: ${skipped.join(", ") || "none"}`, `failed: ${failed.join(", ") || "none"}`].join("\n"), failed.length ? "warning" : "info");
		}).catch(error => {
			if (generation === lifecycleGeneration) ctx.ui.notify(`Bulk compaction: ${String(error)}`, "error");
		}).finally(() => {
			if (generation === lifecycleGeneration) bulkCompactionActive = false;
		});
	}
	async function clearAllSubagents(ctx: any) {
		const candidates = subagents().filter(state => canClearAgent(state.status, false));
		if (!candidates.length) return void ctx.ui.notify("No settled subagents to clear", "info");
		if (!await ctx.ui.confirm("Clear all subagents?", `Delete saved child conversations for ${candidates.map(state => state.name).join(", ")}. Instances remain, but cleared conversations cannot be recovered.`)) return;
		const cleared: string[] = []; const skipped: string[] = [];
		for (const state of candidates) {
			if (stateFor(state.name) !== state || !canClearAgent(state.status, false)) { skipped.push(state.name); continue; }
			clearAgent(state); cleared.push(state.name);
		}
		ctx.ui.notify([`cleared: ${cleared.join(", ") || "none"}`, `skipped: ${skipped.join(", ") || "none"}`].join("\n"), "info");
	}

	pi.registerTool({ name: "dispatch_agent", label: "Dispatch Agent", description: "Dispatch or steer a named dynamic team instance. Results return privately for one host response.", parameters: Type.Object({ agent: Type.String({ description: "Unique dynamic instance name" }), task: Type.String({ description: "Focused task" }) }),
		async execute(_id, params, _signal, _update, ctx) { const { agent, task } = params as { agent: string; task: string }; const submitted = await submitAgent(agent, task, ctx); return { content: [{ type: "text", text: `${displayName(agent)} ${submitted.status === "steered" ? "steering accepted" : "is working in the background"}.` }], details: { agent, status: submitted.status } }; },
		renderCall(args, theme) { const task = (args as any).task || ""; return new Text(theme.fg("toolTitle", theme.bold("dispatch_agent ")) + theme.fg("accent", (args as any).agent || "?") + theme.fg("dim", ` — ${task.slice(0, 60)}`), 0, 0); },
		renderResult(result, _options, theme) { const details = result.details as any; return new Text(theme.fg("accent", `● ${details?.agent || "agent"}`) + theme.fg("dim", details?.status === "steered" ? " steering accepted" : " working..."), 0, 0); },
	});
	pi.registerTool({ name: "route_agent", label: "Route Agent", description: "Route a task to a predefined specialist. relation=related steers only the named running instance; relation=new never steers busy work and may reuse, spawn, or queue.", parameters: Type.Object({ type: Type.String({ description: "Predefined base agent type; custom is not allowed" }), task: Type.String({ description: "Focused task" }), relation: Type.String({ description: "related or new" }), approved: Type.Boolean({ description: "True only after explicit user approval for Iterate work" }), preferredInstance: Type.Optional(Type.String({ description: "Relevant instance; required for related follow-ups" })) }),
		async execute(_id, params, _signal, _update, ctx) { const input = params as { type: string; task: string; relation: "related" | "new"; approved: boolean; preferredInstance?: string }; if (input.relation !== "related" && input.relation !== "new") throw new Error("relation must be related or new"); const routed = await routeTask(input.type, input.task, input.relation, input.approved, ctx, input.preferredInstance); const agent = (routed as any).state?.name; return { content: [{ type: "text", text: routed.status === "queued" ? `${displayName(input.type)} task queued.` : `${displayName(agent)} ${routed.status}.` }], details: routed.status === "queued" ? { status: routed.status, queueId: (routed as any).queue.id } : { status: routed.status, agent } }; },
	});
	pi.registerTool({ name: "spawn_agent", label: "Spawn Agent", description: "Spawn a host-owned predefined specialist when auto-spawn is enabled. Never accepts custom types or prompts.", parameters: Type.Object({ type: Type.String(), task: Type.String(), approved: Type.Boolean({ description: "True only after explicit user approval for Iterate work" }) }), async execute(_id, params, _signal, _update, ctx) { const input = params as { type: string; task: string; approved: boolean }; const state = await spawnHostAgent(input.type, input.task, input.approved, ctx); return { content: [{ type: "text", text: `${displayName(state.name)} spawned.` }], details: { agent: state.name } }; } });
	pi.registerTool({ name: "kill_agent", label: "Kill Agent", description: "Remove an idle host-spawned child. Default and user-created agents cannot be killed.", parameters: Type.Object({ agent: Type.String() }), async execute(_id, params, _signal, _update, ctx) { const state = killHostAgent((params as { agent: string }).agent, ctx); return { content: [{ type: "text", text: `${displayName(state.name)} removed.` }], details: { agent: state.name } }; } });
	pi.registerTool({ name: "interrupt_agent", label: "Interrupt Agent", description: "Immediately terminate a running child agent without sending it a prompt.", parameters: Type.Object({ agent: Type.String({ description: "Running child instance name" }) }), async execute(_id, params) { const state = interruptAgent((params as { agent: string }).agent); return { content: [{ type: "text", text: `${displayName(state.name)} interrupted.` }], details: { agent: state.name, status: state.status } }; } });
	pi.registerTool({ name: "set_agent_model", label: "Set Agent Model", description: "Set a session model for a named dynamic instance.", parameters: Type.Object({ agent: Type.String(), model: Type.String() }), async execute(_id, params, _signal, _update, ctx) { const { agent, model } = params as { agent: string; model: string }; const state = stateFor(agent); if (!state) throw new Error(`Unknown dynamic instance "${agent}"`); if (state === rootAgent) throw new Error("Change the root model with /agents model <name> <model|inherit> when the host is idle"); return { content: [{ type: "text", text: `${state.name}: ${setInstanceModel(state, model, ctx)}` }], details: { agent: state.name } }; } });

	const usage = "Usage: /agents add <type|custom> [name] | tell <subagent-name> <message...> | interrupt <agent> | clear <subagent-name> | clear-all-sub | remove <name> | compact <name> | compact-all-sub | promote <instance|base> | demote | list | model <name> [model|inherit] | fast <name> [on|off] | auto-spawn <on|off|limit N> | queue [edit <id> <task|target> ...|remove <id>] | view <name> | exit | grid <1-6> | team <team-name|off>";
	const listInstances = (ctx: any) => ctx.ui.notify([...agentStates.values()].map(state => `${state === rootAgent ? "ROOT " : ""}${state.name} (${state.def.name}) — ${state.status}; goal: ${state.goal}`).join("\n") || "No instances", "info");
	const availableModels = () => (widgetCtx?.modelRegistry?.getAvailable?.() ?? []).map((model: any) => `${model.provider}/${model.id}`);
	/**
	 * The instance list a replacement session should start from. It has to match what
	 * activateTeam/addDefaultAgent would build in place — same auto-suffixed names, same
	 * default ownership, a fresh session key each — or switching teams by forking produces a
	 * differently named, differently owned team than switching teams in place.
	 */
	const teamSnapshot = (teamName: string | undefined): SavedTeam => {
		const team = teamName ? teams[teamName] : undefined;
		const instances: SavedInstance[] = [];
		const addSnapshotInstance = (member: string): SavedInstance | undefined => {
			const def = definitionFor(member);
			if (!def) return undefined;
			const existing = instances.find(instance => key(instance.type) === key(def.name));
			if (existing) return existing;
			const instance: SavedInstance = {
				name: nextAgentName(def.name, instances.map(candidate => candidate.name)),
				type: def.name, goal: def.description, autoName: true, origin: "default", sessionKey: randomUUID(),
			};
			instances.push(instance);
			return instance;
		};
		for (const member of team?.members ?? []) addSnapshotInstance(member);
		const root = team?.root ? addSnapshotInstance(team.root) : undefined;
		return { instances, root: root?.name };
	};
	async function activateTeam(teamName: string | undefined, ctx: any) {
		for (const state of agentStates.values()) { if (state.activeRun) terminateRun(state.activeRun); clearInterval(state.timer); state.timer = undefined; discardSession(state); }
		agentStates.clear(); agentModelOverrides.clear(); agentFastOverrides.clear(); rootAgent = undefined; viewedAgent = undefined; rootModelRestored = true;
		// The queue matches deliveries to instances by position; dropped instances must drop with them.
		pendingDeliveries.length = 0;
		const team = teamName ? teams[teamName] : undefined;
		for (const member of team?.members ?? []) {
			const def = definitionFor(member);
			if (def) addDefaultAgent(def);
		}
		pi.appendEntry("agent-team-model-overrides", { overrides: {} });
		pi.appendEntry("agent-team-fast-overrides", { overrides: {} });
		persistTeam(); applyTeamRoutingDefaults(teamName); applyActiveTools();
		if (team?.root) {
			const def = definitionFor(team.root);
			if (def) addDefaultAgent(def);
			const root = def ? [...agentStates.values()].find(state => key(state.def.name) === key(def.name)) : undefined;
			if (root) await promote(root, ctx);
		}
		updateWidget(); syncStatus(ctx);
	}
	const getAgentArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
		const trailing = /\s$/.test(prefix); const parts = prefix.trim() ? prefix.trim().split(/\s+/) : [];
		const command = parts[0]; const current = trailing ? "" : parts.at(-1) ?? "";
		const values = (choices: string[], base = "") => {
			const matches = choices.filter(value => value.toLowerCase().startsWith(current.toLowerCase())).map(value => ({ value: `${base}${value}`, label: value }));
			return matches.length ? matches : null;
		};
		if (!command || parts.length === 1 && !trailing) return values(["add", "tell", "interrupt", "clear", "clear-all-sub", "remove", "compact", "compact-all-sub", "promote", "list", "model", "fast", "auto-spawn", "queue", AGENT_VIEW_COMMAND, "grid", "team", "help", ...(rootAgent ? ["demote"] : []), ...(viewedAgent ? ["exit"] : [])]);
		if (command === "add" && (parts.length === 1 || parts.length === 2 && !trailing)) return values([...predefinedDefs().map(def => def.name), "custom"], "add ")?.map(item => item.label === "custom" ? { ...item, label: "Custom…" } : item) ?? null;
		if (command === "tell" && shouldCompleteTellTarget(parts, trailing)) return values([...agentStates.values()].filter(state => state !== rootAgent && state.status !== "waiting").map(state => state.name), "tell ");
		if (command === "interrupt" && (parts.length === 1 && trailing || parts.length === 2 && !trailing)) return values([...agentStates.values()].filter(state => canInterruptAgent(state.status, state === rootAgent)).map(state => state.name), "interrupt ");
		if (command === "clear" && (parts.length === 1 && trailing || parts.length === 2 && !trailing)) return values([...agentStates.values()].filter(state => canClearAgent(state.status, state === rootAgent)).map(state => state.name), "clear ");
		if (command === "fast" && (parts.length === 1 || parts.length === 2 && !trailing)) {
			return values([...agentStates.values()].filter(state => state !== rootAgent && state.status !== "running" && state.status !== "waiting").map(state => state.name), "fast ");
		}
		if (command === "fast" && parts.length === 2 && trailing || command === "fast" && parts.length === 3 && !trailing) return values(["on", "off"], `fast ${parts[1]} `);
		if (command === "auto-spawn" && (parts.length === 1 || parts.length === 2 && !trailing)) return values(["on", "off", "limit"], "auto-spawn ");
		if (command === "queue" && (parts.length === 1 || parts.length === 2 && !trailing)) return values(["edit", "remove"], "queue ");
		if (command === "remove" && (parts.length === 1 || parts.length === 2 && !trailing)) return values([...agentStates.values()].filter(state => state !== rootAgent && state.status !== "running").map(state => state.name), "remove ");
		if (command === "compact" && (parts.length === 1 || parts.length === 2 && !trailing)) return values([...agentStates.values()].filter(state => state !== rootAgent).map(state => state.name), "compact ");
		if (command === "promote" && (parts.length === 1 || parts.length === 2 && !trailing)) {
			const matches = (value: string) => value.toLowerCase().startsWith(current.toLowerCase());
			const instances = [...agentStates.values()].filter(state => state !== rootAgent && state.status !== "running" && matches(state.name))
				.map(state => ({ value: `promote ${state.name}`, label: state.name }));
			const bases = promotableBaseDefs().filter(def => matches(def.name))
				.map(def => ({ value: `promote ${def.name}`, label: `${def.name} (base variant)` }));
			const choices = [...instances, ...bases];
			return choices.length ? choices : null;
		}
		if (isAgentViewCommand(command) && (parts.length === 1 || parts.length === 2 && !trailing)) return values([...agentStates.values()].map(state => state.name), `${AGENT_VIEW_COMMAND} `);
		if (command === "model" && (parts.length === 1 || parts.length === 2 && !trailing)) return values([...agentStates.values()].map(state => state.name), "model ");
		if (command === "model" && parts.length === 2 && trailing || command === "model" && parts.length === 3 && !trailing) return values(["inherit", ...availableModels()], `model ${parts[1]} `);
		if (command === "grid" && (parts.length === 1 || parts.length === 2 && !trailing)) return values(["1", "2", "3", "4", "5", "6"], "grid ");
		if (command === "team" && (parts.length === 1 || parts.length === 2 && !trailing)) return values(["off", ...Object.keys(teams)], "team ");
		return null;
	};
	pi.registerCommand("agents", {
		description: "Manage dynamic team instances",
		getArgumentCompletions: getAgentArgumentCompletions,
		async handler(args, ctx) {
			widgetCtx = ctx; const [command, ...rest] = args.trim().split(/\s+/); const name = rest.join(" ");
			const fail = (error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			if (command === "help") return void ctx.ui.notify(usage, "info");
			// Bare /agents answers the question you actually have: what is on the team right now.
			if (!command || command === "list" && !rest.length) return listInstances(ctx);
			if (command === "grid") { const value = rest[0] || ""; if (!/^[1-6]$/.test(value) || rest.length !== 1) return void ctx.ui.notify("Usage: /agents grid <1-6>", "error"); gridCols = Number(value); updateWidget(); return; }
			if (command === "add") { try { await addAgent(rest, ctx, "/agents add"); } catch (error) { fail(error); } return; }
			if (command === "tell") {
				const tell = parseTellArguments(args.trim().slice(command.length));
				if (!tell) return void ctx.ui.notify("Usage: /agents tell <subagent-name> <message...>", "error");
				const state = stateFor(tell.agent);
				if (!state) return void ctx.ui.notify(`Unknown subagent "${tell.agent}". Usage: /agents tell <subagent-name> <message...>`, "error");
				if (state === rootAgent) return void ctx.ui.notify("Cannot tell the promoted root agent.", "error");
				try {
					const submitted = await submitAgent(state.name, tell.message, ctx);
					ctx.ui.notify(`${displayName(state.name)} ${submitted.status === "steered" ? "steering accepted" : "started"}`, "info");
				} catch (error) { fail(error); }
				return;
			}
			if (command === "interrupt") {
				if (rest.length !== 1) return void ctx.ui.notify("Usage: /agents interrupt <agent>", "error");
				try { const state = interruptAgent(rest[0]); ctx.ui.notify(`${displayName(state.name)} interrupted`, "info"); } catch (error) { fail(error); }
				return;
			}
			if (command === "clear") {
				const state = stateFor(name);
				if (!name || !state) return void ctx.ui.notify("Usage: /agents clear <subagent-name>", "error");
				if (state === rootAgent) return void ctx.ui.notify("Cannot clear the promoted root agent.", "error");
				if (!canClearAgent(state.status, false)) return void ctx.ui.notify(`${displayName(state.name)} is ${state.status}; wait before clearing it.`, "error");
				clearAgent(state);
				ctx.ui.notify(`${displayName(state.name)} cleared`, "info");
				return;
			}
			if (command === "clear-all-sub") { if (rest.length) return void ctx.ui.notify("Usage: /agents clear-all-sub", "error"); try { await clearAllSubagents(ctx); } catch (error) { fail(error); } return; }
			if (command === "remove") { const state = stateFor(name); if (!state) return void ctx.ui.notify(`Unknown instance "${name}". Usage: /agents remove <name>`, "error"); try { removeAgent(state, ctx); } catch (error) { fail(error); } return; }
			if (command === "compact") { if (!name) return void ctx.ui.notify("Usage: /agents compact <name>", "error"); try { await compactAgent(name, ctx); } catch (error) { fail(error); } return; }
			if (command === "compact-all-sub") { if (rest.length) return void ctx.ui.notify("Usage: /agents compact-all-sub", "error"); try { compactAllSubagents(ctx); } catch (error) { fail(error); } return; }
			if (command === "promote") {
				let state = stateForPromotion(name); let created = false;
				if (!state) {
					const def = promotableBaseDefs().find(candidate => key(candidate.name) === key(name));
					if (!def) return void ctx.ui.notify("Usage: /agents promote <instance|base>", "error");
					state = makeState(def, nextAutoName(def), def.description || `Work as ${displayName(def.name)}`, true, randomUUID());
					agentStates.set(key(state.name), state); created = true;
				}
				if (state === rootAgent) return void ctx.ui.notify("Usage: /agents promote <instance|base>", "error");
				try { await promote(state, ctx); } catch (error) { if (created) agentStates.delete(key(state.name)); fail(error); }
				return;
			}
			if (command === "demote") { if (rest.length) return void ctx.ui.notify("Usage: /agents demote", "error"); try { await demote(ctx); } catch (error) { fail(error); } return; }
			if (command === "auto-spawn") {
				const [mode, value] = rest;
				if (mode === "on" && rest.length === 1) autoSpawn = true;
				else if (mode === "off" && rest.length === 1) autoSpawn = false;
				else if (mode === "limit" && rest.length === 2 && /^\d+$/.test(value || "") && Number(value) >= 1 && Number(value) <= 20) autoSpawnLimit = Number(value);
				else return void ctx.ui.notify("Usage: /agents auto-spawn <on|off|limit N>", "error");
				persistRouting(); ctx.ui.notify(`Auto-spawn ${autoSpawn ? "on" : "off"}; limit ${autoSpawnLimit}`, "info"); return;
			}
			if (command === "queue") {
				const [action, id, field, ...value] = rest;
				if (!action) return void ctx.ui.notify(routingQueue.map(item => `${item.id} · ${item.type}${item.instance ? `/${item.instance}` : ""} · ${item.approved ? "approved" : "unapproved"} · ${item.task}`).join("\n") || "Queue is empty", "info");
				const item = routingQueue.find(candidate => candidate.id === id);
				if (action === "remove" && item && rest.length === 2) { routingQueue = removeQueuedItem(routingQueue, item.id)!; persistRouting(); ctx.ui.notify("Queued task removed", "info"); return; }
				if (action === "edit" && item && field === "task" && value.length) { routingQueue = updateQueuedItem(routingQueue, item.id, candidate => ({ ...candidate, task: value.join(" ") }))!; persistRouting(); ctx.ui.notify("Queued task updated", "info"); return; }
				if (action === "edit" && item && field === "target" && value.length <= 2) { const def = predefinedDefinition(value[0] || ""); if (!def) return void ctx.ui.notify("Queue target must be a predefined base type", "error"); routingQueue = updateQueuedItem(routingQueue, item.id, candidate => ({ ...candidate, type: def.name, instance: value[1] }))!; persistRouting(); ctx.ui.notify("Queued target updated", "info"); return; }
				return void ctx.ui.notify("Usage: /agents queue [edit <id> task <text>|edit <id> target <type> [instance]|remove <id>]", "error");
			}
			if (command === "fast") {
				if (rest.length > 2) return void ctx.ui.notify("Usage: /agents fast <name> [on|off]", "error");
				const [instance, rawMode] = rest; const state = stateFor(instance || "");
				if (!instance || !state) return void ctx.ui.notify("Usage: /agents fast <name> [on|off]", "error");
				if (state === rootAgent) return void ctx.ui.notify("Fast mode for promoted root is controlled by /fast in this session.", "warning");
				if (state.status === "running" || state.status === "waiting") return void ctx.ui.notify(`Wait for ${displayName(state.name)} to finish before changing fast mode.`, "error");
				const mode = rawMode?.toLowerCase();
				if (mode && mode !== "on" && mode !== "off") return void ctx.ui.notify("Usage: /agents fast <name> [on|off]", "error");
				const enabled = mode ? mode === "on" : !effectiveFast(state, ctx);
				setInstanceFast(state, enabled);
				ctx.ui.notify(`${displayName(state.name)} fast mode ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (command === "model") {
				const [instance, model] = rest; const state = stateFor(instance || "");
				if (!instance) return listInstances(ctx);
				if (!state || rest.length > 2) return void ctx.ui.notify("Usage: /agents model <name> [model|inherit]", "error");
				let requested = model;
				if (!requested) { requested = await ctx.ui.select(`Model for ${state.name} (${modelSetting(state, ctx)})`, ["inherit", ...availableModels()]); if (!requested) return; }
				try { let target = state; if (target === rootAgent) { await ctx.waitForIdle(); target = stateFor(instance)!; if (target !== rootAgent) throw new Error("Root changed while waiting for host idle"); ctx.ui.notify(`ROOT ${target.name}: ${await setRootModel(target, requested, ctx)}`, "info"); } else ctx.ui.notify(`${target.name}: ${setInstanceModel(target, requested, ctx)}`, "info"); } catch (error) { fail(error); }
				return;
			}
			if (isAgentViewCommand(command)) { const state = stateFor(name); if (!state) return void ctx.ui.notify(`Usage: /agents ${AGENT_VIEW_COMMAND} <name>`, "error"); viewedAgent = state; updateWidget(); syncStatus(ctx); return; }
			if (command === "exit") { if (rest.length || !viewedAgent) return void ctx.ui.notify("No agent view is open.", "warning"); viewedAgent = undefined; updateWidget(); syncStatus(ctx); return; }
			if (command === "team") {
				const selected = Object.keys(teams).find(team => key(team) === key(rest[0] || ""));
				if (rest.length !== 1 || rest[0] !== "off" && !selected) return void ctx.ui.notify("Usage: /agents team <team-name|off>", "error");
				if (agentStates.size) {
					const choice = await ctx.ui.select("Switch team session?", ["start fresh", "fork current session"]);
					if (!choice) return;
					const snapshot = teamSnapshot(selected);
					const seedTargetSession = async (sessionManager: any) => {
						sessionManager.appendCustomEntry("agent-team-instances", snapshot);
						sessionManager.appendCustomEntry("agent-team-model-overrides", { overrides: {} });
						sessionManager.appendCustomEntry("agent-team-fast-overrides", { overrides: {} });
						const defaults = teamRoutingDefaults(selected);
						sessionManager.appendCustomEntry("agent-team-routing", { autoSpawn: defaults.autoSpawn, limit: defaults.limit, queue: routingQueue });
					};
					const newTargetSession = () => ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile(), setup: seedTargetSession, withSession: async replacementCtx => {
						await replacementCtx.reload();
						return;
					} });
					const leafId = ctx.sessionManager.getLeafId();
					if (choice === "start fresh" || !leafId) {
						await newTargetSession();
						return;
					}
					await ctx.fork(leafId, { position: "at", withSession: async replacementCtx => {
						await seedTargetSession(replacementCtx.sessionManager);
						await replacementCtx.reload();
						return;
					} });
					return;
				}
				try { await activateTeam(selected, ctx); ctx.ui.notify(selected ? `Team: ${selected}` : "Team disabled", "info"); } catch (error) { fail(error); }
				return;
			}
			ctx.ui.notify(usage, "info");
		},
	});

	// Only a person typing steers a viewed child. Input from another extension or from RPC is
	// addressed to the host, and swallowing it would silently drop that message.
	pi.on("input", async (event, ctx) => { if (event.source !== "interactive" || !viewedAgent || viewedAgent === rootAgent || event.text.startsWith("/")) return; try { const submitted = await submitAgent(viewedAgent.name, event.text, ctx); ctx.ui.notify(`${displayName(viewedAgent.name)} ${submitted.status === "steered" ? "steering accepted" : "started"}`, "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } return { action: "handled" as const }; });
	// Prompt catalogs are deliberately summaries, never child output, history, or tool activity.
	const promptSummary = (value: string, limit: number) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
	const delegationCatalog = (states: AgentState[]) => {
		const shown = states.slice(0, 20).map(state => {
			const name = promptSummary(state.name, 64); const type = promptSummary(state.def.name, 64); const capability = promptSummary(state.def.description || state.goal, 180);
			const limitations = promptSummary(state.def.limitations || "No additional limits declared.", 140); const tools = promptSummary(state.def.tools, 140);
			const task = promptSummary(state.task, 140); const history = state.history.slice(-3).map(entry => `${entry.outcome}:${promptSummary(entry.task, 96)}`).join(" | ") || "(none)";
			const model = promptSummary(effectiveModel(state, widgetCtx), 96); const fast = effectiveFast(state, widgetCtx) ? "on" : "off";
			const detail = state.status === "running" ? `; current task: ${task || "working"}; elapsed: ${Math.round(state.elapsed / 1000)}s`
				: (state.status === "done" || state.status === "error") && task && state.task === task ? `; last task: ${task}` : "";
			return `- name: ${name}; base type: ${type}; capability: ${capability}; limitations: ${limitations}; model: ${model}; fast: ${fast}; tools: ${tools}; status: ${state.status}; recent completed tasks: ${history}${detail}`;
		});
		if (states.length > shown.length) shown.push(`(${states.length - shown.length} additional instances omitted to keep this catalog bounded.)`);
		return shown.join("\n") || "(none)";
	};
	const delegationGuidance = "Consult status before delegation: steer a relevant running instance rather than starting duplicate work; choose an idle or done specialist for new work. Status is advisory—dispatch_agent and runtime remain authoritative.";
	pi.on("before_agent_start", async (event, ctx) => {
		if (rootAgent) {
			rootAgent.task = event.prompt; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens;
			const catalog = delegationCatalog([...agentStates.values()].filter(state => state !== rootAgent));
			return { systemPrompt: `${event.systemPrompt}\n\n# Root agent identity: ${rootAgent.name} (${rootAgent.def.name})\nGoal: ${rootAgent.goal}\n\n${rootAgent.def.systemPrompt}\n\nYou are the visible host assistant. Delegate focused work with dispatch_agent or directly stop a running child with interrupt_agent:\n${catalog}\n${delegationGuidance}\nNever dispatch yourself. Child results are private context; synthesize one coherent answer for the user.` };
		}
		// With no instances there is nobody to dispatch to: leave the host prompt alone rather than
		// telling it to delegate to an empty catalogue.
		if (!agentStates.size) return;
		const catalog = delegationCatalog([...agentStates.values()]);
		return { systemPrompt: `${event.systemPrompt}\n\nYou are a dispatcher. Delegate through dispatch_agent and use interrupt_agent only to stop a running child. Dynamic instances:\n${catalog}\n${delegationGuidance}\nDo not use codebase tools directly. Synthesize child results into one answer.` };
	});
	pi.events.on("openai-fast:changed", () => updateWidget());
	pi.on("thinking_level_select", () => updateWidget());
	pi.on("model_select", (_event, ctx) => { for (const state of agentStates.values()) if (state.status !== "running") state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); updateWidget(); });
	pi.on("agent_start", (_event, ctx) => {
		hostBusy = true;
		// Pi starts one low-level run for each follow-up in one-at-a-time mode. Match
		// the queued result by completion order, not Map iteration order.
		const delivered = pendingDeliveries.shift();
		if (delivered) {
			restoreNextWaitingAgent([delivered]);
			updateWidget();
			syncStatus(ctx);
		}
		if (!rootAgent) return;
		clearInterval(rootAgent.timer); rootAgent.status = "running"; rootAgent.toolCount = 0; rootAgent.elapsed = 0; rootStartTime = Date.now(); rootAgent.timer = setInterval(() => { if (rootAgent) { rootAgent.elapsed = Date.now() - rootStartTime; updateWidget(); } }, FRAME_MS); rootAgent.timer.unref?.(); rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); syncStatus(ctx); });
	pi.on("message_start", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("message_update", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("message_end", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("tool_execution_start", (event, ctx) => { if (rootAgent) { rootAgent.toolCount++; rootAgent.task = `Using ${event.toolName}`; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("tool_execution_end", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("agent_settled", async (_event, ctx) => {
		// isIdle is guaranteed here unless another run was started by an extension.
		// In that case retain returning cards until that run settles rather than clearing early.
		if (!ctx.isIdle()) return;
		hostBusy = false;
		pendingDeliveries.length = 0;
		restoreWaitingAgents([...agentStates.values()]);
		if (rootAgent) {
			clearInterval(rootAgent.timer); rootAgent.elapsed = rootStartTime ? Date.now() - rootStartTime : rootAgent.elapsed;
			rootAgent.status = "done"; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens;
		}
		updateWidget();
		syncStatus(ctx);
		await drainRoutingQueue(ctx);
	});
	pi.on("session_shutdown", () => { lifecycleGeneration++; bulkCompactionActive = false; for (const state of agentStates.values()) { clearInterval(state.timer); state.timer = undefined; if (state.activeRun) terminateRun(state.activeRun); } });
	pi.on("session_start", async (_event, ctx) => {
		lifecycleGeneration++; bulkCompactionActive = false;
		if (!agentAutocompleteInstalled) {
			ctx.ui.addAutocompleteProvider(current => ({
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/^\/agents[ \t]+([\s\S]*)$/)?.[1];
					if (!options.force || prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
					const items = getAgentArgumentCompletions(prefix);
					return items ? { items: annotateAgentCompletion(prefix, items), prefix } : current.getSuggestions(lines, cursorLine, cursorCol, options);
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) { return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix); },
				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) { return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true; },
			}));
			agentAutocompleteInstalled = true;
		}
		// Pi carries the active tool list across a session reload, so a previous session's
		// narrowing survives into this one. Give the host its tools back before re-reading them:
		// clearing the capture without restoring first would leave a team-less session stranded
		// on the six team tools, with no read, edit, or bash.
		if (hostTools) pi.setActiveTools(hostTools);
		widgetCtx = ctx; parentSessionId = ctx.sessionManager.getSessionId(); viewedAgent = undefined; hostTools = undefined; rootModelRestored = true; hostBusy = !ctx.isIdle(); pendingDeliveries.length = 0; loadAgents(ctx.cwd);
		agentModelOverrides.clear();
		agentFastOverrides.clear();
		const modelOverrides = (ctx.sessionManager.getEntries() as any[]).filter(entry => entry.type === "custom" && entry.customType === "agent-team-model-overrides").pop()?.data as { overrides?: Record<string, string> } | undefined;
		const fastOverrides = (ctx.sessionManager.getEntries() as any[]).filter(entry => entry.type === "custom" && entry.customType === "agent-team-fast-overrides").pop()?.data as SavedAgentFastOverrides | undefined;
		for (const [name, model] of Object.entries(modelOverrides?.overrides ?? {})) agentModelOverrides.set(name, model);
		for (const [name, enabled] of Object.entries(fastOverrides?.overrides ?? {})) {
			if (typeof enabled === "boolean") agentFastOverrides.set(name, enabled);
		}
		restoreTeam(ctx);
		restoreRouting(ctx);
		for (const state of agentStates.values()) state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx);
		if (rootAgent) {
			const modelName = effectiveModel(rootAgent, ctx); const slash = modelName.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(modelName.slice(0, slash), modelName.slice(slash + 1)) : undefined;
			rootModelRestored = parentModel(ctx) === modelName || !!model && await pi.setModel(model);
			if (!rootModelRestored) ctx.ui.notify(`ROOT ${rootAgent.name}: unable to restore model ${modelName}`, "warning");
		}
		applyActiveTools(); updateWidget(); syncStatus(ctx);
		// No setFooter here: the footer belongs to whatever statusline the user configured
		// (zentui owns it in this setup), and this extension reports through setStatus instead.
	});
}
