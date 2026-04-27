import type { MemoryDB, MemoryRow, TaskRow } from "./index.js"

export interface AnalysisResult {
  analysis: string
  recommendations: string[]
  tasks?: Array<{
    id: string
    agent: string
    prompt: string
    description: string
    depends_on: string[]
  }>
  parallel_groups?: Array<{
    agent: string
    task_ids: string[]
  }>
}

export function analyze(db: MemoryDB): string {
  const recentHistory = db.queryMessages({ limit: 20, rank_by: "newest" })
  const activeTasks = db.queryTasks({ status: "in_progress" })
  const completedTasks = db.queryTasks({ status: "completed" })

  const recommendations: string[] = []
  const tasks: AnalysisResult["tasks"] = []

  const stalledTasks = activeTasks.filter((t: TaskRow) => Date.now() - t.updated_at > 300_000)
  if (stalledTasks.length > 0) {
    recommendations.push(
      `⚠️ ${stalledTasks.length} task(s) appear stalled (no updates in 5+ min): ` +
      stalledTasks.map((t: TaskRow) => t.task_id).join(", ") +
      ". Consider reassigning or providing clarification."
    )
  }

  if (completedTasks.length > 0) {
    recommendations.push(
      `✅ ${completedTasks.length} task(s) completed. Check if dependent tasks can now be started.`
    )
  }

  const userMessages = recentHistory.filter((m: MemoryRow) => m.role === "user")
  const assistantMessages = recentHistory.filter((m: MemoryRow) => m.role === "assistant")

  if (userMessages.length > assistantMessages.length * 1.5) {
    recommendations.push(
      "💡 User is driving heavily. Consider asking if they'd like to delegate specific tasks to sub-agents."
    )
  }

  const goalPatterns = ["refactor", "implement", "create", "build", "migrate", "update", "fix", "add"]
  const recentGoals = userMessages
    .slice(0, 3)
    .map((m: MemoryRow) => m.content.toLowerCase())
    .filter((c: string) => goalPatterns.some((p: string) => c.includes(p)))

  if (recentGoals.length > 0) {
    recommendations.push("🎯 Recent goal detected. Consider breaking this into parallel sub-tasks.")
    const goal = recentGoals[0]

    if (goal.includes("refactor") || goal.includes("rename")) {
      tasks.push(
        { id: "explore-targets", agent: "explore", prompt: "Identify all files, functions, and dependencies affected by this refactoring", description: "Explore refactoring targets", depends_on: [] },
        { id: "apply-refactoring", agent: "general", prompt: "Apply the refactoring changes across all identified targets", description: "Apply refactoring", depends_on: ["explore-targets"] },
        { id: "update-tests", agent: "general", prompt: "Update existing tests to match the refactored code structure", description: "Update tests", depends_on: ["apply-refactoring"] },
      )
    } else if (goal.includes("add") || goal.includes("implement") || goal.includes("create") || goal.includes("build")) {
      tasks.push(
        { id: "research-patterns", agent: "explore", prompt: "Research existing patterns, dependencies, and conventions relevant to this feature", description: "Research existing patterns", depends_on: [] },
        { id: "implement-feature", agent: "general", prompt: "Implement the new feature following established patterns and conventions", description: "Implement feature", depends_on: ["research-patterns"] },
      )
    } else if (goal.includes("fix") || goal.includes("debug")) {
      tasks.push(
        { id: "investigate-root-cause", agent: "explore", prompt: "Investigate the root cause of the issue by examining relevant code paths and logs", description: "Investigate root cause", depends_on: [] },
        { id: "implement-fix", agent: "general", prompt: "Implement the fix based on the root cause analysis", description: "Implement fix", depends_on: ["investigate-root-cause"] },
        { id: "verify-fix", agent: "quality-assurance", prompt: "Verify the fix works and doesn't introduce regressions", description: "Verify fix", depends_on: ["implement-fix"] },
      )
    }
  }

  const result: AnalysisResult = {
    analysis: `Memory snapshot: ${db.getMemoryCount()} total messages recorded. ${activeTasks.length} active tasks, ${completedTasks.length} completed.`,
    recommendations: recommendations.length > 0 ? recommendations : ["Continue current approach."],
    tasks: tasks.length > 0 ? tasks : undefined,
  }

  // Build parallel groups for tasks with no dependencies
  if (tasks.length > 0) {
    const agentGroups: Record<string, string[]> = {}
    for (const task of tasks) {
      if (task.depends_on.length === 0) {
        if (!agentGroups[task.agent]) agentGroups[task.agent] = []
        agentGroups[task.agent].push(task.id)
      }
    }
    result.parallel_groups = Object.entries(agentGroups)
      .filter(([, ids]) => ids.length > 1)
      .map(([agent, task_ids]) => ({ agent, task_ids }))
  }

  return JSON.stringify(result, null, 2)
}
