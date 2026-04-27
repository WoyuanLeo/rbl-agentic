import { Database } from "bun:sqlite"
import path from "path"
import fs from "fs"
import { SCHEMA } from "./schema.js"

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

export interface InsertMessageParams {
  session_id: string
  agent?: string | null
  provider_id?: string | null
  model_id?: string | null
  message_id?: string | null
  variant?: string | null
  role: "user" | "assistant"
  content: string
  created_at: number
}

export interface QueryMessagesParams {
  query?: string
  limit?: number
  session_id?: string
  role?: "user" | "assistant"
  rank_by?: "relevance" | "newest" | "oldest"
}

export interface UpsertTaskParams {
  task_id: string
  status: "pending" | "in_progress" | "completed" | "failed"
  result?: unknown
  updated_at: number
}

export interface QueryTaskParams {
  task_id?: string
  status?: "pending" | "in_progress" | "completed" | "failed"
}

export interface MemoryDB {
  insertMessage(params: InsertMessageParams): void
  queryMessages(params: QueryMessagesParams): MemoryRow[]
  getMemoryCount(): number
  upsertTask(params: UpsertTaskParams): void
  queryTasks(params: QueryTaskParams): TaskRow[]
}

export function openDatabase(projectDir: string): MemoryDB {
  const dbDir = path.join(projectDir, ".opencode")
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, "memory.db")
  const db = new Database(dbPath)

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")

  for (const stmt of SCHEMA) {
    db.run(stmt)
  }

  const insert = db.prepare(`
    INSERT INTO memory (session_id, agent, provider_id, model_id, message_id, variant, role, content, created_at)
    VALUES ($session_id, $agent, $provider_id, $model_id, $message_id, $variant, $role, $content, $created_at)
  `)

  const upsertTask = db.prepare(`
    INSERT INTO task_progress (task_id, status, result, updated_at)
    VALUES ($task_id, $status, $result, $updated_at)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      result = excluded.result,
      updated_at = excluded.updated_at
  `)

  const countQuery = db.prepare("SELECT COUNT(*) as n FROM memory")

  return {
    insertMessage(params: InsertMessageParams): void {
      ;(insert as any).run({
        $session_id: params.session_id,
        $agent: params.agent,
        $provider_id: params.provider_id,
        $model_id: params.model_id,
        $message_id: params.message_id,
        $variant: params.variant,
        $role: params.role,
        $content: params.content,
        $created_at: params.created_at,
      })
    },

    queryMessages(params: QueryMessagesParams): MemoryRow[] {
      const conditions: string[] = []
      const binds: (string | number)[] = []

      if (params.query) {
        conditions.push("mf.content MATCH ?")
        binds.push(params.query)
      }
      if (params.session_id) {
        conditions.push("m.session_id = ?")
        binds.push(params.session_id)
      }
      if (params.role) {
        conditions.push("m.role = ?")
        binds.push(params.role)
      }

      let orderBy = "bm25(memory_fts) ASC"
      if (params.rank_by === "newest") orderBy = "m.created_at DESC"
      if (params.rank_by === "oldest") orderBy = "m.created_at ASC"

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
      const limit = params.limit ?? 10

      const sql = `SELECT m.* FROM memory m INNER JOIN memory_fts mf ON m.id = mf.rowid ${where} ORDER BY ${orderBy} LIMIT ?`
      return db.query(sql).all(...binds, limit) as MemoryRow[]
    },

    getMemoryCount(): number {
      return (countQuery.get() as { n: number }).n
    },

    upsertTask(params: UpsertTaskParams): void {
      ;(upsertTask as any).run({
        $task_id: params.task_id,
        $status: params.status,
        $result: params.result != null ? JSON.stringify(params.result) : null,
        $updated_at: params.updated_at,
      })
    },

    queryTasks(params: QueryTaskParams): TaskRow[] {
      const conditions: string[] = []
      const binds: (string | number)[] = []

      if (params.task_id) {
        conditions.push("task_id = ?")
        binds.push(params.task_id)
      }
      if (params.status) {
        conditions.push("status = ?")
        binds.push(params.status)
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
      return db.query(
        `SELECT * FROM task_progress ${where} ORDER BY updated_at DESC`
      ).all(...binds) as TaskRow[]
    },
  }
}
