import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENAI_FAST_ENV, parseOpenAIFastEnvValue } from "./agent-team-helpers.ts";

const preferenceFile = join(getAgentDir(), "states", "openai-fast.json");
const STATE_TYPE = "openai-fast";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function openAICodexFast(pi: ExtensionAPI) {
	let enabled = false;

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
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
		pi.appendEntry(STATE_TYPE, { enabled });
		pi.events.emit("openai-fast:changed", { enabled });
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
				writeFileSync(preferenceFile, `${JSON.stringify({ enabled: next })}\n`);
			} catch (error) {
				ctx.ui.notify(`Cannot save fast-mode preference: ${String(error)}`, "error");
				return;
			}
			enabled = next;
			pi.appendEntry(STATE_TYPE, { enabled });
			pi.events.emit("openai-fast:changed", { enabled });
			ctx.ui.notify(
				enabled ? "OpenAI fast mode ON — priority requested; may use more allowance."
					: "OpenAI fast mode OFF — standard processing.",
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
			service_tier: enabled ? "priority" : "default",
		};
	});
}
