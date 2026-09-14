import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config";
import { renderMinimalistFrame } from "./minimalist-editor";

const theme = {
	fg: (color: string, text: string) =>
		`\x1b[${{ accent: 36, error: 31, muted: 90 }[color] ?? 37}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as unknown as Theme;

const renderTimer = (
	agentActive: boolean,
	duration: number | undefined,
	showTimer = true,
) => {
	const config = structuredClone(defaultConfig);
	config.components.editor.colorSource = "theme";
	config.components.editor.borderColorMode = "static";
	config.components.editor.styles.minimalist.showTimer = showTimer;
	config.components.editor.styles.minimalist.showSessionName = false;
	config.colors.editorBorder = "bold error";
	config.colors.sessionDuration = "bold accent";
	return renderMinimalistFrame({
		width: 60,
		editorLines: [""],
		inputText: "",
		metadata: { cwd: "", agentActive, agentDurationMs: duration },
		uiTheme: theme,
		config,
	})[0];
};

describe("minimalist input timer", () => {
	it("uses configured accent while active and muted after stopping", () => {
		expect(renderTimer(true, 1_000)).toContain("\x1b[36m\x1b[1m1s");
		expect(renderTimer(false, 1_000)).toContain("\x1b[90m1s");
	});

	it("stays absent without duration data or when disabled", () => {
		expect(renderTimer(true, undefined)).not.toContain("1s");
		expect(renderTimer(true, 1_000, false)).not.toContain("1s");
	});
});
