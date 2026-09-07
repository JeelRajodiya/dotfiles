import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi",
		handler: async (_args, ctx) => { await ctx.shutdown(); },
	});
}
