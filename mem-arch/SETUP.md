# Memory Orchestration System — Setup Guide

## Overview

A plugin-based memory-driven orchestration system for OpenCode. It provides:

- **Cross-session memory** — Persistent SQLite storage with FTS5 full-text search
- **Coordinator Agent** — Decomposes complex goals into parallel sub-tasks
- **Distributed execution** — Remote agent nodes with health monitoring and failover

## Requirements

- Bun 1.0+ (Bun runtime is required for `bun:sqlite`)
- OpenCode installed (`bun i -g @opencode-ai/opencode`)
- (Optional) Remote OpenCode instances for distributed mode

## Quick Start

### 1. Install Dependencies

```bash
cd mem-arch
bun install          # installs workspaces + dev dependencies (including @types/bun)
bun run build        # compiles all packages
```

This builds three packages:

| Package | Purpose |
|---------|---------|
| `@mem-arch/memory` | Persistence layer, FTS5 search, task tracking |
| `@mem-arch/coordination` | Coordinator agent, analysis engine, orchestration |
| `@mem-arch/distribution` | Remote agent communication, health monitoring |

### 2. Configure OpenCode

Add the plugins to your OpenCode configuration. You can configure either in:

- **User config:** `~/.opencode/config.json` (applies to all projects)
- **Project config:** `<project>/.opencode/config.json` (project-specific)

```json
{
  "plugin": [
    ["@mem-arch/memory", {}],
    ["@mem-arch/coordination", {}],
    ["@mem-arch/distribution", {}]
  ]
}
```

### 3. Apply OpenCode Custom Patches

OpenCode requires several custom patches beyond the mem-arch plugins. After installing or
upgrading OpenCode, apply all patches described in [`opencode_patch.md`](./opencode_patch.md):

| # | Patch | Purpose |
|---|-------|---------|
| 1 | **NPM patches** (`@npmcli/agent`, `@standard-community/standard-openapi`, `solid-js`) | Bug fixes in dependencies |
| 2 | **Coordinator agent registry entry** | Register the `@coordinator` agent (config in `coordination-agent.ts`) |
| 3 | **Korean/CJK IME fix** | Fix IME last-character truncation in TUI prompt |
| 4 | **Custom agent definitions** | Install 8 custom `.md` agent files from `opencode/agent/` |
| 5 | **Custom theme** | Apply Nord-based theme from `opencode/themes/custom-theme.json` |

See [`opencode_patch.md`](./opencode_patch.md) for detailed step-by-step instructions, including a
re-application checklist for use after OpenCode upgrades.

### 4. Run OpenCode

```bash
opencode
```

The plugins are now active. Start a conversation and you'll see:

1. Conversations are persisted across sessions
2. Every 10 messages, a coordinator analysis is triggered and injected into the system prompt
3. The `@coordinator` agent is available for task decomposition

## Distributed Mode (Optional)

### Setup Remote Nodes

Start remote OpenCode instances with the distribution plugin active:

```bash
# Node 1
OPENCODE_NODES="http://node1:8080,http://node2:8080" opencode --agent

# Node 2
OPENCODE_NODES="http://node1:8080,http://node2:8080" opencode --agent
```

### Configure Node Communication

Set the `OPENCODE_NODES` environment variable on the coordinator node to discover remote agents:

```bash
export OPENCODE_NODES="http://node1:8080,http://node2:8080"
opencode
```

The coordinator will now be able to delegate tasks to remote nodes using:

- `remote_task` tool — Send tasks directly to a node URL
- `find_available_nodes` — List all discovered nodes
- `check_node_health` — Verify a node is reachable
- `get_healthy_nodes` — List nodes currently in good health

### Remote Node Requirements

Each remote node needs:

1. OpenCode installed and running in agent mode
2. The same `@mem-arch/memory` plugin (for task progress tracking)
3. A `/health` endpoint returning 200 OK
4. An `/api/task` endpoint accepting POST with JSON task payload

## Configuration Reference

### Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `OPENCODE_NODES` | Comma-separated remote node URLs | `http://node1:8080,http://node2:8080` |

