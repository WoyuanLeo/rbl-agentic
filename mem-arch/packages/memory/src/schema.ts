/**
 * SQL schema definitions for the memory database.
 * 
 * Tables:
 * - memory: Main message storage
 * - memory_fts: FTS5 virtual table for full-text search
 * - task_progress: Sub-agent task status tracking
 */

export const SCHEMA = [
  // Main memory table
  `CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent TEXT,
    provider_id TEXT,
    model_id TEXT,
    message_id TEXT,
    variant TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  // Indices for efficient querying
  `CREATE INDEX IF NOT EXISTS memory_session_idx ON memory (session_id)`,
  `CREATE INDEX IF NOT EXISTS memory_role_idx ON memory (role)`,
  `CREATE INDEX IF NOT EXISTS memory_created_at_idx ON memory (created_at)`,

  // FTS5 virtual table for full-text search
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    content_rowid = 'id'
  )`,

  // Triggers to keep FTS5 in sync with memory table
  `CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts (rowid, content) VALUES (new.id, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memory_fts (rowid, content) VALUES (new.id, new.content);
  END`,

  // Task progress tracking table
  `CREATE TABLE IF NOT EXISTS task_progress (
    task_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
    result TEXT,
    updated_at INTEGER NOT NULL
  )`,
] as const
