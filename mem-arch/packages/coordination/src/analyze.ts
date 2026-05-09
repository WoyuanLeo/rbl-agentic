import type { MemoryDB, MemoryRow, TaskRow } from "./index.js"
import { selectAgent, inferComplexity, inferTaskTypes } from "./agent-registry.js"

export interface AnalysisResult {
  analysis: string
  recommendations: string[]
  /** 0–1 score indicating how actionable this analysis is. Low scores should not be injected into the system prompt. */
  confidence: number
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

/** Minimum confidence required before injecting guidance into the system prompt. */
export const INJECT_CONFIDENCE_THRESHOLD = 0.5

/** Minimum confidence at which the heuristic result is trusted; below this the LLM path is used. */
export const LLM_FALLBACK_THRESHOLD = 0.5

/**
 * How long a task must have no updates before it is considered stalled (ms).
 * Override via the `staleTaskThresholdMs` parameter in `analyze()`.
 */
export const DEFAULT_STALE_TASK_THRESHOLD_MS = 300_000 // 5 minutes

/**
 * Callback type for invoking the coordinator LLM agent.
 * Provided by the caller (plugin layer) so this module stays framework-agnostic.
 *
 * @param systemPrompt  The coordinator system prompt
 * @param userMessage   The composed user message containing session context
 * @returns             Raw JSON string matching AnalysisResult shape
 */
export type LLMDelegate = (systemPrompt: string, userMessage: string) => Promise<string>

/**
 * Compose the user-facing message sent to the coordinator LLM.
 * Includes recent history summary and active task state so the model
 * has just enough context without the full memory dump.
 */
function buildLLMUserMessage(
  goal: string,
  recentMessages: MemoryRow[],
  activeTasks: TaskRow[],
  completedTasks: TaskRow[],
): string {
  const historySnippet = recentMessages
    .slice(0, 6)
    .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
    .join("\n")

  return [
    `Goal: ${goal}`,
    "",
    "Recent conversation (newest first):",
    historySnippet || "(none)",
    "",
    `Active tasks (${activeTasks.length}): ${activeTasks.map((t) => t.task_id).join(", ") || "none"}`,
    `Completed tasks (${completedTasks.length}): ${completedTasks.map((t) => t.task_id).join(", ") || "none"}`,
    "",
    "Respond with a JSON object matching the AnalysisResult schema.",
  ].join("\n")
}

/**
 * Attempt to parse an LLM response into a valid AnalysisResult.
 * Extracts a JSON block even if the model wraps it in prose or markdown fences.
 */
function parseLLMResponse(raw: string): AnalysisResult | null {
  // Strip markdown code fences if present
  const stripped = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim()
  // Find the first {...} block in the response
  const match = stripped.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Partial<AnalysisResult>
    if (typeof parsed.analysis !== "string") return null
    return {
      analysis: parsed.analysis,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      confidence: typeof parsed.confidence === "number" ? Math.min(parsed.confidence, 1) : 0.7,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : undefined,
      parallel_groups: Array.isArray(parsed.parallel_groups) ? parsed.parallel_groups : undefined,
    }
  } catch {
    return null
  }
}

