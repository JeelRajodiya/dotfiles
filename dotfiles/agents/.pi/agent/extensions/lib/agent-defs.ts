/** Discovery of agent definitions (`*.md` with frontmatter) and named teams (`teams.yaml`). */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface AgentVariantSetting {
	model?: string;
	thinking?: ThinkingLevel;
	fast?: boolean;
}

export interface AgentDef {
	name: string;
	description: string;
	model?: string;
	fast?: boolean;
	thinking?: ThinkingLevel;
	limitations?: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

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
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
		thinking: THINKING_LEVELS.includes(frontmatter.thinking as ThinkingLevel) ? frontmatter.thinking as ThinkingLevel : undefined,
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
	defaultVariant?: string;
	variants?: Record<string, Record<string, AgentVariantSetting>>;
}

/** Minimal reader for flat/root teams plus the deliberately narrow team-local variant schema. */
export function parseTeams(text: string): Record<string, TeamDef> {
	const teams: Record<string, TeamDef> = {};
	let currentTeam: string | undefined;
	let section: "subs" | "variants" | undefined;
	let currentVariant: string | undefined;
	let currentAgent: string | undefined;
	for (const [index, rawLine] of text.split("\n").entries()) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		const indent = rawLine.length - rawLine.trimStart().length;
		const line = rawLine.trim();
		const teamHeading = indent === 0 && line.match(/^([^:]+):$/);
		if (teamHeading) {
			currentTeam = teamHeading[1].trim();
			teams[currentTeam] = { members: [] };
			section = undefined; currentVariant = undefined; currentAgent = undefined;
			continue;
		}
		if (!currentTeam) throw new Error(`Invalid teams.yaml line ${index + 1}: expected team name`);
		const team = teams[currentTeam];
		if (indent === 2 && line === "subs:") { section = "subs"; currentVariant = undefined; currentAgent = undefined; continue; }
		if (indent === 2 && line === "variants:") { section = "variants"; team.variants ??= {}; currentVariant = undefined; currentAgent = undefined; continue; }
		if (indent === 2 && line.startsWith("- ")) { team.members.push(line.slice(2).trim()); section = undefined; continue; }
		if (indent === 2) {
			const field = line.match(/^([^:]+):\s*(.*?)$/);
			if (!field) continue;
			const [, name, value] = field;
			if (name === "main" && value) team.root = value;
			else if (name === "auto-spawn" && /^(true|false)$/i.test(value)) team.autoSpawn = value.toLowerCase() === "true";
			else if (name === "auto-spawn-limit" && /^\d+$/.test(value)) team.autoSpawnLimit = Number(value);
			else if (name === "default-variant" && value) team.defaultVariant = value;
			section = undefined;
			continue;
		}
		if (section === "subs" && indent === 4 && line.startsWith("- ")) { team.members.push(line.slice(2).trim()); continue; }
		if (section !== "variants") continue;
		const context = () => `team "${currentTeam}"${currentVariant ? `, variant "${currentVariant}"` : ""}${currentAgent ? `, agent "${currentAgent}"` : ""}`;
		if (indent === 4 && line.endsWith(":")) {
			currentVariant = line.slice(0, -1).trim(); currentAgent = undefined;
			if (!currentVariant) throw new Error(`Invalid variant name in ${context()}`);
			team.variants![currentVariant] = {};
			continue;
		}
		if (indent === 6 && line.endsWith(":")) {
			if (!currentVariant) throw new Error(`Variant agent without variant in team "${currentTeam}"`);
			currentAgent = line.slice(0, -1).trim();
			if (!currentAgent) throw new Error(`Invalid agent name in ${context()}`);
			team.variants![currentVariant]![currentAgent] = {};
			continue;
		}
		if (indent === 8) {
			if (!currentVariant || !currentAgent) throw new Error(`Variant setting without agent in ${context()}`);
			const field = line.match(/^([^:]+):\s*(.*?)$/);
			if (!field) throw new Error(`Invalid variant setting in ${context()}`);
			const [, name, value] = field;
			const setting = team.variants![currentVariant]![currentAgent]!;
			if (name === "model" && value) setting.model = value;
			else if (name === "thinking") {
				if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error(`Invalid thinking "${value}" in ${context()}`);
				setting.thinking = value as ThinkingLevel;
			} else if (name === "fast") {
				if (!/^(true|false)$/i.test(value)) throw new Error(`Invalid fast boolean "${value}" in ${context()}`);
				setting.fast = value.toLowerCase() === "true";
			} else throw new Error(`Unknown variant field "${name}" in ${context()}`);
			continue;
		}
		throw new Error(`Invalid variant nesting in ${context()} at line ${index + 1}`);
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
