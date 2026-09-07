import { existsSync, readFileSync } from "node:fs";

export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const values = usage as Record<string, unknown>;
	if (typeof values.totalTokens === "number" && Number.isFinite(values.totalTokens)) {
		return Math.max(0, values.totalTokens);
	}
	const parts = ["input", "output", "cacheRead", "cacheWrite"]
		.map(key => values[key])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return parts.length > 0 ? parts.reduce((sum, value) => sum + Math.max(0, value), 0) : undefined;
}

export function latestAssistantContextTokens(sessionFile: string): number | undefined {
	if (!existsSync(sessionFile)) return undefined;
	let latest: number | undefined;
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const tokens = contextTokensFromUsage(entry.message.usage);
			if (tokens !== undefined) latest = tokens;
		} catch {}
	}
	return latest;
}

export function hasRunningAgent(states: Iterable<{ status: string }>): boolean {
	return Array.from(states).some(state => state.status === "running");
}
