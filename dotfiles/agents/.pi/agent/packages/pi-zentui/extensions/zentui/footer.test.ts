import { describe, expect, it } from "vitest";
import type { ExtensionStatusSegment } from "./extension-status";
import { formatFooterCostLabel, insertFooterCostBeforeCodex } from "./footer";

const status = (key: string, text: string): ExtensionStatusSegment => ({
	key,
	text,
	placement: "right",
	colorMode: "original",
});

describe("inline footer cost", () => {
	it("places combined cost directly before Codex without dropping existing content", () => {
		const cost = formatFooterCostLabel("$0.00", "$12.34 (this month)");
		const segments = insertFooterCostBeforeCodex(
			[status("tokens", "1.2k tokens"), status("codex-usage", "42% resets in 4d 3h")],
			cost,
		);

		expect(segments.map(({ text }) => text).join(" · ")).toBe(
			"1.2k tokens · $0.00 ($12.34 mo) · 42% resets in 4d 3h",
		);
	});

	it("keeps the session cost valid when monthly or Codex data is unavailable", () => {
		expect(formatFooterCostLabel("$0.00", "cost unavailable")).toBe("$0.00");
		expect(insertFooterCostBeforeCodex([status("tokens", "1.2k tokens")], "$0.00")).toEqual([
			status("tokens", "1.2k tokens"),
		]);
	});
});
