import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Coordinator Agent Configuration
// ---------------------------------------------------------------------------

/**
 * Coordinator Agent definition for the OpenCode agent registry.
 * 
 * This is used when adding the coordinator to the core agent registry
 * in packages/opencode/src/agent/agent.ts
 */
export const coordinatorAgentConfig = {
  name: "coordinator",
  description:
    "Pure orchestrator: decomposes goals into sub-tasks and delegates to specialised agents. Never performs the work itself.",
  mode: "primary" as const,
  // 5 steps: assess → plan → spawn parallel → spawn sequential → report
  // More steps = coordinator starts doing the work itself
  steps: 5,
  options: {
    allowConcurrentTasks: true,
    maxParallelTasks: 5,
    maxConcurrencyPerAgent: 1,
  },
} as const

/**
 * Read the system prompt from the bundled text file.
 */
export function getCoordinatorPrompt(): string {
  try {
    return readFileSync(join(__dirname, "system-prompt.txt"), "utf-8")
  } catch {
    // Fallback inline prompt if file read fails
    return `You are the Coordinator Agent. Decompose complex goals into focused tasks and coordinate sub-agents.

Available sub-agents: explore, general, code-reviewer, principal-engineer, quality-assurance, and others.

For each complex goal, break it into:
1. Parallel groups (independent tasks, same agent) for concurrent execution
2. Sequential tasks (with dependencies) that must run in order
3. Mandatory pre-closure code-reviewer check for progress + implementation quality

Do not declare completion when review gaps exist. Revisit gaps first.

Provide your response as structured JSON with analysis, recommendations, tasks, and parallel_groups.`
  }
}

/**
 * Permission ruleset for the coordinator agent.
 *
 * ONLY orchestration tools are granted — no doing-tools (read, search, bash).
 * If the coordinator has read/search/bash, the LLM will use them directly
 * instead of delegating, defeating the purpose of the orchestrator.
 *
 * Allowed:
 *   task                  — spawn a sub-agent
 *   global_memory_query   — check prior cross-session context
 *   update_task_progress  — mark tasks in-progress / completed / failed
 *   query_task_progress   — check what sub-agents have reported back
 *
 * Explicitly NOT granted: bash.execute, read, write, search, edit
 */
export const coordinatorPermissions = {
  task: "allow",
  global_memory_query: "allow",
  update_task_progress: "allow",
  query_task_progress: "allow",
} as const

/**
 * Full registry entry for adding coordinator to the core agent registry.
 * 
 * Usage in core (packages/opencode/src/agent/agent.ts):
 *   coordinator: { ...coordinatorRegistryEntry },
 */
export const coordinatorRegistryEntry = {
  name: coordinatorAgentConfig.name,
  description: coordinatorAgentConfig.description,
  prompt: getCoordinatorPrompt(),
  mode: coordinatorAgentConfig.mode,
  steps: coordinatorAgentConfig.steps,
  permission: coordinatorPermissions,
  options: coordinatorAgentConfig.options,
}

/**
 * Type definition for the coordinator agent config structure.
 */
export type CoordinatorConfig = typeof coordinatorAgentConfig
export type CoordinatorPermissions = typeof coordinatorPermissions
