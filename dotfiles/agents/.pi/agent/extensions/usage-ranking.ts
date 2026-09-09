import {
	DynamicBorder,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSessions, type SessionRecord } from "./lib/session-cost.ts";
import { completionEventForItem, completionUsageKey, MAX_COMPLETION_USAGE_KEYS, parseUsageEvents, rankCompletionItems, type UsageAutocompleteItem } from "./lib/completion-usage.ts";

const usageFile = join(getAgentDir(), "usage-ranking.jsonl");
const monthlyModelUsage = new Map<string, number>();
const commandUsage = new Map<string, number>();
const completionUsage = new Map<string, number>();

const increment = (counts: Map<string, number>, key: string, amount = 1) =>
	counts.set(key, (counts.get(key) ?? 0) + amount);

const modelKey = (model: Pick<Model<any>, "provider" | "id">) => `${model.provider}/${model.id}`;

const disabledModelsFile = join(getAgentDir(), "states", "disabled-models.json");

/** Throws on a corrupt file so a toggle never overwrites a list it could not read. */
function readDisabledModels(): Set<string> {
	try {
		const data = JSON.parse(readFileSync(disabledModelsFile, "utf8"));
		if (!Array.isArray(data) || data.some(key => typeof key !== "string"))
			throw new Error("disabled-models.json must contain an array of model keys");
		return new Set(data);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw error;
	}
}

/**
 * Never throws. A corrupt disabled-models.json must not take down model selection or
 * session start, and "nothing disabled" fails open rather than hiding every model.
 */
function loadDisabledModels(): Set<string> {
	try {
		return readDisabledModels();
	} catch {
		return new Set();
	}
}

function enabledModels(ctx: ExtensionContext): Model<any>[] {
	const disabled = loadDisabledModels();
	return ctx.modelRegistry.getAvailable().filter(model => !disabled.has(modelKey(model)));
}

// The usage log is append-only and read on every "/" keystroke, so re-read it only when
// another process has actually changed it. Our own appends refresh the stamp in place.
let usageStamp = "";
const usageFileStamp = () => {
	try {
		const stats = statSync(usageFile);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "";
	}
};

function loadUsage() {
	const stamp = usageFileStamp();
	if (stamp && stamp === usageStamp) return;
	commandUsage.clear();
	completionUsage.clear();
	mkdirSync(getAgentDir(), { recursive: true });
	try {
		const events = parseUsageEvents(readFileSync(usageFile, "utf8"), new Date(), timestamp => isInMonths(timestamp));
		for (const [key, count] of events.commands) commandUsage.set(key, count);
		for (const [key, count] of events.completions) completionUsage.set(key, count);
	} catch {}
	usageStamp = stamp;
}

export function commandFromText(text: string): string | undefined {
	const skill = text.trimStart().match(/^<skill\s+name="([^"]+)"/);
	return skill ? `skill:${skill[1]}` : text.trim().match(/^\/([^\s]+)/)?.[1];
}

function recordCommand(key: string) {
	increment(commandUsage, key);
	// ponytail: append-only avoids cross-process lost updates; compact if this reaches megabytes.
	appendFileSync(usageFile, `${JSON.stringify({ type: "command", key, timestamp: new Date().toISOString() })}\n`);
	// Already counted in memory: adopt the new stamp so the next read is not a needless reparse.
	usageStamp = usageFileStamp();
}

function recordCompletion(item: UsageAutocompleteItem) {
	const event = completionEventForItem(item);
	const key = completionUsageKey(item);
	if (!event || !key || (!completionUsage.has(key) && completionUsage.size >= MAX_COMPLETION_USAGE_KEYS)) return;
	increment(completionUsage, key);
	appendFileSync(usageFile, `${event}\n`);
	usageStamp = usageFileStamp();
}

export function rank<T>(items: T[], counts: Map<string, number>, key: (item: T) => string, query = "", text = key): T[] {
	const ranked = items
		.map((item, index) => ({ item, index }))
		.sort((a, b) =>
			(counts.get(key(b.item)) ?? 0) - (counts.get(key(a.item)) ?? 0) || a.index - b.index,
		)
		.map(({ item }) => item);
	// Stable fuzzy sorting keeps usage as a tie-breaker, never above match quality.
	return fuzzyFilter(ranked, query, text);
}

export function commandSearchText(value: string, query: string): string {
	const explicitSkill = "skill:".startsWith(query.toLowerCase()) || query.toLowerCase().startsWith("skill:");
	return explicitSkill ? value : value.replace(/^skill:/, "");
}

