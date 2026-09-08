import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

/** Local completion contract: developer-authored ASCII static key, at most 128 bytes; never user input or dynamic IDs. */
export type UsageAutocompleteItem = AutocompleteItem & { usageKey?: string };
const COMPLETION_EVENT_VERSION = 1;
const COMPLETION_USAGE_DAYS = 30;
export const MAX_COMPLETION_USAGE_KEYS = 2_000;

const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

export function completionUsageKey(item: Pick<UsageAutocompleteItem, "usageKey">): string | undefined {
	return typeof item.usageKey === "string" && /^[\x21-\x7e]{1,128}$/.test(item.usageKey) ? item.usageKey : undefined;
}

function isWithinDays(timestamp: unknown, days: number, now = new Date()): boolean {
	if (typeof timestamp !== "string") return false;
	const time = Date.parse(timestamp);
	return Number.isFinite(time) && time >= now.getTime() - days * 86_400_000 && time <= now.getTime();
}

export function completionEventForItem(item: UsageAutocompleteItem, now = new Date()): string | undefined {
	const key = completionUsageKey(item);
	return key ? JSON.stringify({ v: COMPLETION_EVENT_VERSION, type: "completion", key, timestamp: now.toISOString() }) : undefined;
}

export function parseUsageEvents(serialized: string, now = new Date(), isRecentCommand = (timestamp: unknown) => isWithinDays(timestamp, 31, now)) {
	const commands = new Map<string, number>();
	const completions = new Map<string, number>();
	for (const line of serialized.split("\n")) {
		try {
			const event = JSON.parse(line);
			if (!event || typeof event !== "object") continue;
			if (event.type === "command" && typeof event.key === "string" && isRecentCommand(event.timestamp)) increment(commands, event.key);
			if (event.type === "completion" && event.v === COMPLETION_EVENT_VERSION && typeof event.key === "string" &&
				completionUsageKey({ usageKey: event.key }) && isWithinDays(event.timestamp, COMPLETION_USAGE_DAYS, now) &&
				(completions.has(event.key) || completions.size < MAX_COMPLETION_USAGE_KEYS)) increment(completions, event.key);
		} catch {}
	}
	return { commands, completions };
}

/** Usage only breaks ties after fuzzy relevance; unannotated items retain their producer order. */
export function rankCompletionItems(items: UsageAutocompleteItem[], query: string, counts: Map<string, number>): UsageAutocompleteItem[] {
	if (!items.some(item => completionUsageKey(item))) return items;
	const ranked = items.map((item, index) => ({ item, index })).sort((a, b) =>
		(counts.get(completionUsageKey(b.item) ?? "") ?? 0) - (counts.get(completionUsageKey(a.item) ?? "") ?? 0) || a.index - b.index,
	).map(({ item }) => item);
	return fuzzyFilter(ranked, query, item => item.label ?? item.value);
}
