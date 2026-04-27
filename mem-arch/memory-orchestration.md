# Memory-Driven Orchestration System Plan

## 1. Overview

This is an agent plugin specific for opencode.

Implement a system that provides cross-session persistence (Independent Memory) and a high-level Coordinator Agent to decompose complex goals into focused tasks. The system supports a distributed architecture where sub-agents can run remotely on different nodes.

### OpenCode Reference
- Local source code: /Users/tianzh/Workspace/opencode
- Website: https://opencode.ai/docs

## 2. The Memory Plugin (Persistence Layer) - NEW COMPONENT

- **Storage**: SQLite database via `bun:sqlite` at `.opencode/memory.db`.
- **Capture**: Use `"chat.message"` hook to mirror all turns (user/assistant) into the DB.
- **Retrieval**: Register a `global_memory_query` tool for keyword/semantic search across all sessions.
- **Progress Tracking**: Monitor sub-agent task completion and results via plugin hooks.
- **Proactive Trigger**: Use `"experimental.chat.system.transform"` to inject analysis from the Coordinator Agent into the system prompt.
- **Coordination Bridge**: Implement mechanism to invoke Coordinator Agent logic for analysis and re-planning.
- **Distributed Communication**: Implement messaging mechanism (e.g., HTTP/gRPC) for Coordinator to communicate with remote sub-agents.

## 3. The Coordinator Agent (Intelligence Layer) - NEW AGENT TYPE

- **Definition**: Add `coordinator` to the registry in `packages/opencode/src/agent/agent.ts`.
- **System Prompt**: `coordinator.txt` focusing on:
  - **Resource Knowledge**: Maintaining a manifest of managed sub-agents (local and remote) and their specific areas of expertise to ensure correct delegation.
  - **Progress Tracking**: Monitoring the status, progress, and resource utilization of each sub-agent (including remote nodes) to inform dynamic reallocation of tasks.
  - **Dynamic Adjustment**: Rebalancing workload and shifting focus based on sub-agent progress, bottlenecks, node health, and changing priorities identified in memory analysis.
  - **Context Filtering**: When delegating to sub-agents, filter the parent session's context and global memory to provide only the most relevant, subject-specific information in the task prompt.
  - **Task Distribution**: Serialize tasks and delegate them to appropriate sub-agent nodes via the communication mechanism.
  - Orchestrating other agents (e.g., `explore`, `general`) using the `task` tool (local) or remote agent invocation.
  - **ParallelGroups**: Groups independent tasks with the same agent into parallel execution units for concurrent execution.
  - **Parallel Execution**: Independent tasks forked as concurrent child sessions via `Effect.forkIn(scope)`.
- **Permissions**: Access to `global_memory_query` and `task` tools.
- **Communication**: Ability to invoke remote agents via HTTP/gRPC endpoints.

## 4. Orchestration Workflow

1. **Capture**: Messages $\rightarrow$ Memory Plugin $\rightarrow$ SQLite.
2. **Analyze**: (Background) Memory Plugin $\rightarrow$ Coordinator Agent $\rightarrow$ Analysis of state vs memory **and sub-agent progress (including remote nodes)**.
3. **Propose**: Coordinator returns strategic guidance **and dynamic task reallocation** $\rightarrow$ Memory Plugin injects into session prompt.
4. **Execute**: User/Agent accepts guidance $\rightarrow$ Coordinator decomposes goals into parallel groups (independent tasks) and sequential tasks (dependencies) $\rightarrow$ Independent tasks for same agent execute concurrently via `forkIn(scope)` $\rightarrow$ Dependent tasks execute in order $\rightarrow$ Focused sub-sessions with dynamically balanced focus.
5. **Monitor**: Sub-agents (local and remote) report progress back through task results $\rightarrow$ Memory Plugin updates Coordinator $\rightarrow$ Cycle repeats.
6. **Health Monitoring**: Coordinator tracks node availability and redistributes tasks from unhealthy nodes.

## 4.1. Parallel Execution

When the coordinator detects multiple independent tasks that can use the same agent, it groups them into a **ParallelGroup** and executes them concurrently:

- **ParallelGroup**: A group of independent tasks assigned to the same agent type, executed via `forkIn(scope)` as concurrent child sessions
- **Sequential Tasks**: Tasks with dependencies are still executed in order
- **ParallelSubtaskPart**: New message part type (`type: "parallel-subtask"`) carrying grouped tasks

Example:
```
Goal: "Refactor API and update tests"
├── Parallel Group (explore agent):
│   ├── "Find all API endpoints" (task 1)
│   └── "Find all test files" (task 2)
└── Sequential Task (general agent):
    └── "Apply refactoring and update tests" (depends on results)
```

## 5. Implementation Roadmap

1. **SQLite Layer**: Implement DB handler and `"chat.message"` hook.
2. **Search Tool**: Implement `global_memory_query` tool.
3. **Progress Tracking**: Implement mechanism to monitor sub-agent task completion (local and remote).
4. **Agent Definition**: Create `coordinator` agent and its system prompt.
5. **Permissions**: Configure tool access for the coordinator.
6. **Orchestration Logic**: Implement Coordinator's analysis, delegation, and rebalancing logic.
7. **Prompt Integration**: Link Coordinator analysis to the `system.transform` hook.
8. **Coordination Bridge**: Implement mechanism for plugin to invoke Coordinator logic.
9. **Distributed Communication Layer**: Implement HTTP/gRPC client for remote agent invocation.
10. **Service Discovery**: Implement mechanism to discover available sub-agent nodes (could be config-based or using a registry).
11. **Health Checks**: Implement node health monitoring and failover mechanisms.
12. **Serialization**: Implement task serialization/deserialization for cross-node communication.

## 6. Relationship to OpenCode Plugin System

### What Fits Within the Plugin System:

- **Memory Plugin**: Fully implementable as a standard OpenCode plugin using the `Plugin` interface
- **Hook Usage**: All proposed hooks (`"chat.message"`, `"experimental.chat.system.transform"`, `"tool"` for `global_memory_query`) are part of the existing plugin contract
- **Tool Registration**: The `global_memory_query` tool can be registered via the plugin's `tool` hook
- **Data Persistence**: SQLite storage in `.opencode/` directory is appropriate for plugin data
- **Progress Tracking Hooks**: Can use existing plugin hooks to monitor task completion

### What Requires Core System Extension:

- **Coordinator Agent Definition**: Adding a new agent type requires modification to `packages/opencode/src/agent/agent.ts` (the central agent registry)
- **Agent Permissions**: Configuring the coordinator's access to specific tools requires core agent configuration
- **Orchestration Logic**: While the plugin can trigger analysis, the core agent system handles the actual task delegation and session management
- **Remote Communication**: While basic task execution can be plugin-based, distributed communication may require core enhancements for security and reliability

### Integration Approach:

1. Implement the Memory Plugin as a standalone plugin that can be dropped into `.opencode/plugins/` or installed via npm
2. The plugin will:
   - Record all conversation history to SQLite
   - Provide the `global_memory_query` tool for agents to access history
   - Analyze progress and invoke Coordinator Agent logic for re-planning
   - Inject strategic guidance into sessions via system prompt transformation
   - Handle local task delegation via existing `task` tool
3. The Coordinator Agent would be added to the core agent registry (requiring a core update) but would be designed to work specifically with the Memory Plugin's tools and data
4. For distributed execution, the Coordinator would use the plugin's communication layer to invoke remote agents (which would run the same OpenCode core but in agent mode)

This approach allows most functionality to be delivered via the plugin system while requiring minimal core changes for the orchestration layer. The distributed architecture extends the existing plugin pattern to remote nodes.
