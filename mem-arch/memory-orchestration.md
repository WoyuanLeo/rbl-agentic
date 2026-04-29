# Memory-Driven Orchestration System

## 1. Overview

A plugin for OpenCode that provides cross-session memory persistence and a Coordinator Agent that decomposes complex goals into focused sub-tasks routed to the right agent at the right cost.

### OpenCode Reference
- Local source code: `/Users/tianzh/Workspace/opencode`
- Website: https://opencode.ai/docs

---

## 2. The Memory Plugin (`@mem-arch/memory`)

### Storage
- SQLite via `bun:sqlite` at `.opencode/memory.db`
- WAL mode + `NORMAL` sync for durability without write-latency overhead
- FTS5 virtual table (`memory_fts`) kept in sync via `AFTER INSERT/UPDATE/DELETE` triggers

### Message Capture
- `chat.message` hook — records every user/assistant turn in real time
- `experimental.chat.messages.transform` hook is **intentionally omitted** to avoid duplicate rows

### Auto-pruning
- Every 100 inserts, `db.pruneMemory(30 days)` evicts records older than 30 days
- Keeps the database bounded without a separate background process

### Query Paths
Two distinct SQL paths depending on whether a text search term is provided:

| Scenario | Path | Notes |
|---|---|---|
| `query` text provided | FTS5 `INNER JOIN memory_fts … MATCH` | BM25 relevance ranking available |
| No `query` (filter only) | Direct `SELECT * FROM memory` with indexed columns | Avoids unnecessary FTS join |

### Analysis & Injection
- `triggerAnalysis()` is debounced by a 60 s TTL and called every 10 inserts
- `experimental.chat.system.transform` injects `<coordinator_guidance>` only when `confidence ≥ 0.5` — idle/conversational turns are skipped to save tokens

### Exposed Tools

| Tool | Description |
|---|---|
| `global_memory_query` | FTS5 + filter search across all sessions |
| `update_task_progress` | Upsert task status / result |
| `query_task_progress` | List tasks by ID or status |

---

## 3. The Coordinator Agent (`@mem-arch/coordination`)

### 3.0 Identity: Pure Orchestrator

The coordinator **plans and delegates — it never performs the work itself.**

| Config | Value | Why |
|---|---|---|
| `steps` | **5** | assess → plan → spawn parallel → spawn sequential → report; any more and it starts doing work itself |
| `maxParallelTasks` | 5 | concurrent sub-agent cap |

**Permissions — orchestration tools only. No doing-tools.**

| Tool | Granted | Reason |
|---|---|---|
| `task` | ✅ | the only way to spawn sub-agents |
| `global_memory_query` | ✅ | check prior cross-session context |
| `update_task_progress` | ✅ | mark tasks in-progress / done |
| `query_task_progress` | ✅ | check sub-agent reports |
| `bash.execute` | ❌ | would let the coordinator do work itself |
| `read` | ❌ | would let the coordinator read files directly |
| `search` | ❌ | would let the coordinator bypass delegation |

> When an LLM sees callable tools it uses them. Granting doing-tools is the primary cause of coordinators that "prefer to work on the task themselves."

### 3.1 Analysis Engine (`analyze.ts`)

Two-phase hybrid:

```
Phase 1 — Heuristic (always runs, zero cost)
  • Keyword pattern match on recent user messages
  • Stall detection on active tasks (> 5 min without update)
  • Confidence score accumulated from each signal

  Signal                         Confidence added
  ─────────────────────────────────────────────────
  stalled tasks detected              +0.3
  goal keyword in recent messages     +0.4
  completed tasks exist               +0.1
  user driving turn ratio > 1.5×      +0.1
  baseline                             0.1

Phase 2 — LLM fallback (only when confidence < 0.5)
  • Builds focused context: last 6 turns + active/completed task state
  • Calls coordinator LLM via ctx.complete (single-turn, no tool loop)
  • Parses JSON from response (strips markdown fences, extracts first {…})
  • Falls back to heuristic result on parse failure or network error
  • LLM result is tagged "[llm]" in the analysis field for observability
```

