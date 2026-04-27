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

export const MemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const db: MemoryDB = openDatabase(ctx.directory)

  let lastAnalysis = ""
  let lastAnalysisAt = 0
  const ANALYSIS_TTL = 60_000

  async function triggerAnalysis(): Promise<void> {
    const now = Date.now()
    if (now - lastAnalysisAt < ANALYSIS_TTL) return
    lastAnalysisAt = now
    try {
      // @ts-expect-error dynamic import
      const mod = await import("@mem-arch/coordination/analyze")
      if (typeof mod.analyze === "function") {
        lastAnalysis = mod.analyze(db)
      }
    } catch {
      // Coordinator not available; skip silently
    }
  }

  return {
    global_memory_query: tool({
      description: "Query the global memory across all sessions with keyword and semantic search",
      args: {
        query: tool.schema.string().describe("Search query to match against message content (supports FTS5 syntax)"),
        limit: tool.schema.number().describe("Maximum number of results to return").default(10),
        session_id: tool.schema.string().describe("Filter by session ID (optional)").optional(),
        role: tool.schema.enum(["user", "assistant"]).describe("Filter by role (optional)").optional(),
        rank_by: tool.schema.enum(["relevance", "newest", "oldest"]).describe("Rank results by relevance, newest first, or oldest first").default("relevance"),
      },
      execute: async (args, _ctx) => {
        const results = db.queryMessages(args)
        return JSON.stringify({ results, count: results.length, rank_by: args.rank_by })
      },
    }),

    update_task_progress: tool({
      description: "Update the progress/status of a sub-agent task",
      args: {
        task_id: tool.schema.string().describe("Unique identifier for the task"),
        status: tool.schema.enum(["pending", "in_progress", "completed", "failed"]).describe("Current status of the task"),
        result: tool.schema.unknown().describe("Result data (optional)").optional(),
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
        const results = db.queryTasks(args)
        return JSON.stringify({ results, count: results.length })
      },
    }),

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

      const count = db.getMemoryCount()
      if (count % 10 === 0) {
        await triggerAnalysis()
      }
    },

    "experimental.chat.messages.transform": async (_input, output): Promise<void> => {
      const now = Date.now()
      const msgs = output as { messages: Array<{ info: Record<string, unknown>; parts: unknown[] }> }

      for (const { info, parts } of msgs.messages) {
        const content = extractContent(parts)
        if (!content) continue

        const infoAny = info as Record<string, any>
        const createdAt = (infoAny.time?.created ?? now) as number
        const providerID = (infoAny.model?.providerID ?? infoAny.providerID) as string | undefined
        const modelID = (infoAny.model?.modelID ?? infoAny.modelID) as string | undefined
        const variant = (infoAny.model?.variant ?? infoAny.variant) as string | undefined

        db.insertMessage({
          session_id: infoAny.sessionID as string,
          agent: (infoAny.agent ?? null) as string | null,
          provider_id: providerID ?? null,
          model_id: modelID ?? null,
          message_id: (infoAny.id ?? null) as string | null,
          variant: variant ?? null,
          role: infoAny.role as "user" | "assistant",
          content,
          created_at: createdAt,
        })
      }
    },

    "experimental.chat.system.transform": async (_input, output): Promise<void> => {
      await triggerAnalysis()
      if (lastAnalysis) {
        const out = output as { system: string[] }
        out.system.push(`<coordinator_guidance>\n${lastAnalysis}\n</coordinator_guidance>`)
      }
    },

    "tool.execute.after": async (
      input: { tool: string; args?: Record<string, unknown>; callID?: string },
      _output: unknown,
    ): Promise<void> => {
      if (input.tool !== "task" || !input.args?.subagent_type) return

      const taskId = input.callID || `${input.args.subagent_type}:${Date.now()}`
      db.upsertTask({ task_id: taskId, status: "completed", result: JSON.stringify(input.args), updated_at: Date.now() })
    },
  }
}

export type { MemoryDB } from "./db.js"
