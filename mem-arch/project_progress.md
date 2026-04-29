# Memory Orchestration System — Project Progress

## Overview

Tracking implementation of the memory-driven orchestration system across 4 phases plus post-launch optimisations.

**Status:** 🟢 Complete — All 4 phases built + optimisation pass applied

---

## Phase 1: Memory Plugin (Persistence Layer)

| Task | File | Status |
|---|---|---|
| 1.1 SQLite storage handler | `packages/memory/src/db.ts` | ✅ Complete |
| 1.2 SQL schema definitions | `packages/memory/src/schema.ts` | ✅ Complete |
| 1.3 Plugin entry point | `packages/memory/src/index.ts` | ✅ Complete |
| 1.4 Capture hook (`chat.message`) | `packages/memory/src/index.ts` | ✅ Complete |
| 1.5 ~~Replay hook (`messages.transform`)~~ | removed — duplicate capture | ✅ Fixed |
| 1.6 Search tool (`global_memory_query`) | `packages/memory/src/index.ts` | ✅ Complete |
| 1.7 Progress tracking tools | `packages/memory/src/index.ts` | ✅ Complete |
| 1.8 Progress hook (`tool.execute.after`) | `packages/memory/src/index.ts` | ✅ Complete |
| 1.9 System transform hook | `packages/memory/src/index.ts` | ✅ Complete |
| 1.10 Package config | `packages/memory/package.json` | ✅ Complete |

---

## Phase 2: Coordination Plugin (Intelligence Layer)

| Task | File | Status |
|---|---|---|
| 2.1 Coordinator agent config | `packages/coordination/src/coordinator-agent.ts` | ✅ Complete |
| 2.2 System prompt | `packages/coordination/src/system-prompt.txt` | ✅ Complete |
| 2.3 Analysis engine | `packages/coordination/src/analyze.ts` | ✅ Complete |
| 2.4 Plugin entry point | `packages/coordination/src/index.ts` | ✅ Complete |
| 2.5 Core registry entry | `packages/opencode/src/agent/agent.ts` | ⬜ Pending (separate PR) |
| 2.6 Package config | `packages/coordination/package.json` | ✅ Complete |

---

## Phase 3: Orchestration Workflow

| Task | File | Status |
|---|---|---|
| 3.1 Task decomposition | `packages/coordination/src/orchestrate.ts` | ✅ Complete |
| 3.2 ParallelSubtaskPart type | `packages/coordination/src/orchestrate.ts` | ✅ Complete |
| 3.3 Parallel execution | `packages/coordination/src/orchestrate.ts` | ✅ Complete |
| 3.4 Context filtering | `packages/coordination/src/orchestrate.ts` | ✅ Complete |

---

## Phase 4: Distribution Plugin (Remote Agents)

| Task | File | Status |
|---|---|---|
| 4.1 Service discovery | `packages/distribution/src/node.ts` | ✅ Complete |
| 4.2 HTTP client | `packages/distribution/src/http-client.ts` | ✅ Complete |
| 4.3 Task serialization | `packages/distribution/src/http-client.ts` | ✅ Complete |
| 4.4 Health monitoring | `packages/distribution/src/health.ts` | ✅ Complete |
| 4.5 Failover manager | `packages/distribution/src/health.ts` | ✅ Complete |
| 4.6 Remote task tool | `packages/distribution/src/index.ts` | ✅ Complete |
| 4.7 Node health tool | `packages/distribution/src/index.ts` | ✅ Complete |
| 4.8 Node discovery tool | `packages/distribution/src/index.ts` | ✅ Complete |
| 4.9 Healthy nodes tool | `packages/distribution/src/index.ts` | ✅ Complete |
| 4.10 Plugin entry | `packages/distribution/src/index.ts` | ✅ Complete |
| 4.11 Package config | `packages/distribution/package.json` | ✅ Complete |

---

## Phase 5: Optimisation & Bug Fixes

### 5.1 Memory Layer

| Task | File | Status |
|---|---|---|
| Fix: `queryMessages` always joining FTS table even without text search | `packages/memory/src/db.ts` | ✅ Fixed |
| Fix: duplicate message capture via two hooks writing same turns | `packages/memory/src/index.ts` | ✅ Fixed |
| Add: `pruneMemory(olderThanMs)` — evict old records, keep DB bounded | `packages/memory/src/db.ts` | ✅ Added |
| Add: auto-prune every 100 inserts (30-day retention) | `packages/memory/src/index.ts` | ✅ Added |

### 5.2 Coordination — Analysis

| Task | File | Status |
|---|---|---|
| Add: `confidence` score (0–1) to `AnalysisResult` | `packages/coordination/src/analyze.ts` | ✅ Added |
| Fix: parallel groups never generated (single root task per template) | `packages/coordination/src/analyze.ts` | ✅ Fixed |
| Add: two independent root tasks per template to enable real parallel groups | `packages/coordination/src/analyze.ts` | ✅ Added |
| Add: `migrate/port/convert` template (was missing) | `packages/coordination/src/analyze.ts` | ✅ Added |
| Add: confidence-gated system prompt injection (skip if < 0.5) | `packages/memory/src/index.ts` | ✅ Added |
| Add: `LLMDelegate` type + `analyzeWithFallback()` — LLM path when confidence < 0.5 | `packages/coordination/src/analyze.ts` | ✅ Added |
| Add: `buildLLMUserMessage()` — focused context builder for LLM call | `packages/coordination/src/analyze.ts` | ✅ Added |
| Add: `parseLLMResponse()` — robust JSON extraction from LLM output | `packages/coordination/src/analyze.ts` | ✅ Added |
| Wire: `ctx.complete` as `LLMDelegate` in plugin `triggerAnalysis()` | `packages/memory/src/index.ts` | ✅ Added |

