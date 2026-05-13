# Memory Orchestration System — Setup Guide

## Overview

A plugin-based memory-driven orchestration system for OpenCode. It provides:

- **Cross-session memory** — Persistent SQLite with FTS5 full-text search and 30-day auto-pruning
- **Coordinator Agent** — Hybrid heuristic + LLM analysis that decomposes complex goals into tasks routed to the cheapest-sufficient agent
- **Skill/cost registry** — 10 agents with explicit skill levels and cost tiers; selection is automatic based on task complexity and budget cap
- **Distributed execution** — Remote agent nodes with health monitoring, failover, and circuit breaker

## Requirements

- Bun 1.0+ (`bun:sqlite` is Bun-only)
- OpenCode installed (`bun i -g @opencode-ai/opencode`)
- (Optional) Remote OpenCode instances for distributed mode

---

## Quick Start

### 1. Install Dependencies

```bash
cd mem-arch
bun install
bun run build
```

| Package | Purpose |
|---|---|
| `@mem-arch/memory` | Persistence layer, FTS5 search, task tracking, auto-pruning |
| `@mem-arch/coordination` | Coordinator agent, analysis engine, agent registry, orchestration |
| `@mem-arch/distribution` | Remote agent communication, health monitoring, failover |

### 2. Configure OpenCode

Add to your OpenCode config (`~/.opencode/config.json` or `<project>/.opencode/config.json`):

```json
{
  "plugin": [
    ["@mem-arch/memory", {}]
  ]
}
```

> **Note:** `@mem-arch/coordination` and `@mem-arch/distribution` are **libraries** (not standalone plugins) consumed by the memory plugin via dynamic imports. They do not need to be in the plugin list.

### 3. Apply OpenCode Custom Patches

Apply all patches described in [`opencode_patch.md`](./opencode_patch.md) after installing or upgrading OpenCode:

| # | Patch | Purpose |
|---|---|---|
| 1 | NPM patches | Bug fixes in `@npmcli/agent`, `@standard-community/standard-openapi`, `solid-js` |
| 2 | Coordinator agent registry | Register `@coordinator` agent (config in `coordinator-agent.ts`) |
| 3 | Korean/CJK IME fix | Fix IME last-character truncation in TUI prompt |
| 4 | Custom agent definitions | 8 custom `.md` agent files from `opencode/agent/` |
| 5 | Custom theme | Nord-based theme from `opencode/themes/custom-theme.json` |

### 4. Run

```bash
opencode
```

On start:
1. Conversations are persisted to `.opencode/memory.db`
2. Every 10 messages, coordinator analysis is triggered and injected into the system prompt (when confidence ≥ 0.5)
3. The `@coordinator` agent is available for goal decomposition
4. Old memory records are auto-pruned every 100 inserts (keeps last 30 days)

---

## How Agent Selection Works

The coordinator picks the **cheapest agent that meets the required skill level** for each subtask — no manual configuration needed.

### Agent Tiers

| Agent | Skill | Cost | Best for |
|---|---|---|---|
| `explore` | 2 | 🟢 low | research, file discovery |
| `regular-developer` | 2 | 🟢 low | routine implementation, small bug fixes |
| `general` | 3 | 🟡 medium | standard implementation and refactoring |
| `quality-assurance` | 3 | 🟡 medium | testing, verification |
| `code-reviewer` | 3 | 🟡 medium | code quality review |
| `investigation-bash-expert` | 3 | 🟡 medium | log analysis, shell diagnostics |
| `risk-reviewer` | 3 | 🟡 medium | security review, dependency risk |
| `reasoning-expert` | 4 | 🔴 high | complex trade-offs, decision analysis |
| `seasoned-developer` | 4 | 🔴 high | production debugging, incident response |
| `principal-engineer` | 5 | 🔴 high | architecture, cross-cutting design |

### Complexity Tiers

| Goal pattern | Complexity | Agents eligible |
|---|---|---|
| rename, move file | `routine` | skill ≥ 2 (low-cost first) |
| implement, refactor, debug | `moderate` | skill ≥ 3 (medium-cost first) |
| architecture, auth, migration | `complex` | skill ≥ 4 (high-cost) |
| production incident, data loss | `critical` | skill = 5 only |

### Escalation on Failure

If a task fails, the system automatically retries once with the next-tier-up agent for the same task type. The result is tagged `[escalated to <agent>]`. If already at the skill ceiling, the task is marked failed.

### Budget Cap

Override agent selection with a cost ceiling at decomposition time:

```typescript
import { decomposeGoal } from "@mem-arch/coordination"

decomposeGoal("implement user auth", { budgetCap: "low" })
// forces all subtasks to use only low-cost agents
```

---

## Analysis: Heuristic vs LLM

Analysis runs in two phases:

```
Phase 1 — Heuristic (always, zero cost)
  Keyword matching + stall detection → confidence score

Phase 2 — LLM fallback (only if confidence < 0.5)
  ctx.complete() with focused context (6 turns + task state)
  Single-turn call — no tool loop, minimal tokens
```

Guidance is injected into the system prompt **only when confidence ≥ 0.5**, so simple Q&A turns don't pay any injection cost.

---

## Distributed Mode (Optional)

### Start Remote Nodes

```bash
OPENCODE_NODES="http://node1:8080,http://node2:8080" opencode --agent
```

With capability declarations (pipe-separated):

```bash
OPENCODE_NODES="http://node1:8080:explore,code-reviewer|http://node2:8080:general" opencode --agent
```

### Distribution Tools