export function isInMonths(timestamp: unknown, months = 1, now = new Date()): boolean {
	if (typeof timestamp !== "string") return false;
	const date = new Date(timestamp);
	const start = new Date(now);
	start.setDate(1);
	start.setMonth(start.getMonth() - months);
	const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
	start.setDate(Math.min(now.getDate(), lastDay));
	return date >= start && date <= now;
}

export function scanSession(records: SessionRecord[], counts?: Map<string, number>, costs?: Map<string, number>, requests?: Map<string, number>, months = 1, now = new Date()) {
	let activeModel: string | undefined;
	for (const record of records) {
		if (record.type === "model_change") { activeModel = record.model; continue; }
		if (record.entryType !== "message" || !isInMonths(record.iso, months, now)) continue;
		if (counts && record.role === "user" && activeModel) increment(counts, activeModel);
		if (requests && record.role === "assistant" && record.model) increment(requests, record.model);
		if (costs && record.role === "assistant" && record.model && record.cost !== undefined)
			increment(costs, record.model, record.cost);
	}
}

// Deferred: a synchronous scan of every session file at import time sits on Pi's startup
// path and grows with history. The first consumer awaits it, later ones reuse the result.
let monthlyUsageLoad: Promise<void> | undefined;
function ensureMonthlyUsage(): Promise<void> {
	monthlyUsageLoad ??= (async () => {
		for (const records of await loadSessions()) scanSession(records, monthlyModelUsage);
	})().catch(() => {});
	return monthlyUsageLoad;
}

type MonthlyStats = {
	counts: Map<string, number>; costs: Map<string, number>; requests: Map<string, number>;
	ratioCounts: Map<string, number>; ratioRequests: Map<string, number>;
};

async function loadMonthlyStats(): Promise<MonthlyStats> {
	const counts = new Map<string, number>();
	const requests = new Map<string, number>();
	const costs = new Map<string, number>();
	const ratioCounts = new Map<string, number>();
	const ratioRequests = new Map<string, number>();
	const now = new Date();
	for (const records of await loadSessions()) {
		scanSession(records, counts, costs, requests, 1, now);
		scanSession(records, ratioCounts, undefined, ratioRequests, 2, now);
	}
	return { counts, costs, requests, ratioCounts, ratioRequests };
}

export function requestsPerMessage(requests: number, messages: number): string {
	return messages > 0 ? `${(requests / messages).toFixed(1)} req/msg` : "req/msg n/a";
}

export function alignColumns(rows: string[][]): string[] {
	const widths = rows[0].map((_, column) => Math.max(...rows.map(row => visibleWidth(row[column]))));
	return rows.map(row => row.map((cell, column) => {
		const padding = " ".repeat(widths[column] - visibleWidth(cell));
		return column === 0 || rows[0][column] === "Status" ? cell + padding : padding + cell;
	}).join("  "));
}

class ModelPicker implements Component, Focusable {
	private readonly input = new Input();
	private readonly container = new Container();
	private filtered: Model<any>[] = [];
	private selected = 0;
	private disabled = loadDisabledModels();
	private error = "";
	private _focused = false;

	get focused() { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }

	private readonly models: Model<any>[];
	private readonly stats: MonthlyStats;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (model?: Model<any>) => void;

	// Plain fields: Node's strip-only TypeScript mode rejects parameter properties.
	constructor(
		models: Model<any>[],
		stats: MonthlyStats,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (model?: Model<any>) => void,
		initialQuery = "",
	) {
		this.models = models;
		this.stats = stats;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.input.setValue(initialQuery);
		this.update();
	}

	private update() {
		const query = this.input.getValue();
		this.filtered = rank<Model<any>>(this.models, this.stats.counts, modelKey, query,
			model => `${model.provider} ${model.id} ${model.name}`);
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
		this.container.clear();
		this.container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Select model · past month")), 1, 0));
		this.container.addChild(this.input);
		this.container.addChild(new Spacer(1));
		// Size against the whole catalogue so columns don't move while filtering or scrolling.
		const rows = alignColumns([
			["Model", "Msg", "Req", "Req/msg (2mo)", "Cost (est.)", "Input / 1M", "Status"],
			...this.models.map(model => {
				const key = modelKey(model);
				const cost = this.stats.costs.get(key);
				return [key, String(this.stats.counts.get(key) ?? 0), String(this.stats.requests.get(key) ?? 0),
					requestsPerMessage(this.stats.ratioRequests.get(key) ?? 0, this.stats.ratioCounts.get(key) ?? 0).replace("req/msg", "").trim(),
					cost === undefined ? "n/a" : `$${cost.toFixed(2)}`, `$${model.cost.input}`,
					this.theme.fg(this.disabled.has(key) ? "error" : "success", this.disabled.has(key) ? "disabled" : "enabled")];
			}),
		]);
		const modelRows = new Map(this.models.map((model, index) => [modelKey(model), rows[index + 1]]));
		this.container.addChild(new Text(this.theme.fg("dim", `  ${rows[0]}`), 0, 0));
		const start = Math.max(0, Math.min(this.selected - 5, this.filtered.length - 10));
		for (let index = start; index < Math.min(start + 10, this.filtered.length); index++) {
			const key = modelKey(this.filtered[index]!);
			const prefix = index === this.selected ? "→ " : "  ";
			const text = `${prefix}${modelRows.get(key)}`;
			this.container.addChild(new Text(index === this.selected ? this.theme.fg("accent", text) : text, 0, 0));
		}
		if (this.error) this.container.addChild(new Text(this.theme.fg("error", this.error), 1, 0));
		if (!this.filtered.length) this.container.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
		this.container.addChild(new Spacer(1));
		this.container.addChild(new Text(this.theme.fg("dim", "↑↓ navigate · space enable/disable · enter select · esc close"), 1, 0));
		this.container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
	}

