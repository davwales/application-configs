/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type AgentScope = "user" | "project" | "both";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Append a thinking level to a model id as a `:level` suffix, matching the
 * applyFleet()/applyAgentOverrides() convention.
 *
 * Model ids can contain colons that are NOT thinking separators (e.g.
 * `ollama-cloud/deepseek-v4-flash:0731-cloud`), so gating on `includes(":")`
 * silently dropped the thinking level for those. Instead, check whether the
 * trailing token after the last colon is already a thinking level — if so,
 * keep the existing suffix (don't append twice); otherwise append.
 */
function foldThinkingIntoModel(model: string, thinking: string): string {
	if (!thinking) {
		return model;
	}
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.has(model.slice(colonIdx + 1))) {
		return model;
	}
	return `${model}:${thinking}`;
}

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
		if (model && model !== "inherit" && frontmatter.thinking && frontmatter.thinking !== "inherit") {
			model = foldThinkingIntoModel(model, frontmatter.thinking);
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
 * Read the optional subagent timeout (ms) from settings.json
 * (`subagents.timeoutMs`). A positive finite number enables a hard cap on
 * subagent runtime; anything else means no timeout.
 */
export function readSubagentTimeoutMs(agentDir: string): number | undefined {
	try {
		const settingsPath = path.join(agentDir, "settings.json");
		if (!fs.existsSync(settingsPath)) return undefined;
		const content = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		const v = settings?.subagents?.timeoutMs;
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	} catch {
		/* ignore — no timeout */
	}
	return undefined;
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

		// `model: inherit` must stay a sentinel — resolveInheritance() resolves it
		// against the primary agent's model later. Folding a thinking suffix into
		// it (the old behavior) produced `inherit:level`, which never resolved and
		// failed at spawn. A thinking override is applied via the thinking field
		// instead; resolveInheritance folds it into the resolved model string.
		// An explicit override.model replaces the sentinel and takes the normal
		// suffix-folding path below.
		let model = override.model ?? agent.model;
		if (model === "inherit") {
			return { ...agent, thinking: override.thinking ?? agent.thinking };
		}

		if (model && override.thinking) {
			// Strip an existing thinking suffix before applying the override — but
			// only when the text after the final colon is a known thinking level.
			// Model IDs can legitimately contain colons (e.g. HF quant variants),
			// and the old unconditional strip corrupted those.
			const colonIdx = model.lastIndexOf(":");
			if (colonIdx !== -1 && THINKING_LEVELS.has(model.slice(colonIdx + 1))) {
				model = model.slice(0, colonIdx);
			}
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
 * Read the active mode id.
 *
 * Tries the local-only `.modes-state.json` first — the current location
 * managed by pi-ouranos-modes (the active mode is per-session/per-machine
 * state, so it must NOT live in settings.json, which syncs across machines
 * and would cause merge conflicts on every mode switch). Falls back to
 * `settings.json` for backward compatibility with pre-migration installs
 * (machines running an older pi-ouranos-modes that still writes
 * `activeMode` to settings.json).
 *
 * Returns the mode name string, or null if unset/invalid.
 * Mirrors the settings-reading pattern of loadActiveFleet().
 */
export function readActiveModeFromSettings(agentDir: string): string | null {
	// 1. Try the local-only state file (current location).
	try {
		const localStatePath = path.join(agentDir, ".modes-state.json");
		if (fs.existsSync(localStatePath)) {
			const content = fs.readFileSync(localStatePath, "utf-8");
			const state = JSON.parse(content);
			const mode = state?.activeMode;
			if (mode && typeof mode === "string" && mode.trim() !== "") {
				return mode.trim();
			}
		}
	} catch (e) {
		console.error(`[subagents] Failed to read .modes-state.json: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 2. Fall back to settings.json (pre-migration / older pi-ouranos-modes).
	try {
		const settingsPath = path.join(agentDir, "settings.json");
		if (!fs.existsSync(settingsPath)) return null;

		const content = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		const mode = settings?.activeMode;

		if (!mode || typeof mode !== "string" || mode.trim() === "") return null;

		return mode.trim();
	} catch (e) {
		console.error(`[subagents] Failed to read active mode from settings.json: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/**
 * Read the active mode id from the per-session session log.
 *
 * pi-ouranos-modes writes the active mode to the session log on every switch
 * via `pi.appendEntry("modes-state", { mode })`. This is PER-SESSION state:
 * each pi process has its own session log, so two concurrent pi sessions on
 * different projects each see their own mode. The shared
 * `~/.pi/agent/.modes-state.json` (read by readActiveModeFromSettings) is
 * PER-MACHINE and is clobbered by whichever session switched mode last —
 * making it unsafe for the subagent tool's mode resolution when more than
 * one pi process is running (a parent + a spawned subagent, or two parallel
 * project sessions).
 *
 * Scans the session entries in reverse for the latest custom entry whose
 * customType is "modes-state" (the PERSIST_KEY used by pi-ouranos-modes) and
 * returns its `data.mode` string. Mirrors the reverse-scan that
 * pi-ouranos-modes' own session_start uses to restore the persisted mode.
 *
 * Returns the mode id string, or null if no entry is found / the session
 * manager is unavailable / the session has no mode entry yet (e.g. a fresh
 * session that hasn't switched, or a subagent child running with
 * --no-session which has no session log at all).
 */
export function readActiveModeFromSession(
	sessionManager: { getEntries(): unknown[] } | undefined,
): string | null {
	if (!sessionManager) return null;
	let entries: unknown[];
	try {
		entries = sessionManager.getEntries();
	} catch (e) {
		console.error(`[subagents] Failed to read session entries for active mode: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
	if (!Array.isArray(entries)) return null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as
			| { type?: string; customType?: string; data?: { mode?: unknown } }
			| undefined;
		if (!entry || entry.type !== "custom") continue;
		if (entry.customType !== "modes-state") continue;
		const mode = entry.data?.mode;
		if (typeof mode === "string" && mode.trim() !== "") {
			return mode.trim();
		}
	}
	return null;
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
	// already carry a thinking suffix (e.g. an explicit `model: id:level`);
	// colons that aren't thinking separators don't block the append.
	if (resolvedModel && resolvedThinking) {
		resolvedModel = foldThinkingIntoModel(resolvedModel, resolvedThinking);
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
