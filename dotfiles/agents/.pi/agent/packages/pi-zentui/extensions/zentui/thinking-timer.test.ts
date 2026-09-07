import { describe, expect, it } from "vitest";
import { formatThinkingTimerLabel } from "./thinking-timer";
import { activeWorkingLineMessage } from "./working-line";

describe("formatThinkingTimerLabel", () => {
	it("uses the shared compact duration format for active and completed thought", () => {
		expect(formatThinkingTimerLabel(true, 62_000)).toBe("Thinking (1m 2s)");
		expect(formatThinkingTimerLabel(false, 62_000)).toBe("Thought (1m 2s)");
	});

	it("changes the working indicator from real thinking back to normal work", () => {
		expect(activeWorkingLineMessage("Working", { active: true, durationMs: 1_000 })).toBe("Thinking");
		expect(activeWorkingLineMessage("Working", { active: false, durationMs: 1_000 })).toBe("Working");
		expect(activeWorkingLineMessage("bash", undefined)).toBe("bash");
	});
});
