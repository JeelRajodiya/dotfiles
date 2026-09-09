import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelLabelSource } from "./config";
import {
	buildCacheReadLabel,
	buildCacheWriteLabel,
	buildContextLabel,
	buildCostLabel,
	buildTokenCountLabel,
	buildTokenLabel,
	formatProviderLabel,
	getUsageTotals,
} from "./format";
import type { GitStatusSummary } from "./git";
import type { PackageVersionResult } from "./package-version";
import type { RuntimeInfo } from "./runtime";
import type { FooterTelemetry } from "./telemetry";

export type FooterState = GitStatusSummary & {
	modelLabel: string;
	modelId: string;
	modelName: string;
	fast?: boolean;
	providerLabel: string;
	contextLabel: string;
	contextTokenLabel: string;
	tokenLabel: string;
	cacheReadLabel: string;
	cacheWriteLabel: string;
	costLabel: string;
	subscription: boolean;
	autoCompaction: boolean;
	runtime?: RuntimeInfo;
	packageVersion?: PackageVersionResult;
	sessionStartEpoch?: number;
};

export function createInitialState(gitDefaults: GitStatusSummary): FooterState {
	return {
		modelLabel: "no-model",
		modelId: "",
		modelName: "",
		providerLabel: "Unknown",
		contextLabel: "--",
		contextTokenLabel: "↑0 ↓0",
		tokenLabel: "↑0 ↓0",
		cacheReadLabel: "",
		cacheWriteLabel: "",
		costLabel: "$0.000",
		subscription: false,
		autoCompaction: false,
		runtime: undefined,
		packageVersion: undefined,
		sessionStartEpoch: Date.now(),
		...gitDefaults,
	};
}

export function modelLabelFor(
	state: Pick<FooterState, "modelId" | "modelName" | "fast">,
	source: ModelLabelSource,
): string {
	const label = source === "name"
		? state.modelName || state.modelId || "no-model"
		: state.modelId || "no-model";
	return state.fast ? `${label} (fast)` : label;
}

export function syncState(
	state: FooterState,
	ctx: ExtensionContext,
	cacheHitIcon: string,
	telemetry: FooterTelemetry = {},
): void {
	const totals = getUsageTotals(ctx);
	// One pass over the transcript: this runs on every footer refresh, and walking the whole
	// entry list twice for two independent lookups showed up on long sessions.
	const entries = ctx.sessionManager.getEntries();
	const seenSubagentUsage = new Set<string>();
	let subagentCost = 0;
	let fastEnabled = false;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "agent-team-usage") {
			const data = entry.data as { sourceEventId?: unknown; usage?: { cost?: { total?: unknown } } } | undefined;
			if (typeof data?.sourceEventId !== "string" || seenSubagentUsage.has(data.sourceEventId)) continue;
			seenSubagentUsage.add(data.sourceEventId);
			const cost = data.usage?.cost?.total;
			if (typeof cost === "number" && Number.isFinite(cost)) subagentCost += cost;
		} else if (entry.customType === "openai-fast") {
			// Last one wins, matching the previous findLast.
			fastEnabled = (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
		}
	}
	const m = ctx.model;
	state.modelId = m?.id ?? "";
	state.modelName = m?.name ?? "";
	state.fast = (m?.provider === "openai" || m?.provider === "openai-codex") && fastEnabled;
	// Retained as a compatibility snapshot only; production surfaces format from raw fields.
	state.modelLabel = modelLabelFor(state, "id");
	state.providerLabel = formatProviderLabel(ctx.model?.provider);
	state.contextLabel = buildContextLabel(ctx);
	state.contextTokenLabel = buildTokenCountLabel(totals);
	state.tokenLabel = buildTokenLabel(totals, cacheHitIcon);
	state.cacheReadLabel = buildCacheReadLabel(totals.cacheRead);
	state.cacheWriteLabel = buildCacheWriteLabel(totals.cacheWrite);
	state.costLabel = buildCostLabel({ ...totals, cost: totals.cost + subagentCost });
	state.subscription = telemetry.subscription === true;
	state.autoCompaction = telemetry.autoCompaction === true;
}