### 3.2 Agent Skill & Cost Registry (`agent-registry.ts`)

All agent selection goes through a central registry instead of hardcoded names.

Each agent has:
- **`skill` (1–5)** — capability ceiling
- **`costTier`** — `low | medium | high`
- **`specializations`** — task-type tags the agent is optimised for

#### Agent Profiles (cheapest-first within tier)

| Agent | Skill | Cost | Specializations |
|---|---|---|---|
| `explore` | 2 | 🟢 low | research, refactor |
| `regular-developer` | 2 | 🟢 low | implementation, bug-fix, refactor |
| `general` | 3 | 🟡 medium | implementation, refactor, bug-fix |
| `quality-assurance` | 3 | 🟡 medium | testing, review |
| `code-reviewer` | 3 | 🟡 medium | review, refactor |
| `investigation-bash-expert` | 3 | 🟡 medium | logs-bash, bug-fix, research |
| `risk-reviewer` | 3 | 🟡 medium | security, review, architecture |
| `reasoning-expert` | 4 | 🔴 high | reasoning, architecture, bug-fix |
| `seasoned-developer` | 4 | 🔴 high | production, bug-fix, implementation |
| `principal-engineer` | 5 | 🔴 high | architecture, reasoning, security |

#### Task Types

`research` · `implementation` · `refactor` · `bug-fix` · `testing` · `review` · `architecture` · `security` · `logs-bash` · `reasoning` · `production`

#### Complexity → Required Skill

| Complexity | Skill required | Triggered by |
|---|---|---|
| `trivial` | 1 | (not used as default) |
| `routine` | 2 | rename, move file, add import |
| `moderate` | 3 | implement, refactor, debug, typescript error |
| `complex` | 4 | architecture, auth, migration, breaking change |
| `critical` | 5 | production incident, data loss, race condition |

#### `selectAgent()` Algorithm — Cheapest-Sufficient

```
1. infer task types from description text (regex patterns)
2. infer complexity from description text (regex patterns)
3. filter registry: skill ≥ required AND costWeight ≤ budgetCap
4. among eligible, prefer specialists (matching task types), cheapest first
5. if no specialist → cheapest generalist that meets skill threshold
6. if budget cap too tight → relax cap, pick cheapest qualified
```

#### Optional `budgetCap`

Pass `budgetCap: "low" | "medium"` to `decomposeGoal()` to hard-cap agent cost:

```typescript
decomposeGoal("implement user dashboard", { budgetCap: "low" })
// all agents capped to low-cost tier
```

### 3.3 Task Decomposition (`orchestrate.ts`)

`decomposeGoal(goal, opts?)` matches the goal against known templates and uses `selectAgent()` for every subtask slot:

| Template | Parallel root tasks | Sequential tasks |
|---|---|---|
| refactor / rename | explore-code-targets + explore-test-targets | apply-refactoring → update-tests |
| implement / build | research-patterns + research-tests | implement-feature |
| fix / debug | investigate-code + investigate-history | implement-fix → verify-fix |
| migrate / port | assess-source + assess-target | implement-migration → validate-migration |
| (fallback) | — | main-task (agent selected by registry) |

Parallel roots use the same agent type → auto-grouped into a `ParallelGroup`.

### 3.4 Parallel Execution (`executePlan`)

- Parallel groups: `Effect.forkIn(scope)` per task, then `Effect.all(fibers, {concurrency: "unbounded"})` to join — genuinely concurrent
- Sequential tasks: topological-order loop with dependency tracking
- **Escalation on failure**: when a sequential task fails, `escalateAgent()` selects the next cost tier up for the same task types and retries once before marking failed

### 3.5 Context Filtering (`filterContextForTask`)

