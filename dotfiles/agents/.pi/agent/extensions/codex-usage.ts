import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export default function codexUsage(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const update = async () => {
			try {
				const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"))["openai-codex"];
				const response = await fetch(USAGE_URL, {
					headers: {
						Authorization: `Bearer ${auth.access}`,
						"ChatGPT-Account-Id": auth.accountId,
					},
				});
				const window = (await response.json()).rate_limit?.primary_window;
				const used = window?.used_percent;
				const reset = window?.reset_after_seconds;
				if (!response.ok || !Number.isFinite(used) || !Number.isFinite(reset)) {
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
