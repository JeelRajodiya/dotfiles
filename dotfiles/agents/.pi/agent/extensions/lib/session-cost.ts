/**
 * Shared, incrementally cached reader for Pi's session JSONL files.
 *
 * monthly-cost.ts and usage-ranking.ts aggregate the same files in different
 * ways. Reading and parsing is the expensive part and history only grows, so
 * each file is parsed once and re-parsed only when its size or mtime moves.
 *
 * Not an extension: Pi only auto-loads `extensions/*.ts` and
 * `extensions/<dir>/index.ts`, so nothing under `extensions/lib/` is loaded.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SessionRecord =
	| { type: "model_change"; model: string }
	| { type: "entry"; entryType: string; iso: string; role?: string; model?: string; cost?: number };

type CacheEntry = { mtimeMs: number; size: number; records: SessionRecord[] };

const cache = new Map<string, CacheEntry>();

/** Parse one session file. Per-line recovery: a truncated entry must not discard the rest of the file. */
export function parseSessionLines(text: string): SessionRecord[] {
	const records: SessionRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
				records.push({ type: "model_change", model: `${entry.provider}/${entry.modelId}` });
				continue;
			}
			if (typeof entry?.timestamp !== "string") continue;
			const message = entry.message;
			const cost = message?.usage?.cost?.total;
			records.push({
				type: "entry",
				entryType: typeof entry.type === "string" ? entry.type : "",
				iso: entry.timestamp,
				role: typeof message?.role === "string" ? message.role : undefined,
				model: typeof message?.provider === "string" && typeof message?.model === "string"
					? `${message.provider}/${message.model}`
					: undefined,
				cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
			});
		} catch {}
	}
	return records;
}

/** Records for every session file, re-parsing only the files that changed since the last call. */
export async function loadSessions(): Promise<SessionRecord[][]> {
	const sessionsDir = join(getAgentDir(), "sessions");
	let files: string[];
	try {
		files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const live = new Set<string>();
	const sessions = await Promise.all(files.map(async file => {
		const path = join(sessionsDir, file);
		live.add(path);
		try {
			const stats = await stat(path);
			const cached = cache.get(path);
			if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.records;
			const records = parseSessionLines(await readFile(path, "utf8"));
			cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, records });
			return records;
		} catch {
			return [];
		}
	}));
	for (const path of [...cache.keys()]) if (!live.has(path)) cache.delete(path);
	return sessions;
}
