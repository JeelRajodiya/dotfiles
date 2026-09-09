import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSessions } from "./lib/session-cost.ts";

/** UTC: record.iso is a UTC stamp, so a local-time prefix misfiles entries near a boundary. */
export function monthPrefix(now = new Date()): string {
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function monthlyCost(now = new Date()): Promise<number> {
	const month = monthPrefix(now);
	let total = 0;
	for (const records of await loadSessions()) {
		for (const record of records) {
			if (record.type === "entry" && record.iso.startsWith(month)) total += record.cost ?? 0;
		}
	}
	return total;
}

export default function (pi: ExtensionAPI) {
	let pending: Promise<void> | undefined;

	// agent_settled can fire again before a cold scan finishes; one scan at a time is enough.
	const update = (ctx: any) => {
		if (pending) return pending;
		pending = (async () => {
			try {
				const cost = await monthlyCost();
				ctx.ui.setStatus("monthly-cost", ctx.ui.theme.fg("success", `$${cost.toFixed(2)} (this month)`));
			} catch {
				ctx.ui.setStatus("monthly-cost", ctx.ui.theme.fg("dim", "cost unavailable"));
			} finally {
				pending = undefined;
			}
		})();
		return pending;
	};

	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("agent_settled", (_event, ctx) => update(ctx));
}