	handleInput(data: string) {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = this.filtered.length ? (this.selected - 1 + this.filtered.length) % this.filtered.length : 0;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = this.filtered.length ? (this.selected + 1) % this.filtered.length : 0;
		} else if (matchesKey(data, "space")) {
			const model = this.filtered[this.selected];
			if (model) {
				try {
					// Strict read here: writing back a fallback would erase a list we failed to parse.
					const disabled = readDisabledModels();
					const key = modelKey(model);
					if (disabled.has(key)) disabled.delete(key);
					else disabled.add(key);
					writeFileSync(disabledModelsFile, `${JSON.stringify([...disabled], null, 2)}\n`);
					this.disabled = disabled;
					this.error = "";
				} catch (error) {
					this.error = `Cannot save model status: ${String(error)}`;
				}
			}
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const model = this.filtered[this.selected];
			if (model && this.disabled.has(modelKey(model))) {
				this.error = "Press space to enable this model before selecting it";
			} else {
				this.done(model);
				return;
			}
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		} else {
			this.input.handleInput(data);
			this.selected = 0;
		}
		this.update();
		this.tui.requestRender();
	}

	render(width: number) { return this.container.render(width).map(line => truncateToWidth(line, width, "")); }
	invalidate() { this.update(); this.container.invalidate(); }
}

