/**
 * Delegation Reminder Extension
 *
 * Injects a system prompt reminder on every agent turn that enforces
 * subagent delegation for specific task types. This ensures the model
 * always considers delegating rather than doing everything itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DELEGATION_REMINDER = `

## Delegation Rules ( Mandatory )

You must delegate the following tasks to subagents instead of doing them yourself:

- **Codebase exploration** → use scout: \`subagent({ agent: "scout", task: "..." })\`
- **External docs / web research** → use researcher: \`subagent({ agent: "researcher", task: "..." })\`
- **UI/UX work (styling, layout, visual polish)** → use designer: \`subagent({ agent: "designer", task: "..." })\`
- **Implementation of complex multi-file changes** → use worker: \`subagent({ agent: "worker", task: "..." })\`
- **Code review after changes** → use reviewer: \`subagent({ agent: "reviewer", task: "..." })\` with context: "fresh"
- **Architecture / design decisions with trade-offs** → use oracle: \`subagent({ agent: "oracle", task: "..." })\`
- **Planning before implementation** → use planner: \`subagent({ agent: "planner", task: "..." })\`

The main agent orchestrates - it does NOT write every line of code or explore every file itself. Orchestrate, then delegate.

When unsure what the user wants, use the \`ask_user_question\` tool instead of guessing.
`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    // Only inject if the subagent tool is available
    const tools = pi.getAllTools();
    const hasSubagent = tools.some((t) => t.name === "subagent");
    const hasQuestion = tools.some((t) => t.name === "ask_user_question");
    const hasTodo = tools.some((t) => t.name === "todo");

    let reminder = DELEGATION_REMINDER;
    if (!hasSubagent) {
      reminder = reminder.replace(/- \*\*[^*]+\*\* → use \w+: `subagent[^`]+`\n/g, "");
      reminder = reminder.replace(/The main agent orchestrates.*\n/, "");
      reminder = reminder.replace(/Orchestrate, then delegate\.\n/, "");
    }
    if (!hasQuestion) {
      reminder = reminder.replace(/When unsure.*\n/, "");
    }
    if (!hasTodo) {
      // Todo reminder not applicable
    }

    return {
      systemPrompt: reminder,
    };
  });
}
