import assert from "node:assert/strict";
import {
	appendTaskHistory,
	canKillHostAgent,
	decideRouting,
	removeQueuedItem,
	updateQueuedItem,
} from "../extensions/agent-team-helpers.ts";

const idle = { name: "understand-1", base: "understand", origin: "default" as const, status: "idle", history: [] };
const busy = { name: "understand-2", base: "understand", origin: "host" as const, status: "running", history: [] };

assert.deepEqual(decideRouting([busy, idle], "understand", "related", "understand-2", true, 0, 3), { action: "steer", agent: "understand-2" });
assert.deepEqual(decideRouting([busy, idle], "understand", "new", "understand-2", true, 0, 3), { action: "reuse", agent: "understand-1" });
assert.deepEqual(decideRouting([busy], "understand", "new", undefined, false, 0, 3), { action: "queue" });
assert.deepEqual(decideRouting([busy], "understand", "new", undefined, true, 2, 3), { action: "spawn" });
assert.deepEqual(decideRouting([busy], "understand", "new", undefined, true, 3, 3), { action: "queue" });
assert.equal(canKillHostAgent({ origin: "host", status: "idle" }), true);
assert.equal(canKillHostAgent({ origin: "default", status: "idle" }), false);
assert.equal(canKillHostAgent({ origin: "host", status: "waiting" }), false);

const queue = [{ id: "stable-id", task: "original", type: "understand", approved: true }];
const edited = updateQueuedItem(queue, "stable-id", item => ({ ...item, task: "edited", type: "reviewer" }))!;
assert.deepEqual(edited, [{ id: "stable-id", task: "edited", type: "reviewer", approved: true }]);
assert.deepEqual(removeQueuedItem(edited, "stable-id"), []);
assert.deepEqual(decideRouting([{ ...busy, status: "waiting" }], "understand", "new", undefined, false, 3, 3), { action: "queue" });

const history = appendTaskHistory([], "inspect auth token=secret-value", "done", 2);
assert.match(history[0]!.task, /token= \[redacted\]/i);
assert.deepEqual(appendTaskHistory([...history, { task: "older", outcome: "error" }], "latest", "done", 2).map(entry => entry.task), ["older", "latest"]);
console.log("agent-team routing checks passed");
