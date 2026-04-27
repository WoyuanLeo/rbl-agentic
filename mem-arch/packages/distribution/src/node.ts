export interface Node {
  id: string
  url: string
  capabilities: string[]
  healthy?: boolean
  lastChecked?: number
}

export function parseNodes(): Node[] {
  const raw = process.env["OPENCODE_NODES"] ?? ""
  if (!raw.trim()) return []

  return raw
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)
    .map((url: string, i: number) => ({
      id: `node-${i}`,
      url: url.replace(/\/$/, ""),
      capabilities: [],
      healthy: undefined,
      lastChecked: undefined,
    }))
}

export function parseNodesWithCapabilities(): Node[] {
  const raw = process.env["OPENCODE_NODES"] ?? ""
  if (!raw.trim()) return []

  return raw
    .split("|")
    .map((chunk: string) => {
      const parts = chunk.split(":")
      return {
        id: `node-${chunk.trim()}`,
        url: parts[0]!.trim().replace(/\/$/, ""),
        capabilities: parts[1] ? parts[1].split(",").map((c: string) => c.trim()) : [],
      }
    })
    .filter((n) => n.url)
}

export function getHealthyNodes(nodes: Node[], healthyMap: Record<string, boolean>): Node[] {
  return nodes.filter((n) => healthyMap[n.id] !== false)
}

export function selectNode(
  nodes: Node[],
  taskAgent: string,
  healthyMap: Record<string, boolean>,
): Node | null {
  const healthy = getHealthyNodes(nodes, healthyMap)
  if (healthy.length === 0) return null

  const match = healthy.find((n) => n.capabilities.includes(taskAgent))
  if (match) return match

  return healthy[0]
}

export function initHealthCache(nodes: Node[]): Record<string, { healthy: boolean; timestamp: number }> {
  const cache: Record<string, { healthy: boolean; timestamp: number }> = {}
  for (const node of nodes) {
    cache[node.id] = { healthy: true, timestamp: 0 }
  }
  return cache
}
