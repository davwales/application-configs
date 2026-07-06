/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

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
		// The "inherit" sentinels are resolved later by resolveInheritance()
		// against the primary agent's model + thinking — don't fold the thinking
		// suffix into the model here for either sentinel.
		if (model && model !== "inherit" && frontmatter.thinking && frontmatter.thinking !== "inherit" && !model.includes(":")) {
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

function findNearestProjectModeAgentsDir(cwd: string, modeName: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "modes", modeName, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Read the `activeMode` key from settings.json.
 * Returns the mode name string, or null if unset/invalid.
 * Mirrors the settings-reading pattern of loadActiveFleet().
 */
export function readActiveModeFromSettings(agentDir: string): string | null {
	try {
		const settingsPath = path.join(agentDir, "settings.json");
		if (!fs.existsSync(settingsPath)) return null;

		const content = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		const mode = settings?.activeMode;

		if (!mode || typeof mode !== "string" || mode.trim() === "") return null;

		return mode.trim();
	} catch (e) {
		console.error(`[subagents] Failed to read active mode: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/**
 * Load agent definitions for a given mode from the user and project layers.
 * (Package layer is intentionally omitted: pi-ouranos-modes ships its mode
 * directories and copies them into ~/.pi/agent/modes/ on first run, so the
 * user layer is the base. This avoids cross-extension path coupling.)
 *
 * Layering (project overrides user by agent name):
 *   - User:    ~/.pi/agent/modes/<modeName>/agents/*.md
 *   - Project: nearest .pi/modes/<modeName>/agents/ walking up from cwd
 *
 * Returns an empty array if the mode has no agents (e.g. default mode).
 */
export function loadModeAgents(agentDir: string, modeName: string, cwd: string): AgentConfig[] {
	const userDir = path.join(agentDir, "modes", modeName, "agents");
	const projectDir = findNearestProjectModeAgentsDir(cwd, modeName);

	const userAgents = loadAgentsFromDir(userDir, "user");
	const projectAgents = projectDir ? loadAgentsFromDir(projectDir, "project") : [];

	const agentMap = new Map<string, AgentConfig>();
	// Layer 1: user (base)
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	// Layer 2: project (overrides user)
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return Array.from(agentMap.values());
}

/** Resolve the project-layer mode agents dir (nearest .pi/modes/<mode>/agents), or null. */
export function findProjectModeAgentsDir(cwd: string, modeName: string): string | null {
	return findNearestProjectModeAgentsDir(cwd, modeName);
}

/**
 * Resolve the `model: inherit` and `thinking: inherit` sentinels against the
 * primary agent's currently selected model and thinking level. Constructs a
 * `provider/id[:thinking]` string matching the convention used by applyFleet().
 *
 * - `model: inherit`    → primary agent's current model (`provider/id`).
 * - `thinking: inherit` → primary agent's current thinking level.
 *
 * If a `model: inherit` sentinel has nothing to inherit (no primary model),
 * the agent is returned unchanged so the sentinel stays and spawn fails loudly
 * (same behavior as before this function handled thinking).
 * If a `thinking: inherit` sentinel has nothing to inherit (no primary thinking
 * level available), the suffix is dropped entirely rather than emitting
 * `:inherit` (which would fail at spawn) — the subagent then uses the model's
 * default thinking level.
 *
 * Agents with neither sentinel are returned unchanged.
 */
export function resolveInheritance(
	agent: AgentConfig,
	primaryModel: { provider: string; id: string } | undefined,
	primaryThinking: ThinkingLevel | undefined,
): AgentConfig {
	const wantsModelInherit = agent.model === "inherit";
	const wantsThinkingInherit = agent.thinking === "inherit";
	if (!wantsModelInherit && !wantsThinkingInherit) return agent;

	// Resolve model.
	let resolvedModel = agent.model;
	if (wantsModelInherit) {
		if (!primaryModel) return agent; // nothing to inherit — keep sentinel (will fail at spawn)
		resolvedModel = `${primaryModel.provider}/${primaryModel.id}`;
	}

	// Resolve thinking.
	let resolvedThinking = agent.thinking;
	if (wantsThinkingInherit) {
		resolvedThinking = primaryThinking;
	}

	// Fold the resolved thinking into the model string as a `:level` suffix,
	// matching applyFleet()'s convention. Only append when the model doesn't
	// already carry a thinking suffix (e.g. an explicit `model: id:level`).
	if (resolvedModel && resolvedThinking && !resolvedModel.includes(":")) {
		resolvedModel = `${resolvedModel}:${resolvedThinking}`;
	}
	return { ...agent, model: resolvedModel, thinking: resolvedThinking };
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
