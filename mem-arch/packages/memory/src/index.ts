console.error("[PLUGIN] Module path:", import.meta.url)

import { writeLog } from "./writeLog.js"

writeLog("[PLUGIN] Module path: " + import.meta.url)

writeLog('[MEMORY PLUGIN LOADED] src/index.ts version with try/catch')

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { openDatabase, type MemoryDB } from "./db.js"

function extractContent(parts: unknown[]): string {
  return parts
    .filter((p: any) => p.type === "text" || p.type === "image" || p.type === "tool-use" || p.type === "tool-result")
    .map((p: any) => {
      if (p.type === "text") return p.text
      if (p.type === "image") return `[Image: ${p.url}]`
      if (p.type === "tool-use") return `[Tool Use: ${p.tool?.name ?? "unknown"}]`
      return `[Tool Result: ${p.tool?.name ?? "unknown"}]`
    })
    .join("\n")
}

function extractQueryContent(query: unknown): string {
  if (typeof query === "string") return query
  if (Array.isArray(query)) {
    return query
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join(" ")
  }
  return String(query ?? "")
}

export const MemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const db: MemoryDB = openDatabase(ctx.directory)

  let lastAnalysis = ""
  let lastAnalysisAt = 0
  const ANALYSIS_TTL = 60_000
  // Auto-prune: keep messages from the last 30 days; check every 100 inserts
  const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
  let insertsSincePrune = 0

  async function triggerAnalysis(): Promise<void> {
    const now = Date.now()
    if (now - lastAnalysisAt < ANALYSIS_TTL) return
    lastAnalysisAt = now
    try {
      // @ts-expect-error dynamic import
      const mod = await import("@mem-arch/coordination/analyze")
      if (typeof mod.analyzeWithFallback !== "function") return

      // Build an LLMDelegate if ctx exposes a model completion API.
      // ctx.complete is OpenCode's built-in single-turn model call (no tool loop).
      let llmDelegate: ((sys: string, msg: string) => Promise<string>) | undefined
      if (typeof (ctx as any).complete === "function") {
        llmDelegate = async (systemPrompt: string, userMessage: string) => {
          return (ctx as any).complete({ system: systemPrompt, prompt: userMessage }) as Promise<string>
        }
      }

      // Load the coordinator system prompt from coordination package
      let systemPrompt: string | undefined
      try {
        // @ts-expect-error dynamic import
        const coordMod = await import("@mem-arch/coordination/coordinator-agent")
        systemPrompt = typeof coordMod.getCoordinatorPrompt === "function"
          ? coordMod.getCoordinatorPrompt()
          : undefined
      } catch { /* system prompt optional */ }

      lastAnalysis = await mod.analyzeWithFallback(db, llmDelegate, systemPrompt)
    } catch {
      // Coordinator not available; skip silently
    }
  }

  return {
    tool: {
      global_memory_query: ((): any => {
        try {
          writeLog("[TOOL] Defining global_memory_query tool")
          return tool({
            description: "Query the global memory across all sessions with keyword and semantic search",
            args: {
              query: tool.schema.string().describe("Search query to match against message content (supports FTS5 syntax)"),
              limit: tool.schema.number().describe("Maximum number of results to return").default(10),
              session_id: tool.schema.string().describe("Filter by session ID (optional)").optional(),
              role: tool.schema.enum(["user", "assistant"]).describe("Filter by role (optional)").optional(),
              rank_by: tool.schema.enum(["relevance", "newest", "oldest"]).describe("Rank results by relevance, newest first, or oldest first").default("relevance"),
            },
            execute: async (args: any, _ctx: any) => {
            try {
                const rawQuery = extractQueryContent(args.query);
                const typedArgs = { ...args, query: rawQuery || undefined };
                const results = db.queryMessages(typedArgs);
                return JSON.stringify({ results, count: results.length, rank_by: typedArgs.rank_by });
            } catch (err: unknown) {
                const e = err as Error;
                return JSON.stringify({
                    error: e.message,
                    stack: e.stack,
                    args: JSON.stringify(args)
                });
            }
            },
          })
        } catch (e) {
          writeLog(`[TOOL] Schema definition error: ${e}`)
          return null
        }
      })(),
  
      update_task_progress: tool({
        description: "Update the progress/status of a sub-agent task",
        args: {
          task_id: tool.schema.string().describe("Unique identifier for the task"),
          status: tool.schema.enum(["pending", "in_progress", "completed", "failed"]).describe("Current status of the task"),
          result: tool.schema.string().describe("Result data (optional)").optional(),
        },
        execute: async (args, _ctx) => {
          db.upsertTask({ task_id: args.task_id, status: args.status, result: args.result, updated_at: Date.now() })
          return JSON.stringify({ success: true, task_id: args.task_id, status: args.status })
        },
      }),
  
      query_task_progress: tool({
        description: "Query the progress of sub-agent tasks",
        args: {
          task_id: tool.schema.string().describe("Specific task ID (optional)").optional(),
          status: tool.schema.enum(["pending", "in_progress", "completed", "failed"]).describe("Filter by status (optional)").optional(),
        },
        execute: async (args, _ctx) => {
          writeLog(`[query_task_progress] RAW ARGS from LLM: ${JSON.stringify(args, null, 2)}`)
          const results = db.queryTasks(args)
          return JSON.stringify({ results, count: results.length })
        },
      }),
    },

    "chat.message": async (
      input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
      output: { message: { role: string }; parts: unknown[] },
    ): Promise<void> => {
      const content = extractContent(output.parts)
      if (!content) return

      db.insertMessage({
        session_id: input.sessionID,
        agent: input.agent ?? null,
        provider_id: input.model?.providerID ?? null,
        model_id: input.model?.modelID ?? null,
        message_id: input.messageID ?? null,
        variant: input.variant ?? null,
        role: output.message.role as "user" | "assistant",
        content,
        created_at: Date.now(),
      })

      insertsSincePrune++
      if (insertsSincePrune >= 100) {
        insertsSincePrune = 0
        db.pruneMemory(PRUNE_AFTER_MS)
      }

      const count = db.getMemoryCount()
      if (count % 10 === 0) {
        await triggerAnalysis()
      }
    },

    // NOTE: experimental.chat.messages.transform is intentionally omitted here.
    // The chat.message hook already captures every turn as it arrives; using
    // both hooks would write duplicate rows to the memory table.

    "experimental.chat.system.transform": async (_input, output): Promise<void> => {
      await triggerAnalysis()
      if (lastAnalysis) {
        // Only pay the token cost if the analysis is actionable
        let shouldInject = false
        try {
          // @ts-expect-error dynamic import
          const mod = await import("@mem-arch/coordination/analyze")
          const threshold: number = mod.INJECT_CONFIDENCE_THRESHOLD ?? 0.5
          const parsed = JSON.parse(lastAnalysis) as { confidence?: number }
          shouldInject = (parsed.confidence ?? 0) >= threshold
        } catch {
          // If we can't parse confidence, fall back to injecting
          shouldInject = true
        }
        if (shouldInject) {
          const out = output as { system: string[] }
          out.system.push(`<coordinator_guidance>\n${lastAnalysis}\n</coordinator_guidance>`)
        }
      }
    },

    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ): Promise<void> => {
      if (input.tool === "global_memory_query") {
        writeLog(`[BEFORE EXEC] tool=${input.tool}, args=${JSON.stringify(output.args)}`)
        writeLog(`[BEFORE EXEC] args keys: ${output.args ? Object.keys(output.args).join(", ") : "none"}`)
        writeLog(`[BEFORE EXEC] args.query type: ${typeof output.args?.query}`)
        writeLog(`[BEFORE EXEC] args.query value: ${JSON.stringify(output.args?.query)}`)
      }
    },

    "tool.execute.after": async (
      input: { tool: string; args?: Record<string, unknown>; callID?: string },
      _output: unknown,
    ): Promise<void> => {
      // Debug: log global_memory_query calls
      if (input.tool === "global_memory_query") {
        writeLog(`[DEBUG] global_memory_query called with args: ${JSON.stringify(input.args)}`)
      }

      if (input.tool !== "task" || !input.args?.subagent_type) return

      const taskId = input.callID || `${input.args.subagent_type}:${Date.now()}`
      db.upsertTask({ task_id: taskId, status: "completed", result: JSON.stringify(input.args), updated_at: Date.now() })
    },
  }
}

export type { MemoryDB } from "./db.js"