export function analyze(db: MemoryDB, staleTaskThresholdMs: number = DEFAULT_STALE_TASK_THRESHOLD_MS): string {
  const recentHistory = db.queryMessages({ limit: 20, rank_by: "newest" })
  const activeTasks = db.queryTasks({ status: "in_progress" })
  const completedTasks = db.queryTasks({ status: "completed" })

  const recommendations: string[] = []
  const tasks: AnalysisResult["tasks"] = []
  let confidence = 0.1 // baseline: low

  const stalledTasks = activeTasks.filter((t: TaskRow) => Date.now() - t.updated_at > staleTaskThresholdMs)
  if (stalledTasks.length > 0) {
    confidence += 0.3
    const thresholdMin = Math.round(staleTaskThresholdMs / 60_000)
    recommendations.push(
      `⚠️ ${stalledTasks.length} task(s) appear stalled (no updates in ${thresholdMin}+ min): ` +
      stalledTasks.map((t: TaskRow) => t.task_id).join(", ") +
      ". Consider reassigning or providing clarification."
    )
  }

  if (completedTasks.length > 0) {
    confidence += 0.1
    recommendations.push(
      `✅ ${completedTasks.length} task(s) completed. Check if dependent tasks can now be started.`
    )
  }

  const userMessages = recentHistory.filter((m: MemoryRow) => m.role === "user")
  const assistantMessages = recentHistory.filter((m: MemoryRow) => m.role === "assistant")

  if (userMessages.length > assistantMessages.length * 1.5) {
    confidence += 0.1
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
    confidence += 0.4
    recommendations.push("🎯 Recent goal detected. Consider breaking this into parallel sub-tasks.")
    const goal = recentGoals[0]!
    const complexity = inferComplexity(goal)

    // Helper: select cheapest-sufficient agent for a subtask description
    const pick = (desc: string, types?: ReturnType<typeof inferTaskTypes>) =>
      selectAgent(types ?? inferTaskTypes(desc), complexity).agent

    if (goal.includes("refactor") || goal.includes("rename")) {
      tasks.push(
        { id: "explore-code-targets", agent: pick("find source files functions classes", ["research"]), prompt: "Identify all source files, functions, and classes that need to change for this refactoring", description: "Explore code targets", depends_on: [] },
        { id: "explore-test-targets", agent: pick("find test files and fixtures", ["research"]), prompt: "Identify all test files and fixtures affected by this refactoring", description: "Explore test targets", depends_on: [] },
        { id: "apply-refactoring", agent: pick("apply refactoring changes", ["refactor"]), prompt: "Apply the refactoring changes across all identified source targets", description: "Apply refactoring", depends_on: ["explore-code-targets", "explore-test-targets"] },
        { id: "update-tests", agent: pick("update tests to match refactored code", ["testing"]), prompt: "Update existing tests to match the refactored code structure", description: "Update tests", depends_on: ["apply-refactoring"] },
      )
    } else if (goal.includes("add") || goal.includes("implement") || goal.includes("create") || goal.includes("build")) {
      tasks.push(
        { id: "research-patterns", agent: pick("research existing patterns dependencies", ["research"]), prompt: "Research existing patterns, dependencies, and conventions relevant to this feature", description: "Research patterns", depends_on: [] },
        { id: "research-tests", agent: pick("find test patterns and coverage gaps", ["research", "testing"]), prompt: "Find existing test patterns and coverage gaps relevant to this feature area", description: "Research test coverage", depends_on: [] },
        { id: "implement-feature", agent: pick("implement the new feature", ["implementation"]), prompt: "Implement the new feature following established patterns and conventions", description: "Implement feature", depends_on: ["research-patterns", "research-tests"] },
      )
    } else if (goal.includes("fix") || goal.includes("debug")) {
      tasks.push(
        { id: "investigate-code", agent: pick("examine code paths call stacks type contracts", ["research", "bug-fix"]), prompt: "Examine code paths, call stacks, and type contracts for this issue", description: "Investigate code", depends_on: [] },
        { id: "investigate-history", agent: pick("check git history logs test output", ["logs-bash", "research"]), prompt: "Check recent git history, logs, and test output for clues about this failure", description: "Check history & logs", depends_on: [] },
        { id: "implement-fix", agent: pick("implement the fix based on root cause", ["bug-fix", "implementation"]), prompt: "Implement the fix based on root cause analysis", description: "Implement fix", depends_on: ["investigate-code", "investigate-history"] },
        { id: "verify-fix", agent: pick("verify the fix and check for regressions", ["testing"]), prompt: "Verify the fix works and doesn't introduce regressions", description: "Verify fix", depends_on: ["implement-fix"] },
      )
    } else if (goal.includes("migrate") || goal.includes("port") || goal.includes("convert")) {
      tasks.push(
        { id: "assess-source", agent: pick("assess current source state API dependencies", ["research", "architecture"]), prompt: "Assess current source state, API surface, and all internal dependencies", description: "Assess source", depends_on: [] },
        { id: "assess-target", agent: pick("assess target environment breaking changes constraints", ["research", "architecture"]), prompt: "Assess the target environment, breaking changes, and migration constraints", description: "Assess target", depends_on: [] },
        { id: "implement-migration", agent: pick("perform the migration implementation", ["implementation"]), prompt: "Perform the migration based on the assessment findings", description: "Implement migration", depends_on: ["assess-source", "assess-target"] },
        { id: "validate-migration", agent: pick("validate migration is complete and correct", ["testing"]), prompt: "Validate migration is complete and correct", description: "Validate migration", depends_on: ["implement-migration"] },
      )
    }
  }

  const result: AnalysisResult = {
    analysis: `Memory snapshot: ${db.getMemoryCount()} total messages recorded. ${activeTasks.length} active tasks, ${completedTasks.length} completed.`,
    recommendations: recommendations.length > 0 ? recommendations : ["Continue current approach."],
    confidence: Math.min(confidence, 1),
    tasks: tasks.length > 0 ? tasks : undefined,
  }

  // Build parallel groups: independent tasks (no deps) grouped by agent;
  // cross-agent independent tasks also get a "parallel" sentinel group
  if (tasks.length > 0) {
    const agentGroups: Record<string, string[]> = {}
    const crossAgentIds: string[] = []
    const seenAgents = new Set<string>()
    for (const task of tasks) {
      if (task.depends_on.length === 0) {
        if (!agentGroups[task.agent]) agentGroups[task.agent] = []
        agentGroups[task.agent]!.push(task.id)
        crossAgentIds.push(task.id)
        seenAgents.add(task.agent)
      }
    }
    const groups: AnalysisResult["parallel_groups"] = []
    for (const [agent, task_ids] of Object.entries(agentGroups)) {
      if (task_ids.length > 1) groups.push({ agent, task_ids })
    }
    // If tasks span multiple agents with no same-agent pairs, add a cross-agent parallel group
    if (groups.length === 0 && seenAgents.size > 1 && crossAgentIds.length > 1) {
      groups.push({ agent: "parallel", task_ids: crossAgentIds })
    }
    if (groups.length > 0) result.parallel_groups = groups
  }

  return JSON.stringify(result, null, 2)
}

