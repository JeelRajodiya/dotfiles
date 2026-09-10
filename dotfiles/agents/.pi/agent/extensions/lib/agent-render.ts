/**
 * Everything the agent-team widget draws. Pure functions over a view model, so the layout
 * can be exercised without spawning a child agent or standing up a Pi session.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentModelLabel, formatAgentContext, formatAgentTokens, type TokenCounts } from "../agent-team-helpers.ts";
import { activityStartedAt, formatActivityDuration, isActivityRunning, thoughtActivityLabel, type ActivityEntry } from "./agent-activity.ts";

export type AgentStatus = "idle" | "running" | "waiting" | "done" | "error";

/** The subset of an agent's state that drawing depends on. AgentState satisfies this structurally. */
export interface RenderableAgent {
	name: string;
	def: { name: string; description: string };
	goal: string;
	task: string;
	status: AgentStatus;
	toolCount: number;
	elapsed: number;
	contextTokens: number;
	contextWindow: number;
	tokens: TokenCounts;
	pendingOutcome?: "done" | "error";
	model: string;
	fast?: boolean;
	thinking?: string;
}

/** Card geometry. renderGrid pads short columns to CARD_LINES, so keep the two in step. */
export const CARD_LINES = 4;
export const MIN_CARD_WIDTH = 20;
export const CARD_GAP = 1;
export const FRAME_MS = 80;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_ICON: Record<string, string> = { waiting: "↗", done: "✓", error: "✗", idle: "○" };
const STATUS_COLOR: Record<string, string> = { running: "accent", waiting: "warning", done: "success", error: "error", idle: "dim" };
/** Live counters get a colour nothing else in the pane uses, so an in-flight row is findable
 * without reading it. A running command and a finished one are otherwise the same dim line. */
const LIVE_COLOR = "warning";
const ACTIVITY_COLOR: Record<string, string> = { user: "accent", assistant: "text", thought: "muted", "tool-start": "dim", "tool-done": "success", "tool-error": "error" };

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

export const spinnerFrame = (now = Date.now()) => SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length];
const statusColor = (status: AgentStatus) => STATUS_COLOR[status] ?? "dim";
const statusGlyph = (status: AgentStatus, now?: number) =>
	status === "running" ? spinnerFrame(now) : STATUS_ICON[status] ?? "○";

/**
 * Colour the context figure by how full the window is, so it reads at a glance without a meter.
 * An untouched agent stays muted rather than "healthy green", which would be noise on every card.
 */
export function contextColor(agent: Pick<RenderableAgent, "contextTokens" | "contextWindow">): string {
	if (!agent.contextTokens || agent.contextWindow <= 0) return "muted";
	const fraction = agent.contextTokens / agent.contextWindow;
	return fraction > 0.9 ? "error" : fraction > 0.7 ? "warning" : "success";
}

/** Left text, right text, flush to `width`; drops the right side when there is no room for both. */
export function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap < 1 ? truncateToWidth(left, width) : left + " ".repeat(gap) + right;
}

/** "understand-a" reads as "Understand A": the dash is a key separator, not something to look at. */
export const displayName = (name: string) => name.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export function agentHeading(agent: RenderableAgent, theme: Theme): string {
	const named = theme.bold(theme.fg("accent", displayName(agent.name)));
	return agent.name.toLowerCase() === agent.def.name.toLowerCase()
		? named
		: named + theme.fg("dim", ` (${agent.def.name})`);
}

/**
 * One agent as a compact four-line card: identity/vitals and usage/model always get a row each.
 */
export function renderCard(agent: RenderableAgent, width: number, theme: Theme, now?: number): string[] {
	const cardWidth = Math.max(MIN_CARD_WIDTH, width);
	const inner = cardWidth - 4;
	const rule = (left: string, right: string) => theme.fg("dim", left + "─".repeat(cardWidth - 2) + right);
	const row = (content: string) => theme.fg("dim", "│") + " " + truncateToWidth(content, inner) + " ".repeat(Math.max(0, inner - visibleWidth(content))) + " " + theme.fg("dim", "│");

	const label = agent.name.toLowerCase() === agent.def.name.toLowerCase() ? "" : theme.fg("dim", ` ${agent.def.name}`);
	const name = `${theme.fg(statusColor(agent.status), statusGlyph(agent.status, now))} ${theme.bold(theme.fg("accent", agent.name))}${label}`;
	const context = theme.fg(contextColor(agent), formatAgentContext(agent.contextTokens, agent.contextWindow));
	const waiting = agent.status === "waiting" ? agent.pendingOutcome === "error" ? "return error" : "returning" : "";
	const elapsed = agent.status === "running" || agent.elapsed ? `${Math.round(agent.elapsed / 1000)}s` : "";
	const telemetry = [agent.toolCount || "", waiting, elapsed].filter(Boolean).join(" · ");
	// On narrow cards, keep the waiting/elapsed state before a tool count that would crowd it out.
	const vital = visibleWidth(telemetry) <= inner - 4 ? telemetry : waiting || elapsed || truncateToWidth(String(agent.toolCount), Math.max(1, inner - 4));
	const identityLeft = `${name} ${context}`;
	const tokens = formatAgentTokens(agent.tokens);
	const model = `${formatAgentModelLabel(agent.model, agent.fast)} · ${agent.thinking ?? "off"}`;
	const identityWidth = Math.max(1, inner - visibleWidth(vital) - 1);
	const compactIdentity = visibleWidth(identityLeft) <= identityWidth ? identityLeft
		: `${theme.fg(statusColor(agent.status), statusGlyph(agent.status, now))} ${theme.bold(theme.fg("accent", truncateToWidth(agent.name, Math.max(1, identityWidth - 2))))}`;
	const identity = vital ? spread(compactIdentity, vital, inner) : truncateToWidth(identityLeft, inner);
	// At three 26-column cards, bare arrows make room for the complete fast model label.
	const usage = `${visibleWidth(`${tokens} ${model}`) <= inner ? tokens : "↑↓"} ${model}`;
	return [rule("╭", "╮"), row(identity), row(theme.fg("dim", usage)), rule("╰", "╯")].map(line => truncateToWidth(line, cardWidth));
}

