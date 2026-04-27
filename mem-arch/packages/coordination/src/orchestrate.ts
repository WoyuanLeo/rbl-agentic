import { Effect, Scope, Fiber, Exit } from "effect"

export interface Task {
  id: string
  agent: string
  prompt: string
  description: string
  depends_on: string[]
  model?: { providerID: string; modelID: string }
}

export interface ParallelGroup {
  agent: string
  task_ids: string[]
}

export interface OrchestrationPlan {
  tasks: Task[]
  parallel_groups: ParallelGroup[]
  status: "planning" | "executing" | "completed" | "failed"
}

export interface TaskResult {
  taskId: string
  status: "completed" | "failed"
  output: string
}

export function decomposeGoal(goal: string): OrchestrationPlan {
  const lower = goal.toLowerCase()

  if (lower.match(/refactor|rename|restructure|reorganize/)) {
    return {
      tasks: [
        { id: "explore-targets", agent: "explore", prompt: `Identify all files, functions, and dependencies affected by this refactoring: ${goal}`, description: "Explore refactoring targets", depends_on: [] },
        { id: "apply-refactoring", agent: "general", prompt: `Apply the refactoring changes: ${goal}`, description: "Apply refactoring", depends_on: ["explore-targets"] },
        { id: "update-tests", agent: "general", prompt: `Update existing tests to match the refactored code: ${goal}`, description: "Update tests", depends_on: ["apply-refactoring"] },
      ],
      parallel_groups: [],
      status: "planning",
    }
  }

  if (lower.match(/add|implement|create|build|develop/)) {
    return {
      tasks: [
        { id: "research-patterns", agent: "explore", prompt: `Research existing patterns, dependencies, and conventions for: ${goal}`, description: "Research existing patterns", depends_on: [] },
        { id: "implement-feature", agent: "general", prompt: `Implement: ${goal} using established patterns`, description: "Implement feature", depends_on: ["research-patterns"] },
      ],
      parallel_groups: [],
      status: "planning",
    }
  }

  if (lower.match(/fix|debug|resolve|patch|repair/)) {
    return {
      tasks: [
        { id: "investigate-root-cause", agent: "explore", prompt: `Investigate the root cause: ${goal}`, description: "Investigate root cause", depends_on: [] },
        { id: "implement-fix", agent: "general", prompt: `Implement fix for: ${goal}`, description: "Implement fix", depends_on: ["investigate-root-cause"] },
        { id: "verify-fix", agent: "quality-assurance", prompt: `Verify fix works and doesn't introduce regressions: ${goal}`, description: "Verify fix", depends_on: ["implement-fix"] },
      ],
      parallel_groups: [],
      status: "planning",
    }
  }

  if (lower.match(/migrate|port|convert|transition/)) {
    return {
      tasks: [
        { id: "assess-current-state", agent: "explore", prompt: `Assess current state and dependencies for migration: ${goal}`, description: "Assess current state", depends_on: [] },
        { id: "implement-migration", agent: "general", prompt: `Perform migration: ${goal}`, description: "Implement migration", depends_on: ["assess-current-state"] },
        { id: "validate-migration", agent: "quality-assurance", prompt: `Validate migration is complete and correct: ${goal}`, description: "Validate migration", depends_on: ["implement-migration"] },
      ],
      parallel_groups: [],
      status: "planning",
    }
  }

  return {
    tasks: [{ id: "main-task", agent: "general", prompt: goal, description: "Main task", depends_on: [] }],
    parallel_groups: [],
    status: "planning",
  }
}

export function executePlan(
  plan: OrchestrationPlan,
  executeSubAgent: (task: Task) => Promise<TaskResult>,
): Effect.Effect<TaskResult[], Error, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    const results: TaskResult[] = []
    const completed = new Set<string>()

    const reverseMap = new Map<string, string[]>()
    for (const task of plan.tasks) {
      for (const dep of task.depends_on) {
        if (!reverseMap.has(dep)) reverseMap.set(dep, [])
        reverseMap.get(dep)!.push(task.id)
      }
    }

    for (const group of plan.parallel_groups) {
      const groupTasks = plan.tasks.filter((t) => group.task_ids.includes(t.id))
      if (groupTasks.length === 0) continue

      // Fork tasks and collect results
      for (const task of groupTasks) {
        const result: TaskResult = yield* Effect.tryPromise({
          try: () => executeSubAgent(task),
          catch: (e) => e instanceof Error ? e : new Error(String(e)),
        })
        results.push(result)
        completed.add(result.taskId)
      }
    }

    const unexecuted = plan.tasks.filter((t) => !completed.has(t.id))
    const maxIterations = plan.tasks.length

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let executedThisRound = false

      for (const task of unexecuted) {
        if (completed.has(task.id)) continue
        if (!task.depends_on.every((dep) => completed.has(dep))) continue

        try {
          const result: TaskResult = yield* Effect.tryPromise({
            try: () => executeSubAgent(task),
            catch: (e) => e instanceof Error ? e : new Error(String(e)),
          })
          results.push(result)
          completed.add(result.taskId)
          executedThisRound = true
        } catch {
          results.push({ taskId: task.id, status: "failed", output: "Execution failed" })
          completed.add(task.id)
          executedThisRound = true
        }
      }

      if (!executedThisRound) break
    }

    plan.status = completed.size === plan.tasks.length ? "completed" : "failed"
    return results
  })
}

export async function executeSubAgent(task: Task): Promise<TaskResult> {
  return {
    taskId: task.id,
    status: "completed",
    output: `Task ${task.id} executed by ${task.agent}: ${task.prompt}`,
  }
}

export interface FilteredContext {
  relevantMemory: string[]
  recentHistory: string[]
  taskDescription: string
}

export async function filterContextForTask(
  globalMemoryQuery: (query: string, limit: number) => Promise<{ results: { content: string }[] }>,
  task: Task,
  _agentType: string,
  maxMemoryEntries: number = 5,
): Promise<FilteredContext> {
  const keywords = task.prompt
    .toLowerCase()
    .split(/\s+/)
    .filter((word: string) => word.length > 3 && !["please", "could", "would", "should", "after", "before", "about", "which", "these", "those", "where", "there", "their", "to", "and", "or", "the", "is", "in", "for"].includes(word))
    .slice(0, 3)

  const relevantMemory: string[] = []
  for (const keyword of keywords) {
    try {
      const results = await globalMemoryQuery(keyword, maxMemoryEntries)
      for (const entry of results.results) {
        if (!relevantMemory.includes(entry.content)) {
          relevantMemory.push(entry.content)
        }
      }
    } catch {
      // Skip search failures
    }
  }

  return {
    relevantMemory: relevantMemory.slice(0, maxMemoryEntries),
    recentHistory: [],
    taskDescription: task.prompt,
  }
}
