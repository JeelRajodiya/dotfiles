import { describe, expect, it } from "vitest";
import { defaultConfig, type ZentuiConfig } from "./config";
import type { ExtensionStatusSegment } from "./extension-status";
import {
	formatFooterCostLabel,
	insertFooterCostBeforeCodex,
	installFooter,
} from "./footer";
import { emptyGitStatus } from "./git";
import { renderMinimalistModelThinking } from "./minimalist-editor";
import { createInitialState } from "./state";
import { renderStyleForSource } from "./style";

const status = (key: string, text: string): ExtensionStatusSegment => ({
	key,
	text,
	placement: "right",
	colorMode: "original",
});

describe("inline footer metadata", () => {
	it("preserves minimalist model, separator, and thinking colors", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		};
		const config = {
			colors: { editorModel: "syntaxFunction", editorBorder: "bold accent" },
			components: { editor: { colorSource: "theme" } },
		} as unknown as ZentuiConfig;
		expect(
			renderMinimalistModelThinking(
				{ cwd: "", modelLabel: "gpt-5.6-sol (fast)", thinkingLevel: "medium" },
				theme,
				config,
			),
		).toBe(
			"<syntaxFunction>gpt-5.6-sol (fast)</syntaxFunction><syntaxFunction> – </syntaxFunction><muted>medium</muted>",
		);
		expect(
			renderStyleForSource(theme, "theme", config.colors.editorBorder, "│"),
		).toBe("<accent><bold>│</bold></accent>");
		expect(
			renderMinimalistModelThinking(
				{ cwd: "", modelLabel: "gpt-5.6-sol (fast)", thinkingLevel: "off" },
				theme,
				config,
			),
		).toBe("<syntaxFunction>gpt-5.6-sol (fast)</syntaxFunction>");
	});

	it("composes model and workflow statuses first while retaining right telemetry", () => {
		const config = structuredClone(defaultConfig);
		const segments = config.components.footer.styles.starship.segments;
		for (const key of Object.keys(segments) as (keyof typeof segments)[])
			segments[key] = false;
		segments.modelInfo = true;
		config.components.footer.styles.starship.responsive = false;
		config.components.footer.styles.starship.separator = "dot";
		config.components.footer.styles.starship.extensionStatuses = {
			defaultPlacement: "left",
			placements: { "codex-usage": "right", "monthly-cost": "off" },
			colorModes: {},
		};
		const state = createInitialState(emptyGitStatus());
		state.modelId = "gpt-5.6-sol";
		state.fast = true;
		state.costLabel = "$0.00";
		let createFooter:
			| ((
					tui: object,
					theme: object,
					data: object,
			  ) => { render(width: number): string[] })
			| undefined;
		const ctx = {
			cwd: "/tmp/project",
			model: { contextWindow: 500_000 },
			getContextUsage: () => ({
				percent: 10,
				tokens: 50_000,
				contextWindow: 500_000,
			}),
			sessionManager: { getSessionName: () => undefined },
			ui: {
				setFooter: (factory: typeof createFooter) => {
					createFooter = factory;
				},
			},
		};
		installFooter(ctx as never, state, () => config, {
			setRequestRender() {},
			scheduleProjectRefresh() {},
			getThinkingLevel: () => "medium",
		});
		if (!createFooter) throw new Error("footer factory was not installed");
		const component = createFooter(
			{ requestRender() {} },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			{
				getExtensionStatuses: () =>
					new Map([
						["agent-team", "Root: Orchestrator"],
						["ponytail", "ponytail: full"],
						["monthly-cost", "$12.34 (this month)"],
						["codex-usage", "42% resets in 4d 3h"],
					]),
				onBranchChange: () => () => {},
			},
		);
		const line = component.render(180)[0].trim();
		expect(line).toMatch(
			/^gpt-5\.6-sol \(fast\) – medium · Root: Orchestrator · ponytail: full/,
		);
		expect(line).toContain("$0.00 ($12.34 mo) · 42% resets in 4d 3h");
	});

	it("keeps the session cost valid when monthly or Codex data is unavailable", () => {
		expect(formatFooterCostLabel("$0.00", "cost unavailable")).toBe("$0.00");
		expect(
			insertFooterCostBeforeCodex([status("tokens", "1.2k tokens")], "$0.00"),
		).toEqual([status("tokens", "1.2k tokens")]);
	});
});
