// Run: node tests/agent-done-expiry.test.ts
import assert from "node:assert/strict";
import {
	clearDoneExpiry,
	DONE_VISIBLE_MS,
	scheduleDoneExpiry,
} from "../dotfiles/agents/.pi/agent/extensions/agent-team.ts";

type Timer = { at: number; callback: () => void; canceled: boolean; unref(): void };
let now = 1_000;
const timers: Timer[] = [];
const clock = {
	now: () => now,
	setTimeout: ((callback: () => void, delay: number) => {
		const timer: Timer = { at: now + delay, callback, canceled: false, unref() {} };
		timers.push(timer);
		return timer;
	}) as unknown as typeof setTimeout,
	clearTimeout: ((timer: Timer) => {
		timer.canceled = true;
	}) as unknown as typeof clearTimeout,
};
const advance = (milliseconds: number) => {
	now += milliseconds;
	for (const timer of timers) {
		if (!timer.canceled && timer.at <= now) {
			timer.canceled = true;
			timer.callback();
		}
	}
};

const done = { status: "done" as const, doneAt: undefined as number | undefined, doneTimer: undefined as ReturnType<typeof setTimeout> | undefined };
let updates = 0;
scheduleDoneExpiry(done, () => updates++, clock);
advance(DONE_VISIBLE_MS - 1);
assert.equal(done.status, "done", "success remains visible immediately before 60 seconds");
advance(1);
assert.equal(done.status as string, "idle", "success becomes idle at 60 seconds");
assert.equal(updates, 1);

const reused = { status: "done" as "done" | "running", doneAt: undefined as number | undefined, doneTimer: undefined as ReturnType<typeof setTimeout> | undefined };
scheduleDoneExpiry(reused, () => updates++, clock);
const staleCallback = timers.at(-1)!.callback;
clearDoneExpiry(reused, clock);
reused.status = "running";
staleCallback();
assert.equal(reused.status, "running", "an obsolete completion callback cannot affect a newer run");

const failed = { status: "error" as const, doneAt: undefined as number | undefined, doneTimer: undefined as ReturnType<typeof setTimeout> | undefined };
scheduleDoneExpiry(failed, () => updates++, clock);
advance(DONE_VISIBLE_MS);
assert.equal(failed.status, "error", "errors do not expire to idle");
console.log("PASS: done expiry timing, cancellation, and error persistence");