export function completedModelQuery(submitting: boolean, lines: string[]): string | undefined {
	if (!submitting) return;
	const match = lines.join("\n").trim().match(/^\/model(?:\s+(.*))?$/);
	return match ? match[1] ?? "" : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", event => {
		const command = commandFromText(event.prompt);
		if (command?.startsWith("skill:")) recordCommand(command);
	});
	let sessionGeneration = 0;
	pi.on("session_shutdown", () => { sessionGeneration++; });
	let pickerOpen = false;
	const showPicker = async (ctx: ExtensionContext, query = "") => {
		if (pickerOpen || ctx.mode !== "tui") return;
		pickerOpen = true;
		const generation = sessionGeneration;
		ctx.ui.setEditorText("");
		try {
			const stats = await loadMonthlyStats();
			if (generation !== sessionGeneration) return;
			const model = await ctx.ui.custom<Model<any> | undefined>((tui, theme, keybindings, done) =>
				new ModelPicker(ctx.modelRegistry.getAvailable(), stats, tui, theme, keybindings, done, query),
			);
			if (generation !== sessionGeneration) return;
			if (model && !await pi.setModel(model) && generation === sessionGeneration) ctx.ui.notify(`No authentication for ${modelKey(model)}`, "error");
		} catch (error) {
			if (generation === sessionGeneration) ctx.ui.notify(`Model picker: ${String(error)}`, "error");
		} finally {
			pickerOpen = false;
		}
	};

	let cycleQueue = Promise.resolve();
	const cycleModel = (ctx: ExtensionContext, direction: 1 | -1) => {
		const generation = sessionGeneration;
		cycleQueue = cycleQueue.then(async () => {
			if (generation !== sessionGeneration) return;
			await ensureMonthlyUsage();
			if (generation !== sessionGeneration) return;
			const models = rank<Model<any>>(enabledModels(ctx), monthlyModelUsage, modelKey);
			if (!models.length) {
				ctx.ui.notify("No enabled models; use /model to enable one", "warning");
				return;
			}
			const current = models.findIndex(model => ctx.model && modelKey(model) === modelKey(ctx.model));
			const next = models[current < 0 ? (direction === 1 ? 0 : models.length - 1) : (current + direction + models.length) % models.length];
			if (next && !await pi.setModel(next) && generation === sessionGeneration) ctx.ui.notify(`No authentication for ${modelKey(next)}`, "error");
		}).catch(error => {
			if (generation === sessionGeneration) ctx.ui.notify(`Model cycle: ${String(error)}`, "error");
		});
		return cycleQueue;
	};

	pi.registerShortcut("ctrl+p", {
		description: "Cycle usage-ranked models forward",
		handler: ctx => cycleModel(ctx, 1),
	});
	pi.registerShortcut("shift+ctrl+p", {
		description: "Cycle usage-ranked models backward",
		handler: ctx => cycleModel(ctx, -1),
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model) increment(monthlyModelUsage, modelKey(ctx.model));
	});

	pi.on("session_start", async (event, ctx) => {
		sessionGeneration++;
		if (ctx.mode !== "tui") return;
		const generation = sessionGeneration;
		loadUsage();
		try {
			readDisabledModels();
		} catch (error) {
			ctx.ui.notify(`Ignoring disabled-models.json: ${String(error)}`, "warning");
		}
		const explicitModel = process.argv.some(arg => /^(--model|--provider)(=|$)/.test(arg));
		const freshSession = !ctx.sessionManager.getEntries().some(entry => entry.type === "message");
		if (event.reason === "new" || (event.reason === "startup" && freshSession && !explicitModel)) {
			await ensureMonthlyUsage();
			const first = rank<Model<any>>(enabledModels(ctx), monthlyModelUsage, modelKey)[0];
			if (first && generation === sessionGeneration && !await pi.setModel(first))
				ctx.ui.notify(`No authentication for ${modelKey(first)}`, "error");
		}
		const knownCommands = new Set([...pi.getCommands().map(command => command.name), "reload", "quit", "exit"]);
		let submitting = false;
		let recordedCommand: string | undefined;
		const recordSubmission = (command: string | undefined) => {
			if (!command || command.startsWith("skill:") || recordedCommand === command) return;
			recordCommand(command);
			recordedCommand = command;
		};

		ctx.ui.addAutocompleteProvider(current => ({
			triggerCharacters: current.triggerCharacters,
			async getSuggestions(lines, line, col, options) {
				const result = await current.getSuggestions(lines, line, col, options);
				if (!result) return result;
				const beforeCursor = (lines[line] ?? "").slice(0, col);
				if (/^\/[^ ]*$/.test(beforeCursor)) {
					loadUsage();
					for (const item of result.items) knownCommands.add(item.value);
					const query = beforeCursor.slice(1);
					result.items = rank(result.items, commandUsage, item => item.value, query,
						item => commandSearchText(item.value, query));
				} else if (beforeCursor.startsWith("/model ") && !beforeCursor.slice(7).trim()) {
					// Typed model searches retain the provider's relevance order (including display-name matches).
					await ensureMonthlyUsage();
					result.items = rank(result.items, monthlyModelUsage, item => item.value);
				}
				const completionQuery = result.prefix.trim().split(/\s+/).at(-1) ?? "";
				result.items = rankCompletionItems(result.items as UsageAutocompleteItem[], completionQuery, completionUsage);
				return result;
			},
			applyCompletion: (lines, line, col, item: AutocompleteItem, prefix) => {
				// Only the optional static usageKey is persisted; never selected display/value text.
				recordCompletion(item as UsageAutocompleteItem);
				const result = current.applyCompletion(lines, line, col, item, prefix);
				if (submitting) recordSubmission(commandFromText(result.lines.join("\n")));
				const query = completedModelQuery(submitting, result.lines);
				if (query !== undefined) {
					const generation = sessionGeneration;
					queueMicrotask(() => {
						if (generation !== sessionGeneration) return;
						showPicker(ctx, query);
					});
					return { lines: [""], cursorLine: 0, cursorCol: 0 };
				}
				return result;
			},
			shouldTriggerFileCompletion: (lines, line, col) =>
				current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
		}));

		ctx.ui.onTerminalInput(data => {
			submitting = matchesKey(data, "enter");
			if (!submitting || pickerOpen) return;
			recordedCommand = undefined;
			const text = ctx.ui.getEditorText().trim();
			const match = text.match(/^\/([^\s]+)(?:\s+(.*))?$/);
			if (!match) return;
			const [, command, args = ""] = match;

			if (command === "model" && (!args || !ctx.modelRegistry.getAvailable().some(model => modelKey(model) === args))) {
				recordSubmission(command);
				showPicker(ctx, args);
				return { consume: true };
			}

			// Persist before /reload or /exit invalidates the extension context.
			if (knownCommands.has(command)) recordSubmission(command);
		});
	});
}