| Tool | Description |
|---|---|
| `remote_task` | Send a task to a specific node URL |
| `find_available_nodes` | List all discovered nodes |
| `check_node_health` | Check if a node URL is reachable |
| `get_healthy_nodes` | List nodes currently in good health |

### Remote Node Requirements

1. OpenCode in agent mode with `@mem-arch/memory` plugin
2. `/health` endpoint returning 200 OK
3. `/api/task` endpoint accepting POST JSON payload

---

## Configuration Reference

### Environment Variables

| Variable | Purpose | Example |
|---|---|---|
| `OPENCODE_NODES` | Remote node URLs | `http://node1:8080,http://node2:8080` |

### Plugin Options

```json
{
  "plugin": [
    ["@mem-arch/memory", {
      "analysisIntervalMessages": 10,
      "analysisTTL": 60000,
      "pruneAfterMs": 2592000000
    }]
  ]
}
```

> **Note:** Coordination and distribution options are configured internally via their library code and do not require plugin-level configuration.

---

## Using the System

### Global Memory Search

```
global_memory_query(query="authentication", limit=5, rank_by="relevance")
global_memory_query(session_id="sess-abc", rank_by="newest")
```

> When no `query` text is given, the FTS join is skipped for faster indexed lookups.

### Task Progress Tracking

```
update_task_progress(task_id="refactor-1", status="in_progress")
update_task_progress(task_id="refactor-1", status="completed", result={summary: "done"})
query_task_progress(status="completed")
```

### Coordinator Agent

```
User: "Refactor the entire auth module and update all test files"

@coordinator selects agents based on goal complexity (moderate → skill ≥ 3):
  ┌── Parallel Group (explore):
  │   ├── explore-code-targets  "Identify source files/functions to change"
  │   └── explore-test-targets  "Identify test files affected"
  └── Sequential:
      ├── apply-refactoring (general)     ← depends on both above
      └── update-tests (quality-assurance) ← depends on apply-refactoring
```

---

## Troubleshooting

### Coordinator guidance not appearing

1. Verify `@mem-arch/memory` plugin is loaded (it handles all analysis)
2. Analysis triggers every 10 messages — have at least 10 turns in the session
3. Guidance is only injected when `confidence ≥ 0.5` — a goal-oriented message is needed to raise confidence
4. The coordinator agent is built into OpenCode — no manual registration needed

### Memory search returns empty results

1. Verify `@mem-arch/memory` is in the plugin list (`~/.config/opencode/opencode.json`)
2. Database is at `./.opencode/memory.db`
3. Messages are captured on `chat.message` — ensure the plugin loaded before the conversation
4. FTS5 uses MATCH syntax — try a single keyword for broad results; avoid very short words

### Unexpected agent assignments

Use `inferComplexity()` and `inferTaskTypes()` to preview what the registry would infer:

```typescript
import { inferComplexity, inferTaskTypes, selectAgent } from "@mem-arch/coordination"

const types = inferTaskTypes("fix the login regression")   // ["bug-fix", "research"]
const complexity = inferComplexity("fix the login regression") // "moderate"
const { agent, reason } = selectAgent(types, complexity)
console.log(agent, reason)
// general  "Cheapest specialist: skill=3, cost=medium, matches [bug-fix]"
```

To use a higher-tier agent than the registry would normally select, pass `complexity` explicitly:

```typescript
decomposeGoal("fix the login regression", { complexity: "critical" })
// forces skill ≥ 5 → principal-engineer
```

### Remote nodes unreachable

1. Check `OPENCODE_NODES` format (comma-separated, no trailing spaces)
2. Verify `/health` responds on the correct port
3. Use `check_node_health(url)` to force a check (cache TTL is 30 s)
4. Circuit breaker opens after 3 consecutive failures — it half-opens after 60 s automatically

### Stale coordinator analysis

Analysis is cached for 60 s. Sending another message will trigger a fresh cycle once the TTL expires.

### Database growing unexpectedly

Auto-pruning runs every 100 inserts and removes records older than 30 days. To verify:

```bash
sqlite3 .opencode/memory.db "SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM memory;"
```

---

## Project Structure

```
mem-arch/
├── SETUP.md                          ← this file
├── memory-orchestration.md           ← architecture reference
├── project_progress.md               ← implementation tracker
├── package.json                      # workspace root
├── tsconfig.json
└── packages/
    ├── memory/
    │   └── src/
    │       ├── index.ts              # Plugin: hooks, tools, pruning, LLM delegate wiring
    │       ├── db.ts                 # SQLite: dual query paths, pruneMemory()
    │       └── schema.ts             # Schema: memory + memory_fts (FTS5) + task_progress
    ├── coordination/
    │   └── src/
    │       ├── index.ts              # Plugin entry + public re-exports
    │       ├── coordinator-agent.ts  # Agent config, system prompt loader, permissions
    │       ├── analyze.ts            # Heuristic + LLM fallback, confidence scoring
    │       ├── agent-registry.ts     # Skill/cost registry, selectAgent(), escalateAgent()
    │       ├── orchestrate.ts        # decomposeGoal(), executePlan() with escalation
    │       └── system-prompt.txt     # Coordinator LLM system prompt
    │
    > **Note:** `coordination` is a library imported dynamically by the memory plugin (e.g., `import("@mem-arch/coordination/analyze")`). It is not a standalone plugin.

    └── distribution/
        └── src/
            ├── index.ts              # Plugin: remote_task, find_nodes, health tools
            ├── http-client.ts        # sendTask(), sendBatch() (single request)
            ├── health.ts             # HealthChecker, FailoverManager, CircuitBreaker
            └── node.ts               # parseNodes(), selectNode(), initHealthCache()
```
