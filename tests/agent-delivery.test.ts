// Run: node tests/agent-delivery.test.ts
import assert from "node:assert/strict";
import { resultDeliveryStatus, restoreNextWaitingAgent, restoreWaitingAgents } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

const waiting = [
	{ status: resultDeliveryStatus("done", true), pendingOutcome: "done" as const },
	{ status: resultDeliveryStatus("error", true), pendingOutcome: "error" as const },
];
assert.equal(waiting[0].status, "waiting", "completed child waits while host is busy");
restoreNextWaitingAgent([waiting[0]]);
assert.deepEqual(waiting[0], { status: "done", pendingOutcome: undefined }, "follow-up delivery restores its success outcome");
assert.equal(waiting[1].status, "waiting", "another queued child remains waiting during active host work");
restoreWaitingAgents(waiting);
assert.deepEqual(waiting, [
	{ status: "done", pendingOutcome: undefined },
	{ status: "error", pendingOutcome: undefined },
], "fully idle host clears all remaining cards and preserves errors");
assert.equal(resultDeliveryStatus("error", false), "error", "an unqueued error is never returning");
console.log("PASS: queued child delivery and settled-host waiting cleanup");
