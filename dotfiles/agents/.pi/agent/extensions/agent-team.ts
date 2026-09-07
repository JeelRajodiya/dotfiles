/** Dynamic, session-local specialist teams. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { readdirSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
	AgentRpcTransport, childSessionPath, contextTokensFromUsage, encodeCwd, formatAgentContext,
	latestAssistantContextTokens, latestChildTranscript, pruneSessionDirs, shouldFinalizeAgentEvent, terminateChild,
} from "./agent-team-helpers";

interface AgentDef { name: string; description: string; model?: string; tools: string; systemPrompt: string; file: string; }
interface ActiveAgentRun {
	child: ChildProcessWithoutNullStreams; transport: AgentRpcTransport; textChunks: string[]; initialTask: string;
	sessionFile: string; startTime: number; runId: string; usageSequence: number; accepted: boolean; finished: boolean; stopping: boolean;
}
interface AgentState {
	name: string; def: AgentDef; goal: string; status: "idle" | "running" | "done" | "error"; task: string;
	toolCount: number; elapsed: number; lastWork: string; history: string; contextTokens: number; contextWindow: number;
	sessionFile: string | null; runCount: number; timer?: ReturnType<typeof setInterval>; activeRun?: ActiveAgentRun;
}
type SavedInstance = { name: string; type: string; goal: string };
type SavedTeam = { instances: SavedInstance[]; root?: string };
type LegacyTeamMode = { team?: string | null };

function agentHeading(state: AgentState, theme: any): string {
	const base = state.def.name;
	return theme.bold(theme.fg("accent", state.name)) + (state.name.toLowerCase() === base.toLowerCase() ? "" : theme.fg("dim", ` (${base})`));
}

const TEAM_TOOLS = ["dispatch_agent", "set_agent_model"];
const MAX_KEPT_SESSIONS = 20;
/**
 * A child resumes its transcript with -c, so its own tool results pile up across
 * dispatches and get re-sent on every call. Past this many context tokens the
 * transcript is recycled and the next dispatch starts clean.
 */
const MAX_CHILD_CONTEXT_TOKENS = 120_000;
const displayName = (name: string) => name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const key = (name: string) => name.toLowerCase();
const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

function parseAgentFile(file: string): AgentDef | null {
	try {
		const raw = readFileSync(file, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;
		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const colon = line.indexOf(":");
			if (colon > 0) frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
		}
		if (!frontmatter.name) return null;
		return { name: frontmatter.name, description: frontmatter.description || "", model: frontmatter.model,
			tools: frontmatter.tools || "read,grep,find,ls", systemPrompt: match[2].trim(), file };
	} catch { return null; }
}
function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [join(cwd, "agents"), join(cwd, ".claude", "agents"), join(cwd, ".pi", "agents"), join(homedir(), ".pi", "agent", "agents")];
	const seen = new Set<string>(); const defs: AgentDef[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try { for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const def = parseAgentFile(resolve(dir, file));
			if (def && !seen.has(key(def.name))) { seen.add(key(def.name)); defs.push(def); }
		} } catch {}
	}
	return defs;
}

