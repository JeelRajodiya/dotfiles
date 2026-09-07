// Run: node tests/agent-defs.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTeams } from "../dotfiles/agents/.pi/agent/extensions/lib/agent-defs.ts";

assert.deepEqual(parseTeams("flat:\n  - planner\n  - builder\nrooted:\n  main: understand\n  subs:\n    - iterate\n"), {
	flat: { members: ["planner", "builder"] },
	rooted: { root: "understand", members: ["iterate"] },
});
assert.deepEqual(parseTeams(readFileSync("dotfiles/agents/.pi/agent/agents/teams.yaml", "utf8"))["understand-iterate"], {
	root: "understand", members: ["iterate"],
});
console.log("PASS: flat and rooted teams parse with only subagents dispatchable");
