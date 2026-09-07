/** Dynamic, session-local specialist teams. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
	addTokenCounts, AGENT_VIEW_COMMAND, AgentRpcTransport, childSessionPath, contextTokensFromUsage, encodeCwd,
	formatToolActivity, isAgentViewCommand, latestAssistantContextTokens, latestChildActivity, pruneSessionDirs, resultDeliveryStatus, rootTools, sessionTokenCounts, shouldFinalizeAgentEvent, terminateChild, type AgentCompletionStatus, type TokenCounts,
} from "./agent-team-helpers";
import { ActivityLog, OutputBuffer, TextTail, type ActivityKind } from "./lib/agent-activity";
import { CUSTOM_AGENT, scanAgentDirs, scanTeams, type AgentDef, type TeamDef } from "./lib/agent-defs";
import { FRAME_MS, renderDetail, renderEmpty, renderGrid, type AgentStatus } from "./lib/agent-render";

interface ActiveAgentRun {
	child: ChildProcessWithoutNullStreams; transport: AgentRpcTransport; text: TextTail; stderrChunks: string[]; initialTask: string;
	sessionFile: string; startTime: number; runId: string; usageSequence: number; accepted: boolean; finished: boolean; stopping: boolean;
	output: OutputBuffer; toolStarts: Map<string, { summary: string; startTime: number }>;
}
interface AgentState {
	name: string; def: AgentDef; goal: string; status: AgentStatus; pendingOutcome?: AgentCompletionStatus; task: string;
	toolCount: number; elapsed: number; lastWork: string; activity: ActivityLog; contextTokens: number; contextWindow: number; tokens: TokenCounts;
	sessionFile: string | null; runCount: number; autoName: boolean; sessionKey: string; timer?: ReturnType<typeof setInterval>; activeRun?: ActiveAgentRun;
}
type SavedInstance = { name: string; type: string; goal: string; autoName?: boolean; sessionKey?: string };
type SavedTeam = { instances: SavedInstance[]; root?: string };
type LegacyTeamMode = { team?: string | null };

const TEAM_TOOLS = ["dispatch_agent", "set_agent_model"];
const MAX_KEPT_SESSIONS = 20;
const displayName = (name: string) => name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const key = (name: string) => name.toLowerCase();
const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

export default function (pi: ExtensionAPI) {
	const agentStates = new Map<string, AgentState>();
	const agentModelOverrides = new Map<string, string>();
	let allAgentDefs: AgentDef[] = []; let teams: Record<string, TeamDef> = {};
	let widgetCtx: any; let sessionDir = ""; let parentSessionId = "";
	let viewedAgent: AgentState | undefined; let rootAgent: AgentState | undefined;
	let agentAutocompleteInstalled = false; let gridCols = 3; let rootStartTime = 0;
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
	function makeState(def: AgentDef, name: string, goal: string, autoName = false, rawSessionKey = name): AgentState {
		// childSessionPath rejects anything outside [A-Za-z0-9_-]; a definition named "code.review"
		// would otherwise throw from session_start and take the whole extension down with it.
		const sessionKey = rawSessionKey.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "agent";
		const provisional = { name, def, sessionKey } as AgentState; const file = sessionPath(provisional);
		return { name, def, goal, status: "idle", task: "", toolCount: 0, elapsed: 0, lastWork: "", activity: ActivityLog.parse(latestChildActivity(file)),
			contextTokens: latestAssistantContextTokens(file) ?? 0, contextWindow: modelWindow(def.model ?? parentModel(widgetCtx), widgetCtx), tokens: sessionTokenCounts(file),
			sessionFile: existsSync(file) ? file : null, runCount: 0, autoName, sessionKey };
	}
	function persistTeam() {
		pi.appendEntry("agent-team-instances", { instances: [...agentStates.values()].map(state => ({ name: state.name, type: state.def.name, goal: state.goal, autoName: state.autoName, sessionKey: state.sessionKey })), root: rootAgent?.name });
	}
	function restoreTeam(ctx: any) {
		const entries = ctx.sessionManager.getEntries();
		const snapshot = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-instances").pop();
		const saved = snapshot?.data as SavedTeam | undefined;
		agentStates.clear(); rootAgent = undefined;
		if (snapshot) {
			for (const item of saved?.instances ?? []) {
				const def = definitionFor(item.type);
				if (def && /^[a-z0-9_-]+$/i.test(item.name) && !agentStates.has(key(item.name))) agentStates.set(key(item.name), makeState(def, item.name, item.goal || def.description, item.autoName === true, item.sessionKey && /^[a-z0-9_-]+$/i.test(item.sessionKey) ? item.sessionKey : item.name));
			}
			rootAgent = saved?.root ? stateFor(saved.root) : undefined;
			return;
		}
		const legacy = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-mode").pop()?.data as LegacyTeamMode | undefined;
		if (legacy?.team) for (const member of teams[legacy.team]?.members ?? []) {
			const def = definitionFor(member);
			if (def && !agentStates.has(key(def.name))) agentStates.set(key(def.name), makeState(def, def.name, def.description));
		}
		persistTeam();
	}
	function loadAgents(cwd: string) {
		sessionDir = join(getAgentDir(), "agent-team-sessions", encodeCwd(cwd));
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		pruneSessionDirs(sessionDir, MAX_KEPT_SESSIONS); allAgentDefs = scanAgentDirs(cwd, getAgentDir()); teams = scanTeams(cwd, getAgentDir());
	}
	/**
	 * Narrow the host's tools to match the current mode, and restore them when there is no mode.
	 * setActiveTools replaces the whole tool list, so with no root and no instances the host must
	 * keep everything it started with — otherwise a plain session is left with dispatch_agent alone.
	 */
	function applyActiveTools() {
		const restricted = rootAgent ? rootTools(hostTools ?? pi.getActiveTools(), TEAM_TOOLS) : agentStates.size ? TEAM_TOOLS : undefined;
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
		if (state.status === "running") throw new Error(`Wait for ${displayName(state.name)} to finish before promotion`);
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
	function renameAutoInstance(state: AgentState, name: string) {
		if (state.status === "running") throw new Error(`Cannot add another ${state.def.name} while ${state.name} is running`);
		const oldKey = key(state.name); const override = agentModelOverrides.get(oldKey);
		agentStates.delete(oldKey); state.name = name; agentStates.set(key(name), state);
		syncStatus();
		if (override) { agentModelOverrides.delete(oldKey); agentModelOverrides.set(key(name), override); pi.appendEntry("agent-team-model-overrides", { overrides: Object.fromEntries(agentModelOverrides) }); }
	}
	function nextAutoName(def: AgentDef): { name: string; rename?: { state: AgentState; name: string } } {
		const base = normalizeName(def.name); const existing = stateFor(base);
		let suffix = 1; while (stateFor(`${base}-${suffix}`)) suffix++;
		if (def === CUSTOM_AGENT) return { name: existing ? `${base}-${suffix}` : base };
		if (!existing) return [...agentStates.values()].some(state => state.autoName && key(state.def.name) === key(def.name)) ? { name: `${base}-${suffix}` } : { name: base };
		if (!existing.autoName) return { name: `${base}-${suffix}` };
		if (existing.status === "running") throw new Error(`Cannot add another ${def.name} while ${existing.name} is running`);
		const renamed = `${base}-${suffix}`; suffix++;
		while (stateFor(`${base}-${suffix}`)) suffix++;
		return { name: `${base}-${suffix}`, rename: { state: existing, name: renamed } };
	}
	async function addAgent(rest: string[], ctx: any, usage: string) {
		let [type, rawName, ...extra] = rest;
		if (!type) {
			const selected = await ctx.ui.select("Add agent", [...predefinedDefs().map(def => def.name), "Custom…"]);
			if (!selected) return;
			type = selected === "Custom…" ? "custom" : selected;
		}
		const def = definitionFor(type); const explicit = rawName !== undefined; const autoName = !explicit && def ? nextAutoName(def) : undefined; const name = explicit ? normalizeName(rawName || "") : autoName?.name || "";
		if (!def || extra.length || explicit && !/^[a-z0-9_-]+$/.test(name)) return void ctx.ui.notify(`Usage: ${usage} <type|custom> [name]`, "error");
		if (agentStates.has(key(name))) return void ctx.ui.notify(`Instance "${name}" already exists`, "error");
		const goal = def === CUSTOM_AGENT ? (await ctx.ui.input("Custom goal", "Goal for this instance"))?.trim() : def.description || `Work as ${displayName(def.name)}`;
		if (!goal) return;
		if (autoName?.rename) renameAutoInstance(autoName.rename.state, autoName.rename.name);
		const state = makeState(def, name, goal, !explicit, randomUUID()); agentStates.set(key(name), state); applyActiveTools(); persistTeam(); updateWidget(); syncStatus(ctx); ctx.ui.notify(`Added ${displayName(name)} (${def.name})`, "info");
	}
	/** Drop a child transcript that is no longer reachable through any instance. */
	function discardSession(state: AgentState) {
		try { rmSync(sessionPath(state), { force: true }); } catch {}
	}
	function removeAgent(state: AgentState, ctx: any) {
		if (state === rootAgent) throw new Error("Cannot remove the promoted root; demote it first");
		if (state.status === "running") throw new Error(`Cannot remove ${displayName(state.name)} while it is running`);
		const wasViewed = viewedAgent === state; agentStates.delete(key(state.name)); agentModelOverrides.delete(key(state.name)); discardSession(state);
		pi.appendEntry("agent-team-model-overrides", { overrides: Object.fromEntries(agentModelOverrides) }); persistTeam();
		if (wasViewed) viewedAgent = undefined;
		applyActiveTools(); updateWidget(); syncStatus(ctx); ctx.ui.notify(`Removed ${displayName(state.name)}`, "info");
	}

	function renderWidget() {
		if (!widgetCtx) return;
		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 0); return { invalidate() { text.invalidate(); }, render(width: number) {
				const renderWidth = Math.max(1, width);
				if (viewedAgent) {
					text.setText(renderDetail(viewedAgent, Math.max(12, renderWidth), theme, {
						model: effectiveModel(viewedAgent, widgetCtx), activity: viewedAgent.activity.list(viewedAgent.lastWork), steerable: viewedAgent !== rootAgent,
					}));
					return text.render(renderWidth);
				}
				if (!agentStates.size) {
					text.setText(renderEmpty(renderWidth, theme));
					return text.render(renderWidth);
				}
				// renderGrid returns one string per line; Text wants a single string.
				text.setText(renderGrid([...agentStates.values()].filter(state => state !== rootAgent), renderWidth, gridCols, theme).join("\n"));
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
	function finishRun(state: AgentState, run: ActiveAgentRun, error?: Error) {
		if (run.finished || state.activeRun !== run) return;
		run.finished = true;
		clearInterval(state.timer);
		state.timer = undefined;
		state.elapsed = Date.now() - run.startTime;
		const outcome: AgentCompletionStatus = error ? "error" : "done";
		const queuedForDelivery = !run.stopping && run.accepted;
		state.status = resultDeliveryStatus(outcome, queuedForDelivery && widgetCtx?.isIdle?.() === false);
		state.pendingOutcome = state.status === "waiting" ? outcome : undefined;
		state.sessionFile = run.sessionFile;
		const output = run.output.toString();
		state.lastWork = error?.message ?? run.text.lastLine;
		state.activeRun = undefined;
		updateWidget();
		syncStatus();
		if (queuedForDelivery) {
			const result = error ? error.message : output || "(no output)";
			pi.sendMessage({ customType: "agent-team-result", content: `Private result from ${state.name} (${state.def.name}) for ${run.initialTask}:\n${result}`, display: false, details: { agent: state.name, status: outcome, elapsed: state.elapsed } }, { deliverAs: "followUp", triggerTurn: true });
			widgetCtx?.ui.notify(`${displayName(state.name)} ${state.status === "waiting" ? `is returning its ${outcome} result` : outcome} in ${Math.round(state.elapsed / 1000)}s`, error ? "error" : "success");
		}
		terminateRun(run);
	}
	function startAgent(state: AgentState, task: string, ctx: any, options: { record?: boolean } = {}): ActiveAgentRun {
		state.status = "running"; state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); state.toolCount = 0; state.elapsed = 0; state.lastWork = "";
		// Maintenance runs (compaction) must not enter the transcript as a task the agent was given.
		if (options.record === false) state.task = "Compacting";
		else { state.task = task; state.activity = ActivityLog.parse(latestChildActivity(sessionPath(state))); state.activity.append("user", task); state.runCount++; }
		// Ticks at frame rate so the spinner turns; updateWidget throttles the actual repaints.
		const startTime = Date.now(); clearInterval(state.timer); state.timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateWidget(); }, FRAME_MS);
		state.timer.unref?.();
		const file = ensureSession(state, ctx.cwd);
		// Resolve against the configured agent dir, not a hardcoded ~/.pi, and skip what is not installed
		// so one missing helper extension cannot stop every child from starting.
		const childExtensions = ["openai-codex-fast.ts", "ponytail.ts"]
			.map(name => join(getAgentDir(), "extensions", name)).filter(existsSync)
			.flatMap(path => ["--extension", path]);
		const args = ["--mode", "rpc", "--no-extensions", ...childExtensions, "--model", effectiveModel(state, ctx), "--tools", state.def.tools, "--thinking", ctx.thinkingLevel ?? "off", "--append-system-prompt", `${state.def.systemPrompt}\n\n# Assigned goal\n${state.goal}`, "--session", file];
		if (state.sessionFile) args.push("-c");
		const child = spawn(process.env.PI_BIN || "pi", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }); const transport = new AgentRpcTransport((line, callback) => child.stdin.write(line, callback));
		const run: ActiveAgentRun = { child, transport, text: new TextTail(), stderrChunks: [], initialTask: task, sessionFile: file, startTime, runId: randomUUID(), usageSequence: 0, accepted: false, finished: false, stopping: false, output: new OutputBuffer(), toolStarts: new Map() }; state.activeRun = run; updateWidget();
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
			const id = event.toolCallId ?? event.id ?? `${event.toolName}:${state.toolCount}`;
			run.toolStarts.set(id, { summary: toolSummary(event), startTime: Date.now() });
			appendActivity("tool-start", run.toolStarts.get(id)!.summary);
		};
		const onToolEnd = (event: any) => {
			const id = event.toolCallId ?? event.id;
			const started = id ? run.toolStarts.get(id) : undefined;
			// Drop the pending entry: a long run makes thousands of calls and none are needed twice.
			if (id) run.toolStarts.delete(id);
			const elapsed = started ? ` · ${Math.max(0, Math.round((Date.now() - started.startTime) / 1000))}s` : "";
			const error = toolError(event);
			const summary = started?.summary ?? toolSummary(event);
			appendActivity(error ? "tool-error" : "tool-done", `${summary}${elapsed}${error ? ` — ${String(error).slice(0, 96)}` : ""}`);
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
		const line = (value: string) => { if (!value.trim()) return; try { handle(JSON.parse(value.endsWith("\r") ? value.slice(0, -1) : value)); } catch {} };
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
			await run.transport.request({ type: "prompt", message: task, streamingBehavior: "steer" });
			// Record it only once the child has accepted it. Without this the detail view — whose whole
			// purpose is steering — shows no trace of what you just typed, and the card keeps advertising
			// the original task. It also stops the reply before and after the steer merging into one entry.
			state.activity.append("user", task); state.task = task; updateWidget();
			return { status: "steered" as const };
		}
		const run = startAgent(state, task, ctx); try { await run.transport.request({ type: "prompt", message: task }); run.accepted = true; return { status: "running" as const }; } catch (error) { const failure = new Error(`Unable to start ${displayName(state.name)}: ${error instanceof Error ? error.message : String(error)}`); finishRun(state, run, failure); throw failure; }
	}
	async function compactAgent(name: string, ctx: any) {
		const state = stateFor(name);
		if (!state) throw new Error(`Unknown dynamic instance "${name}"`);
		if (state === rootAgent) throw new Error("Use /compact for the promoted root");
		if (state.status === "running") throw new Error(`${displayName(state.name)} is running; wait for it to finish before compacting`);
		// Without -c the child would open a blank session and compact nothing, while still
		// leaving the instance looking as though it had a transcript.
		if (!state.sessionFile) throw new Error(`${displayName(state.name)} has not run yet; there is nothing to compact`);
		const run = startAgent(state, "", ctx, { record: false });
		try {
			await run.transport.request({ type: "compact" });
			finishRun(state, run);
			state.activity = ActivityLog.parse(latestChildActivity(run.sessionFile));
			state.contextTokens = latestAssistantContextTokens(run.sessionFile) ?? 0;
			updateWidget();
			ctx.ui.notify(`${displayName(state.name)} compacted`, "success");
		} catch (error) {
			const failure = new Error(`Unable to compact ${displayName(state.name)}: ${error instanceof Error ? error.message : String(error)}`);
			finishRun(state, run, failure);
			throw failure;
		}
	}

	pi.registerTool({ name: "dispatch_agent", label: "Dispatch Agent", description: "Dispatch or steer a named dynamic team instance. Results return privately for one host response.", parameters: Type.Object({ agent: Type.String({ description: "Unique dynamic instance name" }), task: Type.String({ description: "Focused task" }) }),
		async execute(_id, params, _signal, _update, ctx) { const { agent, task } = params as { agent: string; task: string }; const submitted = await submitAgent(agent, task, ctx); return { content: [{ type: "text", text: `${displayName(agent)} ${submitted.status === "steered" ? "steering accepted" : "is working in the background"}.` }], details: { agent, status: submitted.status } }; },
		renderCall(args, theme) { const task = (args as any).task || ""; return new Text(theme.fg("toolTitle", theme.bold("dispatch_agent ")) + theme.fg("accent", (args as any).agent || "?") + theme.fg("dim", ` — ${task.slice(0, 60)}`), 0, 0); },
		renderResult(result, _options, theme) { const details = result.details as any; return new Text(theme.fg("accent", `● ${details?.agent || "agent"}`) + theme.fg("dim", details?.status === "steered" ? " steering accepted" : " working..."), 0, 0); },
	});
	pi.registerTool({ name: "set_agent_model", label: "Set Agent Model", description: "Set a session model for a named dynamic instance.", parameters: Type.Object({ agent: Type.String(), model: Type.String() }), async execute(_id, params, _signal, _update, ctx) { const { agent, model } = params as { agent: string; model: string }; const state = stateFor(agent); if (!state) throw new Error(`Unknown dynamic instance "${agent}"`); if (state === rootAgent) throw new Error("Change the root model with /agents model <name> <model|inherit> when the host is idle"); return { content: [{ type: "text", text: `${state.name}: ${setInstanceModel(state, model, ctx)}` }], details: { agent: state.name } }; } });

	const usage = "Usage: /agents add <type|custom> [name] | remove <name> | compact <name> | promote <instance|base> | demote | list | model <name> [model|inherit] | view <name> | exit | grid <1-6> | team <team-name|off>";
	const listInstances = (ctx: any) => ctx.ui.notify([...agentStates.values()].map(state => `${state === rootAgent ? "ROOT " : ""}${state.name} (${state.def.name}) — ${state.status}; goal: ${state.goal}`).join("\n") || "No instances", "info");
	const availableModels = () => (widgetCtx?.modelRegistry?.getAvailable?.() ?? []).map((model: any) => `${model.provider}/${model.id}`);
	async function activateTeam(teamName: string | undefined, ctx: any) {
		for (const state of agentStates.values()) { if (state.activeRun) terminateRun(state.activeRun); clearInterval(state.timer); state.timer = undefined; discardSession(state); }
		agentStates.clear(); agentModelOverrides.clear(); rootAgent = undefined; viewedAgent = undefined; rootModelRestored = true;
		const team = teamName ? teams[teamName] : undefined;
		for (const member of team?.members ?? []) {
			const def = definitionFor(member);
			if (def && !agentStates.has(key(def.name))) agentStates.set(key(def.name), makeState(def, def.name, def.description));
		}
		pi.appendEntry("agent-team-model-overrides", { overrides: {} }); persistTeam(); applyActiveTools();
		if (team?.root) {
			const def = definitionFor(team.root);
			if (def && !agentStates.has(key(def.name))) agentStates.set(key(def.name), makeState(def, def.name, def.description));
			const root = stateFor(team.root);
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
		if (!command || parts.length === 1 && !trailing) return values(["add", "remove", "compact", "promote", "list", "model", AGENT_VIEW_COMMAND, "grid", "team", "help", ...(rootAgent ? ["demote"] : []), ...(viewedAgent ? ["exit"] : [])]);
		if (command === "add" && (parts.length === 1 || parts.length === 2 && !trailing)) return values([...predefinedDefs().map(def => def.name), "custom"], "add ").map(item => item.label === "custom" ? { ...item, label: "Custom…" } : item);
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
			if (command === "remove") { const state = stateFor(name); if (!state) return void ctx.ui.notify(`Unknown instance "${name}". Usage: /agents remove <name>`, "error"); try { removeAgent(state, ctx); } catch (error) { fail(error); } return; }
			if (command === "compact") { if (!name) return void ctx.ui.notify("Usage: /agents compact <name>", "error"); try { await compactAgent(name, ctx); } catch (error) { fail(error); } return; }
			if (command === "promote") {
				let state = stateForPromotion(name); let created = false;
				if (!state) {
					const def = promotableBaseDefs().find(candidate => key(candidate.name) === key(name));
					if (!def) return void ctx.ui.notify("Usage: /agents promote <instance|base>", "error");
					state = makeState(def, normalizeName(def.name), def.description || `Work as ${displayName(def.name)}`, false, randomUUID());
					agentStates.set(key(state.name), state); created = true;
				}
				if (state === rootAgent) return void ctx.ui.notify("Usage: /agents promote <instance|base>", "error");
				try { await promote(state, ctx); } catch (error) { if (created) agentStates.delete(key(state.name)); fail(error); }
				return;
			}
			if (command === "demote") { if (rest.length) return void ctx.ui.notify("Usage: /agents demote", "error"); try { await demote(ctx); } catch (error) { fail(error); } return; }
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
				// Switching teams throws away every instance, transcript and model override, so ask first.
				if (agentStates.size) {
					const confirm = await ctx.ui.select(`Replace the current team? ${agentStates.size} instance(s), their transcripts and model overrides are discarded.`, ["Cancel", selected ? `Switch to ${selected}` : "Disable the team"]);
					if (!confirm || confirm === "Cancel") return;
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
			const name = promptSummary(state.name, 64); const type = promptSummary(state.def.name, 64); const goal = promptSummary(state.goal, 180);
			const task = promptSummary(state.task, 140);
			const detail = state.status === "running" ? `; current task: ${task || "working"}; elapsed: ${Math.round(state.elapsed / 1000)}s`
				: (state.status === "done" || state.status === "error") && task && state.task === task ? `; last task: ${task}` : "";
			return `- name: ${name}; base type: ${type}; goal: ${goal}; status: ${state.status}${detail}`;
		});
		if (states.length > shown.length) shown.push(`(${states.length - shown.length} additional instances omitted to keep this catalog bounded.)`);
		return shown.join("\n") || "(none)";
	};
	const delegationGuidance = "Consult status before delegation: steer a relevant running instance rather than starting duplicate work; choose an idle or done specialist for new work. Status is advisory—dispatch_agent and runtime remain authoritative.";
	pi.on("before_agent_start", async (event, ctx) => {
		if (rootAgent) {
			rootAgent.task = event.prompt; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens;
			const catalog = delegationCatalog([...agentStates.values()].filter(state => state !== rootAgent));
			return { systemPrompt: `${event.systemPrompt}\n\n# Root agent identity: ${rootAgent.name} (${rootAgent.def.name})\nGoal: ${rootAgent.goal}\n\n${rootAgent.def.systemPrompt}\n\nYou are the visible host assistant. Work directly with your enabled tools. You may delegate focused work with dispatch_agent to these instances:\n${catalog}\n${delegationGuidance}\nNever dispatch yourself. Child results are private context; synthesize one coherent answer for the user.` };
		}
		// With no instances there is nobody to dispatch to: leave the host prompt alone rather than
		// telling it to delegate to an empty catalogue.
		if (!agentStates.size) return;
		const catalog = delegationCatalog([...agentStates.values()]);
		return { systemPrompt: `${event.systemPrompt}\n\nYou are a dispatcher. Delegate through dispatch_agent only. Dynamic instances:\n${catalog}\n${delegationGuidance}\nDo not use codebase tools directly. Synthesize child results into one answer.` };
	});
	pi.on("model_select", (_event, ctx) => { for (const state of agentStates.values()) if (state.status !== "running") state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); updateWidget(); });
	pi.on("agent_start", (_event, ctx) => {
		const waiting = [...agentStates.values()].find(state => state.status === "waiting");
		if (waiting) {
			waiting.status = waiting.pendingOutcome ?? "done";
			waiting.pendingOutcome = undefined;
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
	pi.on("agent_settled", (_event, ctx) => { if (!rootAgent) return; clearInterval(rootAgent.timer); rootAgent.elapsed = rootStartTime ? Date.now() - rootStartTime : rootAgent.elapsed; rootAgent.status = "done"; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); });
	pi.on("session_shutdown", () => { for (const state of agentStates.values()) { clearInterval(state.timer); state.timer = undefined; if (state.activeRun) terminateRun(state.activeRun); } });
	pi.on("session_start", async (_event, ctx) => {
		if (!agentAutocompleteInstalled) {
			ctx.ui.addAutocompleteProvider(current => ({
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/^\/agents[ \t]+([\s\S]*)$/)?.[1];
					if (!options.force || prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
					const items = getAgentArgumentCompletions(prefix);
					return items ? { items, prefix } : current.getSuggestions(lines, cursorLine, cursorCol, options);
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) { return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix); },
				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) { return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true; },
			}));
			agentAutocompleteInstalled = true;
		}
		widgetCtx = ctx; parentSessionId = ctx.sessionManager.getSessionId(); viewedAgent = undefined; hostTools = undefined; rootModelRestored = true; loadAgents(ctx.cwd);
		agentModelOverrides.clear(); const overrides = (ctx.sessionManager.getEntries() as any[]).filter(entry => entry.type === "custom" && entry.customType === "agent-team-model-overrides").pop()?.data as { overrides?: Record<string, string> } | undefined; for (const [name, model] of Object.entries(overrides?.overrides ?? {})) agentModelOverrides.set(name, model);
		restoreTeam(ctx);
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
