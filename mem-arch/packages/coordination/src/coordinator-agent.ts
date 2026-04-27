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
    "High-level agent that decomposes complex goals into focused tasks and coordinates sub-agents for parallel execution",
  mode: "primary" as const,
  steps: 20,
  options: {
    allowConcurrentTasks: true,
    maxParallelTasks: 5,
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

Provide your response as structured JSON with analysis, recommendations, tasks, and parallel_groups.`
  }
}

/**
 * Permission ruleset for the coordinator agent.
 * Grants access to memory query, task delegation, and essential tools.
 */
export const coordinatorPermissions = {
  global_memory_query: "allow",
  task: "allow",
  "bash.execute": "allow",
  read: "allow",
  search: "allow",
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
