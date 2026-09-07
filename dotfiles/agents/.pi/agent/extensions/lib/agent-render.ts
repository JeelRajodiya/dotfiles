/**
 * Everything the agent-team widget draws. Pure functions over a view model, so the layout
 * can be exercised without spawning a child agent or standing up a Pi session.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentContext, formatAgentTokens, type TokenCounts } from "../agent-team-helpers";
import type { ActivityEntry } from "./agent-activity";

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
}

/** Card geometry. renderGrid pads short columns to CARD_LINES, so keep the two in step. */
export const CARD_LINES = 3;
export const MIN_CARD_WIDTH = 20;
export const CARD_GAP = 1;
export const FRAME_MS = 80;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_ICON: Record<string, string> = { waiting: "↗", done: "✓", error: "✗", idle: "○" };
const STATUS_COLOR: Record<string, string> = { running: "accent", waiting: "warning", done: "success", error: "error", idle: "dim" };
const ACTIVITY_GLYPH: Record<string, string> = { user: "▸", assistant: "·", "tool-start": "◆", "tool-done": "✓", "tool-error": "✗" };
const ACTIVITY_COLOR: Record<string, string> = { user: "accent", assistant: "text", "tool-start": "dim", "tool-done": "success", "tool-error": "error" };

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

export function agentHeading(agent: RenderableAgent, theme: Theme): string {
	const named = theme.bold(theme.fg("accent", agent.name));
	return agent.name.toLowerCase() === agent.def.name.toLowerCase()
		? named
		: named + theme.fg("dim", ` (${agent.def.name})`);
}

/**
 * One agent as a single-row card:
 *
 *   ╭─────────────────────────────╮
 *   │ ⠹ planner  42k/200k  7 · 14s│   glyph, name, context, tools · elapsed
 *   ╰─────────────────────────────╯
 *
 * Deliberately just identity and vitals. The goal and current task are prose that never fits
 * a column, so they live in the detail view, which keeps cards narrow enough to sit three across.
 */
export function renderCard(agent: RenderableAgent, width: number, theme: Theme, now?: number): string[] {
	const cardWidth = Math.max(MIN_CARD_WIDTH, width);
	const inner = cardWidth - 4;
	const rule = (left: string, right: string) => theme.fg("dim", left + "─".repeat(cardWidth - 2) + right);

	const label = agent.name.toLowerCase() === agent.def.name.toLowerCase() ? "" : theme.fg("dim", ` ${agent.def.name}`);
	const name = `${theme.fg(statusColor(agent.status), statusGlyph(agent.status, now))} ${theme.bold(theme.fg("accent", agent.name))}${label}`;
	const context = formatAgentContext(agent.contextTokens, agent.contextWindow);
	const tokens = formatAgentTokens(agent.tokens);
	const usage = `${theme.fg(contextColor(agent), context)} ${theme.fg("dim", tokens)}`;
	const trailing = [
		agent.toolCount || "",
		agent.status === "waiting" ? agent.pendingOutcome === "error" ? "return error" : "returning" : "",
		agent.status === "running" || agent.elapsed ? `${Math.round(agent.elapsed / 1000)}s` : "",
	].filter(Boolean).join(" · ");

	// The name gives up width first so the context figure always survives on a narrow card.
	const nameWidth = Math.max(3, inner - visibleWidth(usage) - visibleWidth(trailing) - (trailing ? 4 : 2));
	const content = spread(
		`${truncateToWidth(name, nameWidth)}  ${usage}`,
		theme.fg("dim", trailing),
		inner,
	);
	const row = theme.fg("dim", "│") + " " + content + " ".repeat(Math.max(0, inner - visibleWidth(content))) + " " + theme.fg("dim", "│");
	return [rule("╭", "╮"), row, rule("╰", "╯")].map(line => truncateToWidth(line, cardWidth));
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

/** The expanded single-agent view behind `/agents detail <name>`, where prose has room. */
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

	const activity = options.activity.map(entry => truncateToWidth(
		`  ${theme.fg(ACTIVITY_COLOR[entry.kind] ?? "muted", ACTIVITY_GLYPH[entry.kind] ?? "·")} ` +
		theme.fg(entry.kind === "assistant" ? "text" : "muted", entry.text),
		width,
	));

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