export default function (pi: ExtensionAPI) {
	const agentStates = new Map<string, AgentState>();
	const agentModelOverrides = new Map<string, string>();
	let allAgentDefs: AgentDef[] = [];
	let widgetCtx: any; let sessionDir = ""; let parentSessionId = "";
	let viewedAgent: AgentState | undefined; let rootAgent: AgentState | undefined;
	let gridCols = 2; let rootStartTime = 0;

	const stateFor = (name: string) => agentStates.get(key(name));
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
	const sessionPath = (state: AgentState) => childSessionPath(sessionDir, parentSessionId, state.name);
	function ensureSession(state: AgentState, cwd: string): string {
		const path = sessionPath(state); const dir = join(sessionDir, parentSessionId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!existsSync(path)) writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd }) + "\n");
		return path;
	}
	function makeState(def: AgentDef, name: string, goal: string): AgentState {
		const provisional = { name, def } as AgentState; const file = sessionPath(provisional);
		return { name, def, goal, status: "idle", task: "", toolCount: 0, elapsed: 0, lastWork: "", history: latestChildTranscript(file),
			contextTokens: latestAssistantContextTokens(file) ?? 0, contextWindow: modelWindow(def.model ?? parentModel(widgetCtx), widgetCtx),
			sessionFile: existsSync(file) ? file : null, runCount: 0 };
	}
	function persistTeam() {
		pi.appendEntry("agent-team-instances", { instances: [...agentStates.values()].map(state => ({ name: state.name, type: state.def.name, goal: state.goal })), root: rootAgent?.name });
	}
	function restoreTeam(ctx: any) {
		const entries = ctx.sessionManager.getEntries();
		const snapshot = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-instances").pop();
		const saved = snapshot?.data as SavedTeam | undefined;
		agentStates.clear(); rootAgent = undefined;
		if (snapshot) {
			for (const item of saved?.instances ?? []) {
				const def = allAgentDefs.find(candidate => key(candidate.name) === key(item.type));
				if (def && /^[a-z0-9_-]+$/i.test(item.name) && !agentStates.has(key(item.name))) agentStates.set(key(item.name), makeState(def, item.name, item.goal || def.description));
			}
			rootAgent = saved?.root ? stateFor(saved.root) : undefined;
			return;
		}
		const legacy = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-mode").pop()?.data as LegacyTeamMode | undefined;
		if (legacy?.team) {
			const teamsFile = [join(ctx.cwd, ".pi", "agents", "teams.yaml"), join(homedir(), ".pi", "agent", "agents", "teams.yaml")].find(existsSync);
			let active = false;
			for (const line of teamsFile ? readFileSync(teamsFile, "utf-8").split("\n") : []) {
				if (line.match(new RegExp(`^${legacy.team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`))) { active = true; continue; }
				if (active && /^\S/.test(line)) break;
				const member = active ? line.match(/^\s+-\s+(.+)$/)?.[1]?.trim() : undefined;
				const def = member && allAgentDefs.find(candidate => key(candidate.name) === key(member));
				if (def && !agentStates.has(key(def.name))) agentStates.set(key(def.name), makeState(def, def.name, def.description));
			}
		}
		persistTeam();
	}
	function loadAgents(cwd: string) {
		sessionDir = join(getAgentDir(), "agent-team-sessions", encodeCwd(cwd));
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		pruneSessionDirs(sessionDir, MAX_KEPT_SESSIONS); allAgentDefs = scanAgentDirs(cwd);
	}
	function rootTools(state: AgentState): string[] { return [...new Set([...state.def.tools.split(",").map(tool => tool.trim()).filter(Boolean), ...TEAM_TOOLS])]; }
	async function promote(state: AgentState, ctx: any) {
		await ctx.waitForIdle();
		state = stateFor(state.name)!;
		if (!state || rootAgent) throw new Error(rootAgent ? `Root is already ${displayName(rootAgent.name)} for this session` : "Instance no longer exists");
		if (state.status === "running") throw new Error(`Wait for ${displayName(state.name)} to finish before promotion`);
		const modelName = effectiveModel(state, ctx); const slash = modelName.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(modelName.slice(0, slash), modelName.slice(slash + 1)) : undefined;
		if (!model || (parentModel(ctx) !== modelName && !await pi.setModel(model))) throw new Error(`Unable to select ${modelName}`);
		viewedAgent = undefined; rootAgent = state; pi.setActiveTools(rootTools(state)); persistTeam(); updateWidget();
		ctx.ui.setStatus("agent-team", `Root: ${displayName(state.name)}`);
		ctx.ui.notify(`${displayName(state.name)} is now this session's root.`, "info");
	}

	function renderCard(state: AgentState, width: number, theme: any): string[] {
		const cardWidth = Math.max(1, width); const w = Math.max(1, cardWidth - 2); const trim = (value: string) => truncateToWidth(value, Math.max(1, w - 1));
		const icon = state.status === "running" ? "●" : state.status === "done" ? "✓" : state.status === "error" ? "✗" : "○";
		const color = state.status === "running" ? "accent" : state.status === "done" ? "success" : state.status === "error" ? "error" : "dim";
		const status = `${icon} ${state.status}${state.status === "running" ? ` · ${Math.round(state.elapsed / 1000)}s` : ""}`; const context = formatAgentContext(state.contextTokens, state.contextWindow); const suffix = `${status} · ${context}`;
		const labelWidth = Math.max(0, w - 1 - visibleWidth(suffix) - visibleWidth(" · "));
		const activity = state.task ? `Task: ${state.task}` : `Goal: ${state.goal || state.def.description}`;
		const tools = `Tools: ${state.toolCount}`;
		const row = (content: string) => theme.fg("dim", "│") + " " + content + " ".repeat(Math.max(0, w - visibleWidth(content) - 1)) + theme.fg("dim", "│");
		const summary = labelWidth ? truncateToWidth(agentHeading(state, theme), labelWidth) + theme.fg("muted", " · ") + theme.fg(color, status) + theme.fg("muted", ` · ${context}`) : theme.fg(color, truncateToWidth(suffix, Math.max(1, w - 1)));
		return [theme.fg("dim", `┌${"─".repeat(w)}┐`), row(summary), row(theme.fg("muted", trim(`${activity} · ${tools}`))), theme.fg("dim", `└${"─".repeat(w)}┘`)].map(line => truncateToWidth(line, cardWidth));
	}
	function updateWidget() {
		if (!widgetCtx) return;
		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 0); return { invalidate() { text.invalidate(); }, render(width: number) {
				if (viewedAgent) {
						const state = viewedAgent; text.setText([agentHeading(state, theme) + theme.fg("muted", ` · ${state.status}`), theme.fg("dim", `Goal: ${state.goal}\n${formatAgentContext(state.contextTokens, state.contextWindow)} tokens · ${state.toolCount} tools · ${Math.round(state.elapsed / 1000)}s`), theme.fg("muted", state.history || state.lastWork || "No child output yet."), theme.fg("dim", "Use /agent exit to close this detail view.")].join("\n")); return text.render(width);
				}
				if (!agentStates.size) { text.setText(theme.fg("dim", "No dynamic instances. Use /agent add <type> <name>.")); return text.render(width); }
				const renderWidth = Math.max(1, width); const states = [...agentStates.values()].filter(state => state !== rootAgent); const rows: string[] = [];
				if (states.length) { const gap = 1; const maxCols = Math.max(1, Math.floor((renderWidth + gap) / 13)); const cols = Math.min(gridCols, states.length, maxCols); const cardWidth = Math.max(1, Math.floor((renderWidth - gap * (cols - 1)) / cols)); for (let i = 0; i < states.length; i += cols) { const cards = states.slice(i, i + cols).map(state => renderCard(state, cardWidth, theme)); while (cards.length < cols) cards.push(Array(4).fill(" ".repeat(cardWidth))); for (let line = 0; line < 4; line++) rows.push(truncateToWidth(cards.map(card => card[line]).join(" "), renderWidth)); } }
				text.setText(rows.join("\n")); return text.render(renderWidth);
			} };
		});
	}

	function terminateRun(run: ActiveAgentRun) { run.stopping = true; run.transport.fail(new Error("Agent process stopped")); terminateChild(run.child); }
	function finishRun(state: AgentState, run: ActiveAgentRun, error?: Error) {
		if (run.finished || state.activeRun !== run) return; run.finished = true; clearInterval(state.timer); state.timer = undefined; state.elapsed = Date.now() - run.startTime; state.status = error ? "error" : "done"; state.sessionFile = run.sessionFile;
		const output = run.textChunks.join(""); state.lastWork = error?.message ?? output.split("\n").filter(Boolean).pop() ?? ""; state.activeRun = undefined; updateWidget();
		if (!run.stopping && run.accepted) {
			const result = error ? error.message : output.slice(0, 8000) || "(no output)";
			pi.sendMessage({ customType: "agent-team-result", content: `Private result from ${state.name} (${state.def.name}) for ${run.initialTask}:\n${result}`, display: false, details: { agent: state.name, status: state.status, elapsed: state.elapsed } }, { deliverAs: "followUp", triggerTurn: true });
			widgetCtx?.ui.notify(`${displayName(state.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, error ? "error" : "success");
		}
		terminateRun(run);
	}
	function recycleSession(state: AgentState, ctx: any): void {
		try { rmSync(sessionPath(state), { force: true }); } catch {}
		state.sessionFile = null; state.contextTokens = 0; state.history = "";
		ctx.ui?.notify?.(`${displayName(state.name)} transcript recycled — next dispatch starts fresh`, "info");
	}
	function startAgent(state: AgentState, task: string, ctx: any): ActiveAgentRun {
		if (state.sessionFile && state.contextTokens > MAX_CHILD_CONTEXT_TOKENS) recycleSession(state, ctx);
		state.status = "running"; state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); state.task = task; state.toolCount = 0; state.elapsed = 0; state.lastWork = ""; state.history = latestChildTranscript(sessionPath(state)); state.runCount++;
		const startTime = Date.now(); clearInterval(state.timer); state.timer = undefined; state.timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateWidget(); }, 1000);
		const file = ensureSession(state, ctx.cwd); const args = ["--mode", "rpc", "--no-extensions", "--extension", join(homedir(), ".pi", "agent", "extensions", "openai-codex-fast.ts"), "--extension", join(homedir(), ".pi", "agent", "extensions", "ponytail.ts"), "--model", effectiveModel(state, ctx), "--tools", state.def.tools, "--thinking", "off", "--append-system-prompt", `${state.def.systemPrompt}\n\n# Assigned goal\n${state.goal}`, "--session", file];
		if (state.sessionFile) args.push("-c");
		const child = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }); const transport = new AgentRpcTransport((line, callback) => child.stdin.write(line, callback));
		const run: ActiveAgentRun = { child, transport, textChunks: [], initialTask: task, sessionFile: file, startTime, runId: randomUUID(), usageSequence: 0, accepted: false, finished: false, stopping: false }; state.activeRun = run; updateWidget();
		let buffer = ""; const persistUsage = (kind: string, message: any, usage: any) => { if (!usage || typeof usage !== "object") return; pi.appendEntry("agent-team-usage", { sourceEventId: `${run.runId}:${kind}:${++run.usageSequence}`, usage, provider: message?.provider, model: message?.model }); pi.events.emit("agent-team:usage"); };
		const handle = (event: any) => { if (transport.handle(event)) return; if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") { const delta = event.assistantMessageEvent.delta || ""; run.textChunks.push(delta); state.lastWork = run.textChunks.join("").split("\n").filter(Boolean).pop() || ""; state.history = `${state.history}\nassistant: ${delta}`.slice(-2000); updateWidget(); } else if (event.type === "tool_execution_start") { state.toolCount++; updateWidget(); } else if (event.type === "message_end") { const tokens = contextTokensFromUsage(event.message?.usage); if (tokens !== undefined) state.contextTokens = tokens; persistUsage("message", event.message, event.message?.usage); updateWidget(); } else if (event.type === "compaction_end") persistUsage("compaction", event.result, event.result?.usage); else if (shouldFinalizeAgentEvent(event.type)) finishRun(state, run); };
		const line = (value: string) => { if (!value.trim()) return; try { handle(JSON.parse(value.endsWith("\r") ? value.slice(0, -1) : value)); } catch {} };
		child.stdout.setEncoding("utf-8"); child.stdout.on("data", (chunk: string) => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); } }); child.stderr.on("data", () => {}); child.stdin.on("error", error => transport.fail(error)); child.on("error", error => { transport.fail(error); if (!run.stopping) finishRun(state, run, new Error(`Agent process error: ${error.message}`)); }); child.on("close", code => { line(buffer); transport.fail(new Error(`Agent process exited with code ${code ?? 1}`)); if (!run.finished && !run.stopping) finishRun(state, run, new Error(`Agent process exited before settling (code ${code ?? 1})`)); });
		return run;
	}
	async function submitAgent(name: string, task: string, ctx: any) {
		const state = stateFor(name); if (!state) throw new Error(`Unknown dynamic instance "${name}"`); if (rootAgent === state) throw new Error("The root agent cannot dispatch itself");
		if (state.status === "running") { const run = state.activeRun; if (!run || run.finished || run.stopping) throw new Error(`${displayName(state.name)} cannot be steered`); await run.transport.request({ type: "prompt", message: task, streamingBehavior: "steer" }); return { status: "steered" as const }; }
		const run = startAgent(state, task, ctx); try { await run.transport.request({ type: "prompt", message: task }); run.accepted = true; return { status: "running" as const }; } catch (error) { const failure = new Error(`Unable to start ${displayName(state.name)}: ${error instanceof Error ? error.message : String(error)}`); finishRun(state, run, failure); throw failure; }
	}

	pi.registerTool({ name: "dispatch_agent", label: "Dispatch Agent", description: "Dispatch or steer a named dynamic team instance. Results return privately for one host response.", parameters: Type.Object({ agent: Type.String({ description: "Unique dynamic instance name" }), task: Type.String({ description: "Focused task" }) }),
		async execute(_id, params, _signal, _update, ctx) { const { agent, task } = params as { agent: string; task: string }; const submitted = await submitAgent(agent, task, ctx); return { content: [{ type: "text", text: `${displayName(agent)} ${submitted.status === "steered" ? "steering accepted" : "is working in the background"}.` }], details: { agent, status: submitted.status } }; },
		renderCall(args, theme) { const task = (args as any).task || ""; return new Text(theme.fg("toolTitle", theme.bold("dispatch_agent ")) + theme.fg("accent", (args as any).agent || "?") + theme.fg("dim", ` — ${task.slice(0, 60)}`), 0, 0); },
		renderResult(result, _options, theme) { const details = result.details as any; return new Text(theme.fg(details?.status === "steered" ? "accent" : "accent", `${details?.status === "steered" ? "●" : "●"} ${details?.agent || "agent"}`) + theme.fg("dim", details?.status === "steered" ? " steering accepted" : " working..."), 0, 0); },
	});
	pi.registerTool({ name: "set_agent_model", label: "Set Agent Model", description: "Set a session model for a named dynamic instance.", parameters: Type.Object({ agent: Type.String(), model: Type.String() }), async execute(_id, params, _signal, _update, ctx) { const { agent, model } = params as { agent: string; model: string }; const state = stateFor(agent); if (!state) throw new Error(`Unknown dynamic instance "${agent}"`); if (state === rootAgent) throw new Error("Change the root model with /agent-model when the host is idle"); return { content: [{ type: "text", text: `${state.name}: ${setInstanceModel(state, model, ctx)}` }], details: { agent: state.name } }; } });

	pi.registerCommand("agent", {
		description: "Add, promote, or inspect a dynamic team instance",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null { const parts = prefix.split(/\s+/); const names = [...agentStates.values()].map(state => state.name); const choices = parts.length <= 1 ? ["add", "promote", ...names] : parts[0] === "add" ? allAgentDefs.map(def => def.name) : parts[0] === "promote" ? names : []; return choices.filter(value => value.startsWith(parts.at(-1) || "")).map(value => ({ value: parts.length > 1 ? `${parts.slice(0, -1).join(" ")} ${value}` : value, label: value })); },
		async handler(args, ctx) {
			widgetCtx = ctx; const [command, ...rest] = args.trim().split(/\s+/);
			if (command === "add") {
				const [type, rawName, ...extra] = rest; const def = allAgentDefs.find(candidate => key(candidate.name) === key(type || "")); const name = normalizeName(rawName || "");
				if (!def || !name || extra.length || !/^[a-z0-9_-]+$/.test(name)) return void ctx.ui.notify("Usage: /agent add <type> <unique-name>", "error");
				if (agentStates.has(key(name))) return void ctx.ui.notify(`Instance "${name}" already exists`, "error");
				const defaultGoal = def.description || `Work as ${displayName(def.name)}`; const choice = await ctx.ui.select("Set instance goal", [`Default — ${defaultGoal}`, "Custom…"]); if (!choice) return;
				const goal = choice === "Custom…" ? (await ctx.ui.input("Custom goal", "Goal for this instance"))?.trim() : defaultGoal; if (!goal) return;
				const state = makeState(def, name, goal); agentStates.set(key(name), state); if (!rootAgent) pi.setActiveTools(TEAM_TOOLS); persistTeam(); updateWidget(); ctx.ui.notify(`Added ${displayName(name)} (${def.name})`, "info"); return;
			}
			if (command === "promote") { const state = stateFor(rest.join(" ")); if (!state) return void ctx.ui.notify("Usage: /agent promote <instance>", "error"); try { await promote(state, ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } return; }
			if (command === "exit") { if (!viewedAgent) return void ctx.ui.notify("No detail view is open.", "warning"); viewedAgent = undefined; ctx.ui.setStatus("agent-team", rootAgent ? `Root: ${displayName(rootAgent.name)}` : undefined); updateWidget(); return; }
			const state = stateFor(command || ""); if (!state) return void ctx.ui.notify("Usage: /agent <instance> | add <type> <name> | promote <name>", "info"); viewedAgent = state; ctx.ui.setStatus("agent-team", `Viewing: ${state === rootAgent ? "ROOT " : ""}${displayName(state.name)}`); updateWidget();
		},
	});
	pi.registerCommand("agent-model", { description: "Show or set a dynamic instance model", getArgumentCompletions(prefix) { const names = [...agentStates.values()].map(state => state.name); return names.filter(name => name.startsWith(prefix.split(" ")[0])).map(name => ({ value: name, label: name })); }, async handler(args, ctx) { const [name, model] = args.trim().split(/\s+/); if (!name) return void ctx.ui.notify([...agentStates.values()].map(state => `${state === rootAgent ? "ROOT " : ""}${state.name}: ${modelSetting(state, ctx)}`).join("\n") || "No instances", "info"); try { let state = stateFor(name); if (!state || !model) throw new Error("Usage: /agent-model <instance> <provider/model|inherit>"); if (state === rootAgent) { await ctx.waitForIdle(); state = stateFor(name); if (!state || state !== rootAgent) throw new Error("Root changed while waiting for host idle"); ctx.ui.notify(`ROOT ${state.name}: ${await setRootModel(state, model, ctx)}`, "info"); } else ctx.ui.notify(`${state.name}: ${setInstanceModel(state, model, ctx)}`, "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } } });
	pi.registerCommand("agents-list", { description: "List dynamic instances", async handler(_args, ctx) { ctx.ui.notify([...agentStates.values()].map(state => `${state === rootAgent ? "ROOT " : ""}${state.name} (${state.def.name}) — ${state.status}; goal: ${state.goal}`).join("\n") || "No dynamic instances", "info"); } });
	pi.registerCommand("agents-grid", { description: "Set dynamic team card columns", async handler(args, ctx) { const value = args.trim(); if (!/^[1-6]$/.test(value)) return void ctx.ui.notify("Usage: /agents-grid <1-6>", "error"); gridCols = Number(value); updateWidget(); } });

	pi.on("input", async (event, ctx) => { if (!viewedAgent || viewedAgent === rootAgent || event.text.startsWith("/")) return; try { const submitted = await submitAgent(viewedAgent.name, event.text, ctx); ctx.ui.notify(`${displayName(viewedAgent.name)} ${submitted.status === "steered" ? "steering accepted" : "started"}`, "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } return { action: "handled" as const }; });
	pi.on("before_agent_start", async (event, ctx) => {
		if (rootAgent) {
			rootAgent.task = event.prompt; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens;
			const catalog = [...agentStates.values()].filter(state => state !== rootAgent).map(state => `- ${state.name} (${state.def.name}): ${state.goal}`).join("\n") || "(none)";
			return { systemPrompt: `${event.systemPrompt}\n\n# Root agent identity: ${rootAgent.name} (${rootAgent.def.name})\nGoal: ${rootAgent.goal}\n\n${rootAgent.def.systemPrompt}\n\nYou are the visible host assistant. Work directly with your enabled tools. You may delegate focused work with dispatch_agent to these instances:\n${catalog}\nNever dispatch yourself. Child results are private context; synthesize one coherent answer for the user.` };
		}
		const catalog = [...agentStates.values()].map(state => `- ${state.name} (${state.def.name}): ${state.goal}`).join("\n") || "(none)";
		return { systemPrompt: `${event.systemPrompt}\n\nYou are a dispatcher. Delegate through dispatch_agent only. Dynamic instances:\n${catalog}\nDo not use codebase tools directly. Synthesize child results into one answer.` };
	});
	pi.on("model_select", (_event, ctx) => { for (const state of agentStates.values()) if (state.status !== "running") state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); updateWidget(); });
	pi.on("agent_start", (_event, ctx) => { if (!rootAgent) return; clearInterval(rootAgent.timer); rootAgent.status = "running"; rootAgent.toolCount = 0; rootAgent.elapsed = 0; rootStartTime = Date.now(); rootAgent.timer = setInterval(() => { if (rootAgent) { rootAgent.elapsed = Date.now() - rootStartTime; updateWidget(); } }, 1000); rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); });
	pi.on("message_start", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("message_update", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("message_end", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("tool_execution_start", (event, ctx) => { if (rootAgent) { rootAgent.toolCount++; rootAgent.task = `Using ${event.toolName}`; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("tool_execution_end", (_event, ctx) => { if (rootAgent) { rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); } });
	pi.on("agent_settled", (_event, ctx) => { if (!rootAgent) return; clearInterval(rootAgent.timer); rootAgent.elapsed = rootStartTime ? Date.now() - rootStartTime : rootAgent.elapsed; rootAgent.status = "done"; rootAgent.contextTokens = ctx.getContextUsage()?.tokens ?? rootAgent.contextTokens; updateWidget(); });
	pi.on("session_shutdown", () => { for (const state of agentStates.values()) { clearInterval(state.timer); state.timer = undefined; if (state.activeRun) terminateRun(state.activeRun); } });
	pi.on("session_start", async (_event, ctx) => {
		widgetCtx = ctx; parentSessionId = ctx.sessionManager.getSessionId(); viewedAgent = undefined; loadAgents(ctx.cwd);
		agentModelOverrides.clear(); const overrides = ctx.sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "agent-team-model-overrides").pop()?.data as { overrides?: Record<string, string> } | undefined; for (const [name, model] of Object.entries(overrides?.overrides ?? {})) agentModelOverrides.set(name, model);
		restoreTeam(ctx); for (const state of agentStates.values()) state.contextWindow = modelWindow(effectiveModel(state, ctx), ctx); if (rootAgent) { const modelName = effectiveModel(rootAgent, ctx); const slash = modelName.indexOf("/"); const model = slash > 0 ? ctx.modelRegistry.find(modelName.slice(0, slash), modelName.slice(slash + 1)) : undefined; const restored = parentModel(ctx) === modelName || !!model && await pi.setModel(model); if (!restored) ctx.ui.notify(`ROOT ${rootAgent.name}: unable to restore model ${modelName}`, "warning"); pi.setActiveTools(rootTools(rootAgent)); ctx.ui.setStatus("agent-team", `Root: ${displayName(rootAgent.name)}${restored ? "" : " (model restore failed)"}`); } else pi.setActiveTools(TEAM_TOOLS); updateWidget();
		ctx.ui.setFooter((_tui, theme) => ({ dispose() {}, invalidate() {}, render(width: number) { const model = ctx.model?.id || "no-model"; const usage = ctx.getContextUsage(); const pct = usage?.percent ?? 0; const left = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + theme.fg("accent", rootAgent ? `@${rootAgent.name}` : "dynamic team"); const right = theme.fg("dim", `[${"#".repeat(Math.round(pct / 10))}${"-".repeat(10 - Math.round(pct / 10))}] ${Math.round(pct)}% `); return [truncateToWidth(left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + right, width)]; } }));
	});
}
