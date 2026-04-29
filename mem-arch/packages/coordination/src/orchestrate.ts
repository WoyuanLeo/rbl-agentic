import { Effect, Scope, Fiber, Exit } from "effect"
import {
  selectAgent,
  escalateAgent,
  inferComplexity,
  inferTaskTypes,
  type TaskType,
  type TaskComplexity,
  type CostTier,
} from "./agent-registry.js"

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

export interface DecomposeOptions {
  /** Hard ceiling on agent cost tier. Defaults to uncapped. */
  budgetCap?: CostTier
  /** Override complexity instead of inferring from text. */
  complexity?: TaskComplexity
}

export function decomposeGoal(goal: string, opts: DecomposeOptions = {}): OrchestrationPlan {
  const lower = goal.toLowerCase()
  const complexity = opts.complexity ?? inferComplexity(goal)

  // Helper: pick cheapest-sufficient agent for a subtask description
  function pick(subtaskText: string, forceTypes?: TaskType[]) {
    const types = forceTypes ?? inferTaskTypes(subtaskText)
    const result = selectAgent(types, complexity, opts.budgetCap)
    return { agent: result.agent, selectionReason: result.reason }
  }

  if (lower.match(/refactor|rename|restructure|reorganize/)) {
    const explorer = pick("find all source files functions and classes that need to change", ["research"])
    const testExplorer = pick("find all test files and fixtures affected", ["research"])
    const applier = pick("apply refactoring changes across all identified source targets", ["refactor"])
    const tester = pick("update existing tests to match the refactored code structure", ["testing"])
    return {
      tasks: [
        { id: "explore-code-targets", agent: explorer.agent, prompt: `Identify all source files, functions, and classes that need to change for this refactoring: ${goal}`, description: "Explore code targets", depends_on: [] },
        { id: "explore-test-targets", agent: testExplorer.agent, prompt: `Identify all test files and fixtures affected by this refactoring: ${goal}`, description: "Explore test targets", depends_on: [] },
        { id: "apply-refactoring", agent: applier.agent, prompt: `Apply the refactoring changes across all identified source targets: ${goal}`, description: "Apply refactoring", depends_on: ["explore-code-targets", "explore-test-targets"] },
        { id: "update-tests", agent: tester.agent, prompt: `Update existing tests to match the refactored code structure: ${goal}`, description: "Update tests", depends_on: ["apply-refactoring"] },
      ],
      parallel_groups: explorer.agent === testExplorer.agent
        ? [{ agent: explorer.agent, task_ids: ["explore-code-targets", "explore-test-targets"] }]
        : [],
      status: "planning",
    }
  }

  if (lower.match(/add|implement|create|build|develop/)) {
    const researcher = pick("research existing patterns dependencies and conventions", ["research"])
    const testResearcher = pick("find existing test patterns and coverage gaps", ["research", "testing"])
    const implementer = pick("implement the new feature following established patterns", ["implementation"])
    return {
      tasks: [
        { id: "research-patterns", agent: researcher.agent, prompt: `Research existing patterns, dependencies, and conventions for: ${goal}`, description: "Research patterns", depends_on: [] },
        { id: "research-tests", agent: testResearcher.agent, prompt: `Find existing test patterns and coverage gaps relevant to: ${goal}`, description: "Research test coverage", depends_on: [] },
        { id: "implement-feature", agent: implementer.agent, prompt: `Implement: ${goal} using established patterns`, description: "Implement feature", depends_on: ["research-patterns", "research-tests"] },
      ],
      parallel_groups: researcher.agent === testResearcher.agent
        ? [{ agent: researcher.agent, task_ids: ["research-patterns", "research-tests"] }]
        : [],
      status: "planning",
    }
  }

  if (lower.match(/fix|debug|resolve|patch|repair/)) {
    const codeInvestigator = pick("examine code paths call stacks and type contracts for this issue", ["research", "bug-fix"])
    const logInvestigator = pick("check recent git history logs and test output for clues", ["logs-bash", "research"])
    const fixer = pick("implement the fix based on root cause analysis", ["bug-fix", "implementation"])
    const verifier = pick("verify fix works and does not introduce regressions", ["testing"])
    return {
      tasks: [
        { id: "investigate-code", agent: codeInvestigator.agent, prompt: `Examine code paths, call stacks, and type contracts for: ${goal}`, description: "Investigate code", depends_on: [] },
        { id: "investigate-history", agent: logInvestigator.agent, prompt: `Check recent git history, logs, and test output for clues about: ${goal}`, description: "Check history & logs", depends_on: [] },
        { id: "implement-fix", agent: fixer.agent, prompt: `Implement fix for: ${goal}`, description: "Implement fix", depends_on: ["investigate-code", "investigate-history"] },
        { id: "verify-fix", agent: verifier.agent, prompt: `Verify fix works and doesn't introduce regressions: ${goal}`, description: "Verify fix", depends_on: ["implement-fix"] },
      ],
      parallel_groups: codeInvestigator.agent === logInvestigator.agent
        ? [{ agent: codeInvestigator.agent, task_ids: ["investigate-code", "investigate-history"] }]
        : [],
      status: "planning",
    }
  }

  if (lower.match(/migrate|port|convert|transition/)) {
    const sourceAssessor = pick("assess current source state API surface and all internal dependencies", ["research", "architecture"])
    const targetAssessor = pick("assess the target environment breaking changes and migration constraints", ["research", "architecture"])
    const migrator = pick("perform the migration based on assessment findings", ["implementation"])
    const validator = pick("validate migration is complete and correct", ["testing"])
    return {
      tasks: [
        { id: "assess-source", agent: sourceAssessor.agent, prompt: `Assess current source state and dependencies for migration: ${goal}`, description: "Assess source", depends_on: [] },
        { id: "assess-target", agent: targetAssessor.agent, prompt: `Assess the target environment and migration constraints: ${goal}`, description: "Assess target", depends_on: [] },
        { id: "implement-migration", agent: migrator.agent, prompt: `Perform migration: ${goal}`, description: "Implement migration", depends_on: ["assess-source", "assess-target"] },
        { id: "validate-migration", agent: validator.agent, prompt: `Validate migration is complete and correct: ${goal}`, description: "Validate migration", depends_on: ["implement-migration"] },
      ],
      parallel_groups: sourceAssessor.agent === targetAssessor.agent
        ? [{ agent: sourceAssessor.agent, task_ids: ["assess-source", "assess-target"] }]
        : [],
      status: "planning",
    }
  }

  // Generic single-task fallback — still picks the right agent for the goal
  const { agent } = pick(goal)
  return {
    tasks: [{ id: "main-task", agent, prompt: goal, description: "Main task", depends_on: [] }],
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

      // Fork all tasks in the group concurrently, then join results
      const fibers = yield* Effect.all(
        groupTasks.map((task) =>
          Effect.forkIn(
            Effect.tryPromise({
              try: () => executeSubAgent(task),
              catch: (e) => e instanceof Error ? e : new Error(String(e)),
            }),
            scope,
          ),
        ),
        { concurrency: "unbounded" },
      )

      const groupResults = yield* Effect.all(
        fibers.map((fiber) =>
          Fiber.join(fiber).pipe(
            Effect.catchAll((e) =>
              Effect.succeed<TaskResult>({
                taskId: "unknown",
                status: "failed",
                output: e instanceof Error ? e.message : String(e),
              }),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      )

      for (const result of groupResults) {
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
        } catch (firstErr) {
          // Attempt one escalation before giving up
          const escalated = escalateAgent(task.agent, inferTaskTypes(task.prompt))
          if (escalated) {
            const escalatedTask: Task = { ...task, agent: escalated.agent }
            try {
              const retryResult: TaskResult = yield* Effect.tryPromise({
                try: () => executeSubAgent(escalatedTask),
                catch: (e) => e instanceof Error ? e : new Error(String(e)),
              })
              results.push({ ...retryResult, output: `[escalated to ${escalated.agent}] ${retryResult.output}` })
              completed.add(retryResult.taskId)
            } catch {
              results.push({ taskId: task.id, status: "failed", output: `Execution failed after escalation to ${escalated.agent}` })
              completed.add(task.id)
            }
          } else {
            results.push({ taskId: task.id, status: "failed", output: "Execution failed (already at skill ceiling)" })
            completed.add(task.id)
          }
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

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "that", "this", "these", "those",
  "it", "its", "they", "them", "their", "we", "our", "you", "your", "he", "she",
  "please", "about", "which", "there", "where", "after", "before", "into",
])

/**
 * Extract meaningful keywords (unigrams + adjacent-pair bigrams) from text.
 * Filters stopwords and short tokens, returns up to `maxKeywords` terms.
 */
function extractKeywords(text: string, maxKeywords = 5): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))

  const unigrams = tokens.slice(0, maxKeywords)

  // Build bigrams from adjacent meaningful tokens to capture compound concepts
  const bigrams: string[] = []
  for (let i = 0; i < tokens.length - 1 && bigrams.length < 3; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`)
  }

  // Bigrams first (more specific), then unigrams, deduplicated
  const seen = new Set<string>()
  const result: string[] = []
  for (const kw of [...bigrams, ...unigrams]) {
    if (!seen.has(kw)) { seen.add(kw); result.push(kw) }
    if (result.length >= maxKeywords) break
  }
  return result
}

export async function filterContextForTask(
  globalMemoryQuery: (query: string, limit: number) => Promise<{ results: { content: string }[] }>,
  task: Task,
  _agentType: string,
  maxMemoryEntries: number = 5,
): Promise<FilteredContext> {
  const keywords = extractKeywords(task.prompt)

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
    if (relevantMemory.length >= maxMemoryEntries) break
  }

  return {
    relevantMemory: relevantMemory.slice(0, maxMemoryEntries),
    recentHistory: [],
    taskDescription: task.prompt,
  }
}
