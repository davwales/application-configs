/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project" | "package";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "package"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		let model = frontmatter.model;
		if (model && frontmatter.thinking && !model.includes(":")) {
			model = `${model}:${frontmatter.thinking}`;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function getPackageAgentsDir(): string {
	const packageDir = path.dirname(fileURLToPath(import.meta.url));
	return path.join(packageDir, "agents");
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const packageAgentsDir = getPackageAgentsDir();

	// Package agents are always loaded as the base layer
	const packageAgents = loadAgentsFromDir(packageAgentsDir, "package");

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// Layer 1: Package agents (base)
	for (const agent of packageAgents) agentMap.set(agent.name, agent);

	// Layer 2: User agents (override package)
	if (scope !== "project") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}

	// Layer 3: Project agents (highest priority, override user and package)
	if (scope !== "user" && projectAgentsDir) {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export interface AgentOverrides {
	[key: string]: {
		model?: string;
		thinking?: string;
	};
}

export interface AgentFleetEntry {
  provider: string;
  model: string;
  thinking?: string;
}

export interface FleetConfig {
  name: string;
  agents: Record<string, AgentFleetEntry>;
  default?: AgentFleetEntry;
}

/**
 * Load the active fleet from settings.json.
 * Returns the fleet config if activeFleet is set and the file exists, null otherwise.
 */
export function loadActiveFleet(agentDir: string): FleetConfig | null {
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    if (!fs.existsSync(settingsPath)) return null;
    
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const fleetName = settings?.activeFleet;
    
    if (!fleetName || typeof fleetName !== "string" || fleetName.trim() === "") {
      return null;
    }
    
    const fleetPath = path.join(agentDir, "fleets", `${fleetName.trim()}.json`);
    if (!fs.existsSync(fleetPath)) {
      console.warn(`[subagents] Active fleet "${fleetName}" not found at ${fleetPath}, ignoring.`);
      return null;
    }
    
    const fleetContent = fs.readFileSync(fleetPath, "utf-8");
    const fleet = JSON.parse(fleetContent);
    
    if (!fleet || typeof fleet !== "object") {
      console.error(`[subagents] Fleet "${fleetName}" is not a valid JSON object, ignoring.`);
      return null;
    }
    if (typeof fleet.name !== "string") {
      console.error(`[subagents] Fleet "${fleetName}" missing required "name" field, ignoring.`);
      return null;
    }
    if (!fleet.agents || typeof fleet.agents !== "object") {
      console.error(`[subagents] Fleet "${fleetName}" missing required "agents" field, ignoring.`);
      return null;
    }
    if (fleet.default !== undefined && (typeof fleet.default !== "object" || !fleet.default.provider || !fleet.default.model)) {
      console.warn(`[subagents] Fleet "${fleetName}" has invalid "default" field, ignoring default.`);
      fleet.default = undefined;
    }
    
    return fleet as FleetConfig;
  } catch (e) {
    console.error(`[subagents] Failed to load active fleet: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Read the subagents.agentOverrides section from settings.json.
 * These override the model/thinking values from agent frontmatter.
 */
export function loadAgentOverrides(agentDir: string): AgentOverrides {
	try {
		const settingsPath = path.join(agentDir, "settings.json");
		if (!fs.existsSync(settingsPath)) return {};
		const content = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		return settings?.subagents?.agentOverrides ?? {};
	} catch {
		return {};
	}
}

/**
 * Apply fleet-level model assignments to agents.
 * Fleet entries take precedence over frontmatter models.
 * agentOverrides (applied separately) take precedence over fleet.
 */
export function applyFleet(agents: AgentConfig[], fleet: FleetConfig | null): AgentConfig[] {
  if (!fleet) return agents;
  
  const hasDefault = fleet.default !== undefined;
  
  const result: AgentConfig[] = [];
  
  for (const agent of agents) {
    const fleetEntry = fleet.agents[agent.name] ?? fleet.default;
    
    // Restrictive mode: no default → unlisted agents are excluded
    if (!fleetEntry) {
      if (!hasDefault) continue; // skip/exclude this agent
      result.push(agent); // permissive mode: keep with original model
      continue;
    }
    
    const provider = fleetEntry.provider?.trim();
    const model = fleetEntry.model?.trim();
    if (!provider || !model) {
      // Invalid fleet entry — skip this agent regardless of mode
      continue;
    }
    
    let resolvedModel = `${provider}/${model}`;
    if (fleetEntry.thinking) {
      resolvedModel = `${resolvedModel}:${fleetEntry.thinking}`;
    }
    
    result.push({
      ...agent,
      model: resolvedModel,
    });
  }
  
  return result;
}

/**
 * Return the list of agent names available under the active fleet.
 * In restrictive mode (no default), this is fleet.agents keys.
 * In permissive mode (has default), returns null (all agents available).
 * Returns null if no fleet is active.
 */
export function getFleetAgentNames(fleet: FleetConfig | null): string[] | null {
  if (!fleet) return null;
  if (fleet.default !== undefined) return null; // permissive — all agents
  return Object.keys(fleet.agents);
}

/**
 * Apply agent overrides to a list of agents.
 * An override model takes precedence over frontmatter model.
 * Thinking levels are appended as `:level` suffixes to the model string.
 */
export function applyAgentOverrides(agents: AgentConfig[], agentDir: string): AgentConfig[] {
	const overrides = loadAgentOverrides(agentDir);
	return agents.map((agent) => {
		const override = overrides[agent.name];
		if (!override) return agent;

		let model = override.model ?? agent.model;
		if (model && override.thinking) {
			// Strip existing thinking suffix before applying override
			const colonIdx = model.lastIndexOf(":");
			if (colonIdx !== -1) model = model.slice(0, colonIdx);
			model = `${model}:${override.thinking}`;
		}

		return {
			...agent,
			model: model ?? agent.model,
		};
	});
}

export function formatAvailableAgents(agents: AgentConfig[], quoted?: boolean): string {
	if (agents.length === 0) return "none";
	return agents.map(a => quoted ? `"${a.name}"` : `${a.name} (${a.source})`).join(", ");
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