/**
 * Analyze with an optional LLM fallback.
 *
 * Decision tree:
 *  1. Run the cheap heuristic `analyze()` first.
 *  2. If heuristic confidence ≥ LLM_FALLBACK_THRESHOLD → return heuristic result (free).
 *  3. Otherwise, call the coordinator LLM with focused context → return LLM result.
 *  4. If LLM call fails → fall back to heuristic result (resilient).
 *
 * @param db          Memory database
 * @param llm         Optional LLM delegate; if omitted, heuristic-only is used
 * @param systemPrompt Coordinator system prompt (from system-prompt.txt)
 */
export async function analyzeWithFallback(
  db: MemoryDB,
  llm?: LLMDelegate,
  systemPrompt?: string,
): Promise<string> {
  const heuristicRaw = analyze(db)

  // No LLM delegate provided — heuristic only
  if (!llm) return heuristicRaw

  let heuristic: AnalysisResult
  try {
    heuristic = JSON.parse(heuristicRaw) as AnalysisResult
  } catch {
    return heuristicRaw
  }

  // Heuristic is confident enough — avoid the LLM call
  if (heuristic.confidence >= LLM_FALLBACK_THRESHOLD) return heuristicRaw

  // Heuristic is weak — escalate to the coordinator LLM
  const recentHistory = db.queryMessages({ limit: 10, rank_by: "newest" })
  const activeTasks = db.queryTasks({ status: "in_progress" })
  const completedTasks = db.queryTasks({ status: "completed" })

  // Extract the most recent user goal for the LLM message
  const goal = recentHistory.find((m) => m.role === "user")?.content ?? "No recent user message."

  const userMessage = buildLLMUserMessage(goal, recentHistory, activeTasks, completedTasks)
  const prompt = systemPrompt ?? "You are the Coordinator Agent. Decompose the goal into tasks and return AnalysisResult JSON."

  try {
    const llmRaw = await llm(prompt, userMessage)
    const llmResult = parseLLMResponse(llmRaw)
    if (llmResult) {
      // Mark clearly that this came from LLM so callers can log/observe
      llmResult.analysis = `[llm] ${llmResult.analysis}`
      return JSON.stringify(llmResult, null, 2)
    }
  } catch (e) {
    console.warn("[coordinator] LLM fallback failed, using heuristic:", e instanceof Error ? e.message : e)
  }

  // LLM failed or returned unparseable output — degrade gracefully
  return heuristicRaw
}
