import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Resolve against the configured agent dir like every other extension here; a hardcoded
// ~/.pi/agent silently reads the wrong auth file when PI_AGENT_DIR moves it.
const AUTH_FILE = join(getAgentDir(), "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export default function codexUsage(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// A session restart in the same process must not leave the previous poller running.
		clearInterval(timer);
		const update = async () => {
			try {
				const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"))["openai-codex"];
				const response = await fetch(USAGE_URL, {
					headers: {
						Authorization: `Bearer ${auth.access}`,
						"ChatGPT-Account-Id": auth.accountId,
					},
					// Without this a stalled request outlives the 60s interval and they pile up.
					signal: AbortSignal.timeout(15_000),
				});
				// response.json() is `unknown`; the shape is only asserted here, and the
				// guards below are what actually validate it.
				const payload = await response.json() as { rate_limit?: { primary_window?: { used_percent?: number; reset_after_seconds?: number } } };
				const window = payload.rate_limit?.primary_window;
				const used = window?.used_percent;
				const reset = window?.reset_after_seconds;
				if (!response.ok || typeof used !== "number" || !Number.isFinite(used) || typeof reset !== "number" || !Number.isFinite(reset)) {
					throw new Error("usage unavailable");
				}
				const days = Math.floor(reset / 86_400);
				const hours = Math.floor((reset % 86_400) / 3_600);
				ctx.ui.setStatus(
					"codex-usage",
					ctx.ui.theme.fg(
						"accent",
						`${Math.max(0, 100 - used)}% resets in ${days}d ${hours}h`,
					),
				);
			} catch {
				ctx.ui.setStatus("codex-usage", ctx.ui.theme.fg("dim", "usage unavailable"));
			}
		};

		await update();
		timer = setInterval(update, 60_000);
		timer.unref();
	});

	pi.on("session_shutdown", () => clearInterval(timer));
}
