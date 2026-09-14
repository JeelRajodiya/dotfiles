import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ZentuiConfig } from "./config";
import { createMinimalistViewportTui } from "./ui";

describe("createMinimalistViewportTui", () => {
	it("dynamically caps only the enabled minimalist editor and binds delegated members", () => {
		let rows = 33;
		const terminal = {
			get rows() {
				return rows;
			},
			readRows() {
				return this.rows;
			},
		};
		const tui = {
			terminal,
			readTerminal() {
				return this.terminal;
			},
		} as unknown as TUI;
		const editor = { enabled: true, style: "minimalist" };
		const config = { components: { editor } } as unknown as ZentuiConfig;
		const proxy = createMinimalistViewportTui(tui, () => config);

		for (const [terminalRows, reportedRows] of [
			[33, 33],
			[34, 34],
			[36, 36],
			[37, 36],
			[100, 36],
		] as const) {
			rows = terminalRows;
			expect(proxy.terminal.rows).toBe(reportedRows);
		}
		expect((proxy.terminal as typeof terminal).readRows()).toBe(100);
		expect(proxy.readTerminal()).toBe(terminal);
		editor.style = "opencode";
		expect(proxy.terminal.rows).toBe(100);
		editor.style = "minimalist";
		editor.enabled = false;
		expect(proxy.terminal.rows).toBe(100);
	});
});
