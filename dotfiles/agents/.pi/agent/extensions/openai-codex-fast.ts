import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPENAI_FAST_ENV, OPENAI_FAST_SESSION_EVENT, parseOpenAIFastEnvValue } from "./agent-team-helpers.ts";

const preferenceFile = join(getAgentDir(), "states", "openai-fast.json");
const STATE_TYPE = "openai-fast";
const SESSION_STATE_TYPE = "openai-fast-session";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function openAICodexFast(pi: ExtensionAPI) {
	let enabled = false;
	let sessionOverride: boolean | undefined;
	const effectiveFast = () => sessionOverride ?? enabled;
	const publish = () => {
		const effective = effectiveFast();
		pi.appendEntry(STATE_TYPE, { enabled: effective });
		pi.events.emit("openai-fast:changed", { enabled: effective });
	};

	pi.events.on(OPENAI_FAST_SESSION_EVENT, (event: unknown) => {
		const value = isRecord(event) ? event.enabled : undefined;
		if (value !== undefined && typeof value !== "boolean") return;
		sessionOverride = typeof value === "boolean" ? value : undefined;
		pi.appendEntry(SESSION_STATE_TYPE, { enabled: value ?? null });
		publish();
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		sessionOverride = undefined;
		const override = parseOpenAIFastEnvValue(process.env[OPENAI_FAST_ENV]);
		if (override === undefined) {
			try {
				const saved = JSON.parse(readFileSync(preferenceFile, "utf8"));
				if (typeof saved?.enabled === "boolean") enabled = saved.enabled;
			} catch (error) {
				// A missing file just means "never toggled" — only report real read failures.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					ctx.ui.notify(`Cannot read fast-mode preference: ${String(error)}`, "warning");
				}
			}
		} else {
			enabled = override;
		}

		// Unknown values are ignored so normal sessions stay file-driven, while child sessions
		// that set the env var without `on|off` can still proceed.
		if (process.env[OPENAI_FAST_ENV] !== undefined && override === undefined) {
			ctx.ui.notify(`Invalid ${OPENAI_FAST_ENV} value; expected "on" or "off"`, "warning");
		}
		const savedSession = (ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>)
			.filter(entry => entry.type === "custom" && entry.customType === SESSION_STATE_TYPE).at(-1)?.data;
		if (isRecord(savedSession) && typeof savedSession.enabled === "boolean") sessionOverride = savedSession.enabled;
		publish();
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI priority mode (remembered across sessions); /fast [on|off]",
		handler: async (args, ctx) => {
			const inheritedFast = parseOpenAIFastEnvValue(process.env[OPENAI_FAST_ENV]);
			if (inheritedFast !== undefined) {
				ctx.ui.notify("Fast mode is inherited from the parent session for this process.", "warning");
				return;
			}
			const value = args.trim().toLowerCase();
			if (value && value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /fast [on|off]", "warning");
				return;
			}
			const next = value ? value === "on" : !enabled;
			try {
				mkdirSync(dirname(preferenceFile), { recursive: true });
				writeFileSync(preferenceFile, `${JSON.stringify({ enabled: next })}\n`);
			} catch (error) {
				ctx.ui.notify(`Cannot save fast-mode preference: ${String(error)}`, "error");
				return;
			}
			enabled = next;
			publish();
			ctx.ui.notify(
				sessionOverride === undefined
					? enabled ? "OpenAI fast mode ON — priority requested; may use more allowance."
						: "OpenAI fast mode OFF — standard processing."
					: `Saved global fast mode ${enabled ? "ON" : "OFF"}; this session remains ${effectiveFast() ? "ON" : "OFF"} by team variant.`,
				"info",
			);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			!model ||
			(model.provider !== "openai-codex" && model.provider !== "openai") ||
			!isRecord(event.payload) ||
			event.payload.model !== model.id
		) {
			return;
		}

		return {
			...event.payload,
			service_tier: effectiveFast() ? "priority" : "default",
		};
	});
}