Extracts keywords from the task prompt using:
1. **Bigrams first** (adjacent meaningful token pairs) — captures compound concepts like `"auth middleware"`
2. **Unigrams** — individual meaningful tokens
3. **~50-word stopword list** — eliminates noise tokens
4. **Early exit** — stops querying memory once `maxMemoryEntries` reached

---

## 4. Orchestration Workflow

```
1. Capture    chat.message hook → SQLite (user & assistant turns)
2. Analyze    every 10 inserts → heuristic analyze()
                confidence ≥ 0.5 → use heuristic (free)
                confidence < 0.5 → LLM fallback via ctx.complete
3. Gate       confidence ≥ 0.5? → inject <coordinator_guidance> into system prompt
                                → skip injection otherwise (saves tokens)
4. Decompose  User accepts goal → decomposeGoal()
                → selectAgent() picks cheapest-sufficient agent per subtask
                → parallel root tasks grouped into ParallelGroups
5. Execute    Parallel groups   → Effect.forkIn per task, joined concurrently
              Sequential tasks  → topological order
              On failure        → escalateAgent() → retry at next cost tier
6. Monitor    task results → update_task_progress → next analysis cycle
7. Health     HealthChecker polls remote nodes; FailoverManager retries on unhealthy
```

---

## 5. Distribution Plugin (`@mem-arch/distribution`)

| Component | File | Purpose |
|---|---|---|
| HTTP client | `http-client.ts` | Single-task POST and true single-request batch send |
| Health checker | `health.ts` | Per-URL health check with 5 s timeout, parallel multi-node check |
| Failover manager | `health.ts` | Try primary → backups in order; fail if all unhealthy |
| Circuit breaker | `health.ts` | Opens after N consecutive failures, half-opens after timeout |
| Node registry | `node.ts` | Parse `OPENCODE_NODES` env, capability-aware node selection |

### Node Discovery

```
OPENCODE_NODES="http://node1:8080,http://node2:8080"
```

Parsed at startup; optional capability declarations via pipe-separated format:

```
OPENCODE_NODES="http://node1:8080:explore,code-reviewer|http://node2:8080:general"
```

---

## 6. Relationship to OpenCode Plugin System

### Within Plugin Boundary
- Memory persistence, FTS5 search, task tracking — fully plugin-implementable
- Analysis + guidance injection via `experimental.chat.system.transform`
- LLM fallback via `ctx.complete` (single-turn model call, no tool loop)
- HTTP-based distributed communication

### Requires Core Extension
- **Coordinator agent registry entry** — must be added to `packages/opencode/src/agent/agent.ts`
- **Agent permissions** — tool access configuration lives in core agent config

---

## 7. Project Structure

```
mem-arch/
├── SETUP.md
├── memory-orchestration.md        ← this file
├── project_progress.md
├── package.json                   # workspace root
├── tsconfig.json
└── packages/
    ├── memory/
    │   └── src/
    │       ├── index.ts           # Plugin: hooks, tools, pruning, LLM delegate wiring
    │       ├── db.ts              # SQLite: dual query paths, pruneMemory()
    │       └── schema.ts          # Schema: memory + memory_fts (FTS5) + task_progress
    ├── coordination/
    │   └── src/
    │       ├── index.ts           # Plugin entry + re-exports
    │       ├── coordinator-agent.ts  # Agent config, system prompt loader, permissions
    │       ├── analyze.ts         # Heuristic analysis + LLM fallback + confidence scoring
    │       ├── agent-registry.ts  # Skill/cost registry, selectAgent(), escalateAgent()
    │       ├── orchestrate.ts     # decomposeGoal(), executePlan() with escalation
    │       └── system-prompt.txt  # Coordinator LLM system prompt
    └── distribution/
        └── src/
            ├── index.ts           # Plugin: remote_task, find_nodes, health tools
            ├── http-client.ts     # sendTask(), sendBatch() (single request), serialize
            ├── health.ts          # HealthChecker, FailoverManager, CircuitBreaker
            └── node.ts            # parseNodes(), selectNode(), initHealthCache()
```