### 5.3 Coordination — Agent Registry

| Task | File | Status |
|---|---|---|
| Add: `agent-registry.ts` — skill/cost registry for all 10 agents | `packages/coordination/src/agent-registry.ts` | ✅ Added |
| Add: `TaskType` tags (11 types) | `packages/coordination/src/agent-registry.ts` | ✅ Added |
| Add: `TaskComplexity` levels + complexity → required skill mapping | `packages/coordination/src/agent-registry.ts` | ✅ Added |
| Add: `inferComplexity(text)` — regex-based complexity inference | `packages/coordination/src/agent-registry.ts` | ✅ Added |
| Add: `inferTaskTypes(text)` — regex-based task type inference | `packages/coordination/src/agent-registry.ts` | ✅ Added |
| Add: `selectAgent(types, complexity, budgetCap?)` — cheapest-sufficient selection | `packages/coordination/src/agent-registry.ts` | ✅ Added |
| Add: `escalateAgent(current, types)` — next-tier-up for retry | `packages/coordination/src/agent-registry.ts` | ✅ Added |

### 5.4 Coordination — Orchestration

| Task | File | Status |
|---|---|---|
| Fix: parallel group execution was sequential (no actual `forkIn`) | `packages/coordination/src/orchestrate.ts` | ✅ Fixed |
| Fix: `decomposeGoal` used hardcoded agent names | `packages/coordination/src/orchestrate.ts` | ✅ Fixed |
| Add: `DecomposeOptions` (`budgetCap`, `complexity` override) | `packages/coordination/src/orchestrate.ts` | ✅ Added |
| Add: registry-driven agent selection in all decomposition templates | `packages/coordination/src/orchestrate.ts` | ✅ Added |
| Add: parallel group auto-detection when root tasks share same agent | `packages/coordination/src/orchestrate.ts` | ✅ Added |
| Add: escalation-on-failure in `executePlan` sequential loop | `packages/coordination/src/orchestrate.ts` | ✅ Added |
| Fix: naive keyword extraction in `filterContextForTask` | `packages/coordination/src/orchestrate.ts` | ✅ Fixed |
| Add: bigram extraction + 50-word stopword list + early-exit | `packages/coordination/src/orchestrate.ts` | ✅ Added |

### 5.7 Coordinator — Delegation Boundary

| Task | File | Status |
|---|---|---|
| Fix: coordinator had `bash.execute`, `read`, `search` — causing it to work directly instead of delegating | `packages/coordination/src/coordinator-agent.ts` | ✅ Fixed |
| Fix: `steps: 20` gave the coordinator an executor budget; reduced to 5 | `packages/coordination/src/coordinator-agent.ts` | ✅ Fixed |
| Fix: system prompt had no explicit "do not do the work yourself" boundary | `packages/coordination/src/system-prompt.txt` | ✅ Fixed |
| Fix: system prompt never showed how to invoke the `task` tool | `packages/coordination/src/system-prompt.txt` | ✅ Fixed |
| Add: hard identity section ("YOU MUST NOT / YOU MUST ONLY") at top of prompt | `packages/coordination/src/system-prompt.txt` | ✅ Added |
| Add: concrete `task` tool call examples with parallel-spawn pattern | `packages/coordination/src/system-prompt.txt` | ✅ Added |
| Add: 5-step workflow with annotated example showing pure delegation | `packages/coordination/src/system-prompt.txt` | ✅ Added |

---

| Task | File | Status |
|---|---|---|
| Fix: `sendBatch` was looping and re-sending all tasks on each iteration | `packages/distribution/src/http-client.ts` | ✅ Fixed |

### 5.6 Exports

| Task | File | Status |
|---|---|---|
| Export `analyzeWithFallback`, `LLMDelegate` | `packages/coordination/src/index.ts` | ✅ Added |
| Export `DecomposeOptions` | `packages/coordination/src/index.ts` | ✅ Added |
| Export all `agent-registry.ts` symbols and types | `packages/coordination/src/index.ts` | ✅ Added |

---

## Shared

| Task | File | Status |
|---|---|---|
| Root `package.json` | `package.json` | ✅ Complete |
| Root `tsconfig.json` | `tsconfig.json` | ✅ Complete |

---

## Summary

- **Total Tasks:** 65
- **Completed:** 64
- **Remaining:** 1 (core registry entry — separate PR)

## Build Status

```
$ bun run build

> @mem-arch/coordination@1.0.0 build
> tsc
✅ OK

> @mem-arch/distribution@1.0.0 build
> tsc
✅ OK

> @mem-arch/memory@1.0.0 build
> tsc
✅ OK
```
