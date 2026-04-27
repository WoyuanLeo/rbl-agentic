import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { Effect } from "effect"
import { HttpClient, serializeTask } from "./http-client.js"
import { HealthChecker } from "./health.js"
import { parseNodes, selectNode } from "./node.js"

interface HealthCacheEntry {
  healthy: boolean
  timestamp: number
}

type HealthCache = Record<string, HealthCacheEntry>

export const DistributionPlugin: Plugin = async (ctx: PluginInput) => {
  const healthCache: HealthCache = {}
  const HEALTH_CACHE_TTL = 30_000

  function isNodeHealthy(nodeId: string): boolean {
    const entry = healthCache[nodeId]
    if (!entry) return true
    return Date.now() - entry.timestamp < HEALTH_CACHE_TTL && entry.healthy
  }

  function getHealthyNodeIds(): string[] {
    const now = Date.now()
    return Object.entries(healthCache)
      .filter(([, entry]) => now - entry.timestamp < HEALTH_CACHE_TTL && entry.healthy)
      .map(([id]) => id)
  }

  return {
    remote_task: tool({
      description: "Send a task to a remote agent node via HTTP",
      args: {
        url: tool.schema.string().describe("Remote agent node URL (e.g., http://node1:8080)"),
        task_description: tool.schema.string().describe("Human-readable task description"),
        task_prompt: tool.schema.string().describe("Full task prompt for the remote agent"),
        subagent_type: tool.schema.string().describe("Subagent type to use (optional)").optional(),
      },
      execute: async (args, _ctx) => {
        const task = { description: args.task_description, prompt: args.task_prompt, subagent_type: args.subagent_type }
        const serialized = serializeTask(task)
        await Effect.runPromise(HttpClient.sendTask(args.url, { task: serialized }))
        return JSON.stringify({ success: true, url: args.url, task_id: serialized.substring(0, 20) })
      },
    }),

    find_available_nodes: tool({
      description: "Discover available remote agent nodes from OPENCODE_NODES",
      args: {},
      execute: async (_args, _ctx) => {
        const nodes = parseNodes()
        return JSON.stringify({ nodes, count: nodes.length })
      },
    }),

    check_node_health: tool({
      description: "Check health of a remote node (updates health cache)",
      args: { url: tool.schema.string().describe("Node URL to check") },
      execute: async (args, _ctx) => {
        const healthy = await Effect.runPromise(HealthChecker.checkHealth(args.url))
        const nodes = parseNodes()
        const node = nodes.find((n) => n.url === args.url)
        if (node) healthCache[node.id] = { healthy, timestamp: Date.now() }
        return JSON.stringify({ url: args.url, healthy, timestamp: Date.now() })
      },
    }),

    get_healthy_nodes: tool({
      description: "Get list of currently healthy remote nodes from health cache",
      args: {},
      execute: async (_args, _ctx) => {
        const nodes = parseNodes()
        const healthyIds = getHealthyNodeIds()
        const healthyNodes = nodes.filter((n) => healthyIds.includes(n.id))
        return JSON.stringify({ nodes: healthyNodes, count: healthyNodes.length })
      },
    }),

    select_node: tool({
      description: "Select the best available node for a specific agent type",
      args: { agent: tool.schema.string().describe("Agent type to match (e.g., 'explore', 'general')") },
      execute: async (args, _ctx) => {
        const nodes = parseNodes()
        const healthyMap: Record<string, boolean> = {}
        for (const node of nodes) healthyMap[node.id] = isNodeHealthy(node.id)
        const selected = selectNode(nodes, args.agent, healthyMap)
        return JSON.stringify({
          selected: selected ? { id: selected.id, url: selected.url, capabilities: selected.capabilities } : null,
          total_nodes: nodes.length,
          healthy_nodes: nodes.filter((n) => healthyMap[n.id]).length,
        })
      },
    }),

    event: async (input: { event: string | unknown }): Promise<void> => {
      if (input.event === "session.end" || input.event === "session.start") {
        const nodes = parseNodes()
        if (nodes.length === 0) return

        const results = await Effect.runPromise(
          Effect.all(
            nodes.map((n) =>
              HealthChecker.checkHealth(n.url).pipe(
                Effect.tap((healthy: boolean) => Effect.sync(() => { healthCache[n.id] = { healthy, timestamp: Date.now() } })),
                Effect.catchAll(() => Effect.succeed(false)),
              ),
            ),
            { concurrency: 5 },
          ),
        )

        const healthyCount = results.filter(Boolean).length
        console.log(`[distribution] Health check: ${healthyCount}/${nodes.length} nodes healthy`)
      }
    },
  } as Hooks
}

export { HttpClient, serializeTask } from "./http-client.js"
export { HealthChecker } from "./health.js"
export { parseNodes, selectNode } from "./node.js"
export type { Node } from "./node.js"
