// Run: node tests/agent-interrupt.test.ts
import assert from "node:assert/strict";
import { canInterruptAgent, interruptAgentRun, shouldIgnoreAgentRunEvent } from "../dotfiles/agents/.pi/agent/extensions/agent-team-helpers.ts";

assert.equal(canInterruptAgent("running", false), true, "a running child can be interrupted");
for (const status of ["idle", "waiting", "done", "error"]) assert.equal(canInterruptAgent(status, false), false, `${status} child cannot be interrupted`);
assert.equal(canInterruptAgent("running", true), false, "the root cannot be interrupted");

const events: string[] = [];
const run = {
	finished: false, stopping: false, startTime: 100, sessionFile: "/tmp/child.json",
	transport: { fail(error: Error) { events.push(`transport:${error.message}`); } },
	child: {
		exitCode: null as number | null,
		kill(signal: "SIGTERM" | "SIGKILL") { events.push(`kill:${signal}`); },
		once(_event: "close", _callback: () => void) {},
	},
};
const state = {
	timer: {}, elapsed: 0, sessionFile: null as string | null, lastWork: "working", pendingOutcome: "done" as "done" | "error" | undefined,
	status: "waiting", activeRun: run,
	activity: { closeOpenThoughts() { events.push("thoughts:closed"); }, append(kind: string, value: unknown) { events.push(`activity:${kind}:${value}`); } },
};

assert.equal(interruptAgentRun(state, run, () => events.push("timer:cleared"), 250), true);
assert.deepEqual(events, ["timer:cleared", "thoughts:closed", "activity:tool-error:Interrupted directly by the main agent.", "transport:Agent interrupted directly", "kill:SIGTERM"], "interruption cleans up before terminating RPC and process");
assert.deepEqual({ status: state.status, pendingOutcome: state.pendingOutcome, activeRun: state.activeRun, timer: state.timer, elapsed: state.elapsed, sessionFile: state.sessionFile, lastWork: state.lastWork }, { status: "error", pendingOutcome: undefined, activeRun: undefined, timer: undefined, elapsed: 150, sessionFile: "/tmp/child.json", lastWork: "Interrupted directly by the main agent." }, "interruption cannot queue delivery or be finalized again");
assert.equal(interruptAgentRun(state, run, () => events.push("unexpected"), 300), false, "duplicate interruption is ignored");
assert.equal(shouldIgnoreAgentRunEvent(run.finished, run.stopping), true, "late child events are rejected after interruption");
console.log("PASS: agent interruption lifecycle and eligibility");
