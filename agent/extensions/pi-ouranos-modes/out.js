// index.ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var PERSIST_KEY = "modes-state";
var PREFERRED_ORDER = ["default", "plan", "build", "orchestrator"];
function modesExtension(pi) {
  const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
  const shippedModesDir = path.join(__dirname2, "modes");
  const agentDir = getAgentDir();
  const userModesDir = path.join(agentDir, "modes");
  let availableModes = [];
  let currentModeIndex = 0;
  let baselineTools = [];
  function parseModeFile(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    const lines = raw.split(/\r?\n/);
    if (lines[0] !== "---")
      return null;
    const sep = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (sep === -1)
      return null;
    const yamlLines = lines.slice(1, sep);
    const prompt = lines.slice(sep + 1).join(`
`).trim();
    const id = path.basename(path.dirname(filePath));
    let name = id;
    let description = "";
    let color = "accent";
    for (const line of yamlLines) {
      const trimmed = line.trim();
      if (/^name:(?: |$)/.test(trimmed)) {
        let parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (parsed.startsWith('"') && parsed.endsWith('"') || parsed.startsWith("'") && parsed.endsWith("'")) {
          parsed = parsed.slice(1, -1);
        }
        if (parsed)
          name = parsed;
        continue;
      }
      if (/^description:(?: |$)/.test(trimmed)) {
        let parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (parsed.startsWith('"') && parsed.endsWith('"') || parsed.startsWith("'") && parsed.endsWith("'")) {
          parsed = parsed.slice(1, -1);
        }
        description = parsed;
        continue;
      }
      if (/^color:(?: |$)/.test(trimmed)) {
        const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (parsed)
          color = parsed;
        continue;
      }
    }
    return { id, name, description, color, prompt, hasAgents: false };
  }
  function isDirectory(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
  function listModeDirs(dir) {
    if (!isDirectory(dir))
      return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "mode.md"))).map((e) => e.name).sort();
  }
  function modeHasAgents(modeId, cwd) {
    const userAgentsDir = path.join(userModesDir, modeId, "agents");
    if (hasMarkdownFiles(userAgentsDir))
      return true;
    let currentDir = cwd;
    while (true) {
      const candidate = path.join(currentDir, ".pi", "modes", modeId, "agents");
      if (hasMarkdownFiles(candidate))
        return true;
      const parent = path.dirname(currentDir);
      if (parent === currentDir)
        break;
      currentDir = parent;
    }
    return false;
  }
  function hasMarkdownFiles(dir) {
    if (!isDirectory(dir))
      return false;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md"));
  }
  function findNearestProjectModesDir(cwd) {
    let currentDir = cwd;
    while (true) {
      const candidate = path.join(currentDir, ".pi", "modes");
      if (isDirectory(candidate))
        return candidate;
      const parent = path.dirname(currentDir);
      if (parent === currentDir)
        return null;
      currentDir = parent;
    }
  }
  function loadAvailableModes(cwd) {
    const projectModesDir = findNearestProjectModesDir(cwd);
    const byId = new Map;
    for (const id of listModeDirs(userModesDir)) {
      const parsed = parseModeFile(path.join(userModesDir, id, "mode.md"));
      if (parsed)
        byId.set(id, parsed);
    }
    if (projectModesDir) {
      for (const id of listModeDirs(projectModesDir)) {
        const parsed = parseModeFile(path.join(projectModesDir, id, "mode.md"));
        if (parsed)
          byId.set(id, parsed);
      }
    }
    const modes = Array.from(byId.values());
    for (const m of modes)
      m.hasAgents = modeHasAgents(m.id, cwd);
    modes.sort((a, b) => {
      const ai = PREFERRED_ORDER.indexOf(a.id);
      const bi = PREFERRED_ORDER.indexOf(b.id);
      const ap = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bp = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (ap !== bp)
        return ap - bp;
      return a.id.localeCompare(b.id);
    });
    return modes;
  }
  function copyShippedModes() {
    if (!isDirectory(shippedModesDir))
      return;
    if (!isDirectory(userModesDir)) {
      try {
        fs.mkdirSync(userModesDir, { recursive: true });
      } catch (err) {
        console.warn(`[modes] Could not create ${userModesDir}: ${err}`);
        return;
      }
    }
    let entries;
    try {
      entries = fs.readdirSync(shippedModesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink())
        continue;
      const target = path.join(userModesDir, entry.name);
      if (fs.existsSync(target))
        continue;
      const source = path.join(shippedModesDir, entry.name);
      try {
        fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
      } catch (err) {
        console.warn(`[modes] Could not copy shipped mode "${entry.name}": ${err}`);
      }
    }
  }
  function writeActiveMode(modeId) {
    const settingsPath = path.join(agentDir, "settings.json");
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      console.warn(`[modes] Could not read/parse ${settingsPath}; not persisting activeMode to avoid clobbering existing settings.`);
      return;
    }
    settings.activeMode = modeId;
    const tmp = settingsPath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
      fs.renameSync(tmp, settingsPath);
    } catch (err) {
      console.warn(`[modes] Failed to persist activeMode to settings.json: ${err}`);
      try {
        if (fs.existsSync(tmp))
          fs.unlinkSync(tmp);
      } catch {}
    }
  }
  function persistState() {
    try {
      pi.appendEntry(PERSIST_KEY, { mode: availableModes[currentModeIndex].id });
    } catch (err) {
      console.warn(`[modes] Failed to persist mode state: ${err}`);
    }
  }
  function setMode(ctx, index) {
    if (index < 0 || index >= availableModes.length)
      return false;
    if (baselineTools.length === 0)
      return false;
    const mode = availableModes[index];
    const active = mode.hasAgents ? baselineTools : baselineTools.filter((n) => n !== "subagent");
    try {
      pi.setActiveTools(active);
    } catch (err) {
      console.warn(`[modes] setActiveTools failed: ${err}`);
      return false;
    }
    currentModeIndex = index;
    writeActiveMode(mode.id);
    persistState();
    publishModeStatus(ctx, mode);
    return true;
  }
  function notifySwitch(ctx, index) {
    const mode = availableModes[index];
    const agentInfo = mode.hasAgents ? "" : " (no subagents)";
    ctx.ui.notify(`Mode: ${mode.name}${agentInfo}`, "info");
  }
  pi.registerCommand("mode", {
    description: `Switch mode (${PREFERRED_ORDER.join(" | ")})`,
    handler: async (args, ctx) => {
      if (availableModes.length === 0) {
        ctx.ui.notify("No modes available. Run /reload after adding mode files.", "warning");
        return;
      }
      if (!args || !args.trim()) {
        const options = availableModes.map((m, i) => `${i === currentModeIndex ? "● " : "  "}${m.name} — ${m.description || "(no description)"}`);
        const choice = await ctx.ui.select("Switch mode", options);
        if (choice === undefined)
          return;
        const index2 = options.indexOf(choice);
        if (index2 === -1)
          return;
        if (setMode(ctx, index2))
          notifySwitch(ctx, index2);
        else
          ctx.ui.notify("Session not ready yet. Try again in a moment.", "warning");
        return;
      }
      const id = args.trim().toLowerCase();
      const index = availableModes.findIndex((m) => m.id === id);
      if (index === -1) {
        ctx.ui.notify(`Unknown mode "${args.trim()}". Available: ${availableModes.map((m) => m.id).join(", ")}`, "error");
        return;
      }
      if (setMode(ctx, index))
        notifySwitch(ctx, index);
      else
        ctx.ui.notify("Session not ready yet. Try again in a moment.", "warning");
    }
  });
  pi.registerShortcut("alt+m", {
    description: "Next mode",
    handler: async (ctx) => {
      if (availableModes.length === 0)
        return;
      const next = (currentModeIndex + 1) % availableModes.length;
      if (setMode(ctx, next))
        notifySwitch(ctx, next);
      else
        ctx.ui.notify("Session not ready yet", "warning");
    }
  });
  pi.registerShortcut("alt+shift+m", {
    description: "Previous mode",
    handler: async (ctx) => {
      if (availableModes.length === 0)
        return;
      const prev = (currentModeIndex - 1 + availableModes.length) % availableModes.length;
      if (setMode(ctx, prev))
        notifySwitch(ctx, prev);
      else
        ctx.ui.notify("Session not ready yet", "warning");
    }
  });
  pi.registerFlag("mode", {
    description: `Start in a specific mode (${PREFERRED_ORDER.join(" | ")})`,
    type: "string"
  });
  function clonePayload(payload) {
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(payload);
      } catch {}
    }
    return { ...payload };
  }
  function applySystemPayload(payload, text, replace) {
    const next = clonePayload(payload);
    if (typeof next.system === "string") {
      next.system = replace ? text : next.system + text;
    } else if (Array.isArray(next.system)) {
      next.system = replace ? [{ type: "text", text }] : [...next.system, { type: "text", text }];
    } else if (Array.isArray(next.messages)) {
      const sysIdx = next.messages.findIndex((m) => m.role === "system");
      if (sysIdx !== -1) {
        const sysMsg = next.messages[sysIdx];
        let newMsg;
        if (typeof sysMsg.content === "string") {
          newMsg = { ...sysMsg, content: replace ? text : sysMsg.content + text };
        } else if (Array.isArray(sysMsg.content)) {
          newMsg = { ...sysMsg, content: replace ? [{ type: "text", text }] : [...sysMsg.content, { type: "text", text }] };
        } else {
          newMsg = { ...sysMsg, content: text };
        }
        next.messages = [...next.messages.slice(0, sysIdx), newMsg, ...next.messages.slice(sysIdx + 1)];
      } else {
        next.messages = [{ role: "system", content: text }, ...next.messages];
      }
    }
    return next;
  }
  pi.on("before_provider_request", (event, _ctx) => {
    const mode = availableModes[currentModeIndex];
    if (!mode || !mode.prompt)
      return;
    if (mode.hasAgents) {
      return applySystemPayload(event.payload, `

[MODE: ${mode.name.toUpperCase()}]
${mode.prompt}`, false);
    } else {
      return applySystemPayload(event.payload, mode.prompt, true);
    }
  });
  function publishModeStatus(ctx, mode) {
    try {
      ctx.ui.setStatus("mode", mode.name);
    } catch (err) {
      console.warn(`[modes] Failed to publish mode status: ${err}`);
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    try {
      baselineTools = pi.getActiveTools();
    } catch (err) {
      console.warn(`[modes] Failed to initialize tools: ${err}`);
      return;
    }
    copyShippedModes();
    availableModes = loadAvailableModes(ctx.cwd);
    if (availableModes.length === 0) {
      ctx.ui.notify("[modes] No modes found. Extension inactive.", "warning");
      return;
    }
    const entries = ctx.sessionManager.getEntries();
    let restoredId;
    for (let i = entries.length - 1;i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === PERSIST_KEY) {
        const data = entry.data;
        if (typeof data?.mode === "string") {
          restoredId = data.mode;
          break;
        }
      }
    }
    const modeFlag = pi.getFlag("mode");
    let targetIndex;
    if (typeof modeFlag === "string" && modeFlag.trim()) {
      const flagIndex = availableModes.findIndex((m) => m.id === modeFlag.trim().toLowerCase());
      if (flagIndex !== -1) {
        targetIndex = flagIndex;
      } else {
        console.warn(`[modes] Unknown --mode "${modeFlag}". Available: ${availableModes.map((m) => m.id).join(", ")}`);
        const restoredIndex = restoredId ? availableModes.findIndex((m) => m.id === restoredId) : -1;
        const orch = availableModes.findIndex((m) => m.id === "orchestrator");
        targetIndex = restoredIndex !== -1 ? restoredIndex : orch !== -1 ? orch : 0;
      }
    } else if (restoredId) {
      const restoredIndex = availableModes.findIndex((m) => m.id === restoredId);
      if (restoredIndex !== -1) {
        targetIndex = restoredIndex;
      } else {
        console.warn(`[modes] Previously active mode "${restoredId}" no longer exists.`);
        const orch = availableModes.findIndex((m) => m.id === "orchestrator");
        targetIndex = orch !== -1 ? orch : 0;
      }
    } else {
      const orch = availableModes.findIndex((m) => m.id === "orchestrator");
      targetIndex = orch !== -1 ? orch : 0;
    }
    if (setMode(ctx, targetIndex)) {
      notifySwitch(ctx, targetIndex);
    }
  });
}
export {
  modesExtension as default
};