### Plugin Options

All plugins accept an empty options object `{}` by default. Additional options can be added to the plugin definitions:

```json
{
  "plugin": [
    ["@mem-arch/memory", {
      "analysisIntervalMs": 10,
      "analysisTTL": 60000
    }],
    ["@mem-arch/coordination", {
      "maxParallelTasks": 5
    }],
    ["@mem-arch/distribution", {
      "healthCheckIntervalMs": 30000
    }]
  ]
}
```

## Using the System

### Global Memory Search

Any agent can use the `global_memory_query` tool to search across all past conversations:

```
global_memory_query(query="authentication", limit=5, rank_by="relevance")
global_memory_query(query="", session_id="sess-abc", rank_by="newest")
```

### Task Progress Tracking

Sub-agents can report progress:

```
update_task_progress(task_id="refactor-1", status="in_progress")
update_task_progress(task_id="refactor-1", status="completed", result={summary: "done"})
query_task_progress(status="completed")
```

### Coordinator Agent

Invoke `@coordinator` to decompose complex goals:

```
User: "Refactor the entire auth module and update all test files"
@coordinator: Analyzes the goal, creates a plan with parallel exploration tasks
              followed by sequential implementation and testing tasks
```

### Parallel Execution

When the coordinator detects independent tasks, it groups them into `ParallelGroups`:

```
Goal: "Refactor API and update tests"
├── Parallel Group (explore agent):
│   ├── "Find all API endpoints"
│   └── "Find all test files"
└── Sequential: "Apply refactoring" (depends on both above)
```

## Troubleshooting

### Build Fails

- Make sure you're using **Bun** (`bun install` and `bun run build`), not npm
- The `bun:sqlite` module requires the Bun runtime
- Run `bun install` to ensure `@types/bun` is installed for TypeScript compilation

### Coordinator guidance not appearing

1. Verify the coordinator agent is registered in the core registry
2. Check that `@mem-arch/coordination` is listed in your plugin list
3. The analysis is triggered every 10 messages — start a new conversation
4. Check for TypeScript compilation errors

### Memory search returns empty results

1. Verify `@mem-arch/memory` is in your plugin list
2. The SQLite database is at `./.opencode/memory.db` — check it exists
3. Messages are captured on `chat.message` — ensure the plugin loads before conversations
4. FTS5 search uses MATCH syntax — try `content` as the query for broad results

### Remote nodes unreachable

1. Check `OPENCODE_NODES` is set correctly (comma-separated, no spaces)
2. Verify each node has a `/health` endpoint responding on port 8080
3. Firewall rules may block cross-machine HTTP
4. Use `check_node_health(url)` tool for diagnostics
5. Health checks cache for 30 seconds — use the tool to force a refresh

### Stale coordinator analysis

Analysis results are cached for 60 seconds (configurable via `ANALYSIS_TTL`).
To force a fresh analysis, continue the conversation past the 10-message threshold.

## Project Structure

```
mem-arch/
├── SETUP.md                        # This file
├── memory-orchestration.md         # Original architecture plan
├── project_progress.md             # Implementation progress tracker
├── package.json                    # Workspace root
├── tsconfig.json                   # Shared TS config
└── packages/
    ├── memory/                     # Phase 1: Persistence Layer
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts            # Plugin entry point
    │       ├── db.ts               # SQLite storage handler
    │       └── schema.ts           # SQL schema definitions
    ├── coordination/               # Phase 2-3: Intelligence + Orchestration
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts            # Plugin entry point
    │       ├── coordinator-agent.ts # Agent config + permissions
    │       ├── analyze.ts          # Analysis engine
    │       ├── orchestrate.ts      # Task decomposition + parallel execution
    │       └── system-prompt.txt   # Coordinator system prompt
    └── distribution/               # Phase 4: Remote Agent Communication
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts            # Plugin entry point
            ├── http-client.ts      # HTTP task communication
            ├── health.ts           # Health monitoring + failover
            └── node.ts             # Service discovery + node selection
```

## License

Internal project — see project root for license information.