/** Lay cards out in up to `columns` columns, dropping to fewer when the terminal is narrow. */
export function renderGrid(agents: RenderableAgent[], width: number, columns: number, theme: Theme, now?: number): string[] {
	const renderWidth = Math.max(1, width);
	if (!agents.length) return [];
	const maxColumns = Math.max(1, Math.floor((renderWidth + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP)));
	const cols = Math.min(columns, agents.length, maxColumns);
	const cardWidth = Math.max(MIN_CARD_WIDTH, Math.floor((renderWidth - CARD_GAP * (cols - 1)) / cols));
	const rows: string[] = [];
	for (let index = 0; index < agents.length; index += cols) {
		const cards = agents.slice(index, index + cols).map(agent => renderCard(agent, cardWidth, theme, now));
		while (cards.length < cols) cards.push(Array(CARD_LINES).fill(" ".repeat(cardWidth)));
		for (let line = 0; line < CARD_LINES; line++)
			rows.push(truncateToWidth(cards.map(card => card[line]).join(" ".repeat(CARD_GAP)), renderWidth));
	}
	return rows;
}

export function renderEmpty(width: number, theme: Theme): string {
	return theme.fg("dim", truncateToWidth("○ No instances · /agents add <type> [name] to build a team", Math.max(1, width)));
}

export interface DetailOptions {
	model: string;
	activity: ActivityEntry[];
	steerable: boolean;
}

export function renderThoughtActivity(entry: ActivityEntry, width: number, now?: number): string {
	return truncateToWidth(thoughtActivityLabel(entry, now).replace(/\s+/g, " ").trim(), width, "…");
}

/** One activity row. In-flight rows lead with a live elapsed counter; finished rows do not. */
export function renderActivityLine(entry: ActivityEntry, width: number, theme: Theme, now = Date.now()): string {
	const body = (entry.kind === "thought" ? thoughtActivityLabel(entry, now) : entry.text).replace(/\s+/g, " ").trim();
	const color = entry.kind === "assistant" ? "text" : (ACTIVITY_COLOR[entry.kind] ?? "muted");
	if (!isActivityRunning(entry)) return theme.fg(color, truncateToWidth(body, width, "…"));
	const counter = formatActivityDuration(Math.max(0, now - (activityStartedAt(entry) ?? now)));
	return `${theme.fg(LIVE_COLOR, counter)} ${theme.fg(color, truncateToWidth(body, Math.max(1, width - visibleWidth(counter) - 1), "…"))}`;
}

/** The expanded single-agent view behind `/agents view <name>`, where prose has room. */
export function renderDetail(agent: RenderableAgent, width: number, theme: Theme, options: DetailOptions, now?: number): string {
	const line = (value: string) => truncateToWidth(value, width);
	const indent = (value: string) => truncateToWidth(`  ${value}`, width);
	// Headings are literals but still need clamping: "Recent activity" overflows a narrow pane.
	const heading = (value: string) => theme.bold(theme.fg("accent", truncateToWidth(value, width)));
	const context = formatAgentContext(agent.contextTokens, agent.contextWindow);
	const meta = [
		agent.status === "waiting" && agent.pendingOutcome ? `${agent.status} (${agent.pendingOutcome} queued)` : agent.status,
		options.model,
		`${Math.round(agent.elapsed / 1000)}s`,
	].join(" · ");

	const activity = options.activity.map(entry => renderActivityLine(entry, width, theme, now));

	return [
		line(`${theme.fg(statusColor(agent.status), statusGlyph(agent.status, now))} ${agentHeading(agent, theme)}  ${theme.fg(contextColor(agent), context)}`),
		theme.fg("dim", line(meta)),
		"",
		heading("Goal"), theme.fg("muted", indent(agent.goal || agent.def.description)),
		"",
		heading("Current task"), theme.fg(agent.task ? "text" : "muted", indent(agent.task || "No active task.")),
		"",
		heading("Recent activity"), activity.join("\n") || theme.fg("muted", indent("No recent activity.")),
		"",
		theme.fg("dim", line(options.steerable
			? "Type a message to steer this agent · /agents exit to close"
			: "/agents exit to close")),
	].join("\n");
}
