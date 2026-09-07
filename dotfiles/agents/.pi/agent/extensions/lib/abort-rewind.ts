export type SessionEntry = { id?: string; parentId?: string | null; type: string };

export const canRewind = (aborted: boolean, mutated: boolean) => aborted && !mutated;

export const dropAbandonedTurn = (entries: SessionEntry[], rootId: string) => {
	const removed = new Set([rootId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of entries) {
			if (entry.id && removed.has(entry.parentId ?? "") && !removed.has(entry.id)) {
				removed.add(entry.id);
				changed = true;
			}
		}
	}
	return entries.filter(entry => !entry.id || !removed.has(entry.id));
};
