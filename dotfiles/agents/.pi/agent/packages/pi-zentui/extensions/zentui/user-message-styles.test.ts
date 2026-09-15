import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config";
import { renderUserMessageStyle } from "./user-message-styles";

const theme = {
	fg: (color: string, text: string) =>
		`\x1b[${{ error: 31, accent: 36 }[color] ?? 37}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

describe("user message rails", () => {
	it("hides only the framed rail while preserving indentation, rules, and compact rails", () => {
		const config = structuredClone(defaultConfig);
		config.components.userMessages.colorSource = "theme";
		config.colors.editorBorder = "bold error";
		config.colors.editorAccent = "bold accent";
		config.icons.rail = "│";

		config.components.userMessages.style = "framed";
		const framed = renderUserMessageStyle({
			text: "hello",
			width: 12,
			theme,
			config,
		});
		expect(framed[0]).toContain("\x1b[31m\x1b[1m────────────");
		expect(framed[1].startsWith("  ")).toBe(true);
		expect(framed[2].startsWith("  ")).toBe(true);
		expect(framed.slice(1, -1).join("")).not.toContain("│");
		expect(framed.at(-1)).toContain("\x1b[31m\x1b[1m────────────");
		expect(framed.every((line) => visibleWidth(line) === 12)).toBe(true);

		config.components.userMessages.style = "compact";
		expect(
			renderUserMessageStyle({
				text: "hello",
				width: 12,
				theme,
				config,
			})[0].startsWith("\x1b[36m\x1b[1m│"),
		).toBe(true);
	});
});
