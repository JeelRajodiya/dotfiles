/** Discovery of agent definitions (`*.md` with frontmatter) and named teams (`teams.yaml`). */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AgentDef {
	name: string;
	description: string;
	model?: string;
	fast?: boolean;
	limitations?: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

/**
 * Pi's read-only tools. Two places need this list — the default toolset for an agent definition
 * that declares none, and abort-rewind's "did this turn mutate anything" check — and they were
 * drifting apart as two hardcoded copies.
 */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export const DEFAULT_TOOLS = READ_ONLY_TOOLS.join(",");

/** Always-available definition so a team can be built without writing an .md file first. */
export const CUSTOM_AGENT: AgentDef = {
	name: "custom",
	description: "",
	limitations: "No specialist guarantees.",
	tools: DEFAULT_TOOLS,
	systemPrompt: "You are a focused general-purpose agent. Complete the assigned goal directly and report concise results.",
	file: "<custom>",
};

const key = (name: string) => name.toLowerCase();

export function parseAgentFile(file: string): AgentDef | null {
	try {
		return parseAgentMarkdown(readFileSync(file, "utf-8"), file);
	} catch {
		return null;
	}
}

/** Split out from the file read so the frontmatter rules can be tested without a filesystem. */
export function parseAgentMarkdown(raw: string, file: string): AgentDef | null {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return null;
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	if (!frontmatter.name) return null;
	return {
		name: frontmatter.name,
		description: frontmatter.description || "",
		model: frontmatter.model,
		fast: frontmatter.fast === "true" ? true : frontmatter.fast === "false" ? false : undefined,
		limitations: frontmatter.limitations,
		tools: frontmatter.tools || DEFAULT_TOOLS,
		systemPrompt: match[2].trim(),
		file,
	};
}

/**
 * Project definitions win over global ones of the same name.
 * `agentDir` is passed in rather than assuming ~/.pi so a relocated agent dir still resolves.
 */
export function scanAgentDirs(cwd: string, agentDir: string): AgentDef[] {
	const dirs = [join(cwd, "agents"), join(cwd, ".claude", "agents"), join(cwd, ".pi", "agents"), join(agentDir, "agents")];
	const seen = new Set<string>();
	const defs: AgentDef[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const def = parseAgentFile(resolve(dir, file));
				if (def && !seen.has(key(def.name))) {
					seen.add(key(def.name));
					defs.push(def);
				}
			}
		} catch {}
	}
	return defs;
}

/** A flat team, or one with a visible root and dispatchable members. */
export interface TeamDef {
	members: string[];
	root?: string;
	autoSpawn?: boolean;
	autoSpawnLimit?: number;
}

/** Minimal reader for flat `team:\n  - member` and rooted `team:\n  main: root\n  subs:\n    - member` shapes. */
export function parseTeams(text: string): Record<string, TeamDef> {
	const teams: Record<string, TeamDef> = {};
	let current: string | undefined;
	for (const line of text.split("\n")) {
		const heading = line.match(/^(\S[^:]*):\s*$/);
		if (heading) {
			current = heading[1].trim();
			teams[current] = { members: [] };
			continue;
		}
		const root = current && line.match(/^\s+main:\s*(.+?)\s*$/)?.[1]?.trim();
		if (root && current) teams[current].root = root;
		const autoSpawn = current && line.match(/^\s+auto-spawn:\s*(true|false)\s*$/i)?.[1]?.toLowerCase();
		if (autoSpawn && current) teams[current].autoSpawn = autoSpawn === "true";
		const autoSpawnLimit = current && line.match(/^\s+auto-spawn-limit:\s*(\d+)\s*$/)?.[1];
		if (autoSpawnLimit && current) teams[current].autoSpawnLimit = Number(autoSpawnLimit);
		const member = current && line.match(/^\s+-\s+(.+)$/)?.[1]?.trim();
		if (member && current) teams[current].members.push(member);
	}
	return teams;
}

export function scanTeams(cwd: string, agentDir: string): Record<string, TeamDef> {
	const file = [join(cwd, ".pi", "agents", "teams.yaml"), join(agentDir, "agents", "teams.yaml")].find(existsSync);
	if (!file) return {};
	try {
		return parseTeams(readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
}
