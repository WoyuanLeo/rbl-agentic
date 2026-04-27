import { Effect } from "effect"
import type { Node } from "./node.js"

export const HttpClient = {
  sendTask: (nodeUrl: string, task: unknown, metadata?: Record<string, unknown>): Effect.Effect<void, Error> =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${nodeUrl}/api/task`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task: typeof task === "string" ? task : JSON.stringify(task),
            metadata,
          }),
        })
        if (!res.ok) {
          const errorBody = await res.text().catch(() => "")
          throw new Error(`HTTP ${res.status} sending task to ${nodeUrl}: ${errorBody}`)
        }
      },
      catch: (e) => e instanceof Error ? e : new Error(String(e)),
    }),

  getTaskResult: (nodeUrl: string, taskId: string): Effect.Effect<string, Error> =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${nodeUrl}/api/task/${taskId}`, {
          headers: { "content-type": "application/json" },
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} getting task result from ${nodeUrl}`)
        }
        return res.text()
      },
      catch: (e) => e instanceof Error ? e : new Error(String(e)),
    }),

  discoverNodes: (): Effect.Effect<Node[], never> =>
    Effect.sync(() => {
      const raw = process.env["OPENCODE_NODES"] ?? ""
      return raw
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
        .map((url: string, i: number) => ({
          id: `node-${i}`,
          url: url.replace(/\/$/, ""),
          capabilities: [],
        }))
    }),

  sendBatch: (nodeUrl: string, tasks: unknown[]): Effect.Effect<number, Error> =>
    Effect.tryPromise({
      try: async () => {
        let sent = 0
        for (const task of tasks) {
          try {
            const res = await fetch(`${nodeUrl}/api/task/batch`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tasks: tasks.map((t) => (typeof t === "string" ? t : JSON.stringify(t))) }),
            })
            if (res.ok) sent++
          } catch {
            // Skip failed tasks
          }
        }
        return sent
      },
      catch: (e) => e instanceof Error ? e : new Error(String(e)),
    }),
}

export function serializeTask(task: unknown): string {
  try {
    return JSON.stringify(task)
  } catch {
    return JSON.stringify({
      type: (task as any)?.constructor?.name ?? "Unknown",
      data: String(task),
    })
  }
}

export function deserializeTask<T = unknown>(data: string): T {
  try {
    return JSON.parse(data) as T
  } catch {
    return data as unknown as T
  }
}

export function serializeBatch(tasks: unknown[]): string[] {
  return tasks.map(serializeTask)
}
