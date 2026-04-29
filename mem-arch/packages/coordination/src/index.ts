import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

// ---------------------------------------------------------------------------
// Minimal MemoryDB interface for coordination (avoids cross-package TS issues)
// ---------------------------------------------------------------------------

export interface MemoryRow {
  id: number
  session_id: string
  agent: string | null
  provider_id: string | null
  model_id: string | null
  message_id: string | null
  variant: string | null
  role: "user" | "assistant"
  content: string
  created_at: number
}

export interface TaskRow {
  task_id: string
  status: "pending" | "in_progress" | "completed" | "failed"
  result: string | null
  updated_at: number
}

export interface MemoryDB {
  queryMessages(params: { query?: string; limit?: number; session_id?: string; role?: string; rank_by?: string }): MemoryRow[]
  queryTasks(params: { task_id?: string; status?: string }): TaskRow[]
  getMemoryCount(): number
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const CoordinationPlugin: Plugin = async (_ctx: PluginInput) => {
  return {
    config: async (_config: unknown): Promise<void> => {},
    tool: {
      orchestration_status: tool({
        description: "Get the current orchestration status including memory stats, task progress, and analysis insights",
        args: {
          include_recent_goals: tool.schema.boolean().describe("Include detected recent goals").default(true),
        },
        execute: async (args, _ctx) => {
          return JSON.stringify({
            status: "active",
            features: ["memory_persistence", "task_tracking", "coordinator_analysis", "parallel_execution"],
          })
        },
      }),
    },
  }
}

export { analyze, analyzeWithFallback } from "./analyze.js"
export { coordinatorAgentConfig, getCoordinatorPrompt, coordinatorPermissions, coordinatorRegistryEntry } from "./coordinator-agent.js"
export { decomposeGoal, executePlan, executeSubAgent, filterContextForTask } from "./orchestrate.js"
export { AGENT_REGISTRY, getAgentProfile, selectAgent, escalateAgent, inferComplexity, inferTaskTypes } from "./agent-registry.js"

export type { AnalysisResult, LLMDelegate } from "./analyze.js"
export type { Task, ParallelGroup, OrchestrationPlan, TaskResult, DecomposeOptions } from "./orchestrate.js"
export type { AgentProfile, CostTier, TaskType, TaskComplexity, SelectionResult } from "./agent-registry.js"
