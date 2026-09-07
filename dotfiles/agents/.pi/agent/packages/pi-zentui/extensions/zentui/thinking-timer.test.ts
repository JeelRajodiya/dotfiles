import { describe, expect, it } from "vitest";
import { formatThinkingTimerLabel } from "./thinking-timer";

describe("formatThinkingTimerLabel", () => {
	it("uses the shared compact duration format for active and completed thought", () => {
		expect(formatThinkingTimerLabel(true, 62_000)).toBe("Thinking (1m 2s)");
		expect(formatThinkingTimerLabel(false, 62_000)).toBe("Thought (1m 2s)");
	});
});
