/**
 * Agent Skill & Cost Registry
 *
 * Each agent has:
 *   - skill (1–5): capability ceiling for the agent type
 *   - costTier: relative token/API cost per invocation
 *   - specializations: task-type tags this agent is optimised for
 *
 * Selection strategy (cheapest-sufficient):
 *   Given a required skill level and a set of task-type tags,
 *   pick the cheapest agent that:
 *     1. Meets or exceeds the required skill level, AND
 *     2. Has at least one matching specialization (preferred, not required)
 *
 * Escalation:
 *   If a task fails or returns low-confidence output, call escalate()
 *   to get the next tier up for a retry.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostTier = "low" | "medium" | "high"

export interface AgentProfile {
  name: string
  /** 1 = very basic, 5 = expert */
  skill: number
  costTier: CostTier
  /** Ordered cost weight for tie-breaking: low=1, medium=2, high=3 */
  costWeight: number
  /** Task-type tags this agent is specialised for */
  specializations: TaskType[]
  /** Human-readable description */
  description: string
}

/**
 * Canonical task-type tags used throughout the system.
 * Agents declare which of these they are optimised for.
 * Tasks are annotated with the tag(s) that best describe them.
 */
export type TaskType =
  | "research"        // exploring code, reading files, understanding structure
  | "implementation"  // writing / editing source code
  | "refactor"        // restructuring existing code
  | "bug-fix"         // diagnosing and patching defects
  | "testing"         // writing/running/verifying tests
  | "review"          // code quality, PR review
  | "architecture"    // system design, ADRs, technical strategy
  | "security"        // threat modelling, dependency audit, risk
  | "logs-bash"       // log analysis, shell diagnostics, process inspection
  | "reasoning"       // decision trees, trade-off analysis, logical deduction
  | "production"      // live-system debugging, infra troubleshooting, incidents

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const COST_WEIGHT: Record<CostTier, number> = { low: 1, medium: 2, high: 3 }

function agent(
  name: string,
  skill: number,
  costTier: CostTier,
  specializations: TaskType[],
  description: string,
): AgentProfile {
  return { name, skill, costTier, costWeight: COST_WEIGHT[costTier], specializations, description }
}

/**
 * Master registry — ordered cheapest-first within each skill tier
 * so that linear scans find the cheapest match naturally.
 */
export const AGENT_REGISTRY: AgentProfile[] = [
  // ── Tier: low cost ──────────────────────────────────────────────────────
  agent("explore",           2, "low",    ["research", "refactor"],
        "File search, code structure exploration, dependency analysis"),
  agent("regular-developer", 2, "low",    ["implementation", "bug-fix", "refactor"],
        "Routine feature work, small bug fixes, straightforward refactoring"),

  // ── Tier: medium cost ────────────────────────────────────────────────────
  agent("general",                  3, "medium", ["implementation", "refactor", "bug-fix"],
        "General-purpose implementation, moderate complexity tasks"),
  agent("quality-assurance",        3, "medium", ["testing", "review"],
        "Test design, test case generation, regression verification"),
  agent("code-reviewer",            3, "medium", ["review", "refactor"],
        "Code quality review, style, pattern adherence"),
  agent("investigation-bash-expert",3, "medium", ["logs-bash", "bug-fix", "research"],
        "Deep shell investigation, log analysis, process/system diagnostics"),
  agent("risk-reviewer",            3, "medium", ["security", "review", "architecture"],
        "Security review, dependency risk, architecture threat modelling"),

  // ── Tier: high cost ──────────────────────────────────────────────────────
  agent("reasoning-expert",   4, "high", ["reasoning", "architecture", "bug-fix"],
        "Logical reasoning, decision trees, complex trade-off analysis"),
  agent("seasoned-developer", 4, "high", ["production", "bug-fix", "implementation"],
        "Production debugging, infra troubleshooting, incident response"),
  agent("principal-engineer", 5, "high", ["architecture", "reasoning", "security"],
        "System architecture, technical strategy, cross-cutting design decisions"),
]

// Indexed for O(1) lookup
const REGISTRY_MAP = new Map<string, AgentProfile>(
  AGENT_REGISTRY.map((a) => [a.name, a])
)

export function getAgentProfile(name: string): AgentProfile | undefined {
  return REGISTRY_MAP.get(name)
}

// ---------------------------------------------------------------------------
// Complexity → required skill mapping
// ---------------------------------------------------------------------------

export type TaskComplexity = "trivial" | "routine" | "moderate" | "complex" | "critical"

const COMPLEXITY_SKILL: Record<TaskComplexity, number> = {
  trivial:  1,
  routine:  2,
  moderate: 3,
  complex:  4,
  critical: 5,
}

/**
 * Infer task complexity from descriptive text heuristics.
 * Returns a complexity level that drives the minimum skill requirement.
 */
export function inferComplexity(text: string): TaskComplexity {
  const t = text.toLowerCase()

  // Critical signals — always need expert
  if (/production incident|data loss|security breach|outage|critical bug|race condition|deadlock/.test(t))
    return "critical"

  // Complex signals — senior skill needed
  if (/architecture|distributed|migration|cross.?service|breaking change|auth|cryptograph|performance regression/.test(t))
    return "complex"

  // Moderate — standard professional work
  if (/implement|refactor|integrate|debug|test suite|api design|typescript error|type safe/.test(t))
    return "moderate"

  // Routine — simple, well-scoped
  if (/rename|move file|add import|update dependency|format|lint|comment|docstring/.test(t))
    return "routine"

  return "routine" // safe default; avoids over-spending
}

// ---------------------------------------------------------------------------
// Selection algorithm: cheapest-sufficient agent
// ---------------------------------------------------------------------------

export interface SelectionResult {
  agent: string
  profile: AgentProfile
  reason: string
}

/**
 * Select the cheapest agent that:
 *   1. Has skill ≥ required skill for the given complexity
 *   2. Has at least one matching specialization (preferred)
 *   3. Falls within the optional budget cap
 *
 * If no specialist meets the threshold, falls back to a generalist
 * at the appropriate skill level.
 *
 * @param taskTypes   Tags describing what the task involves
 * @param complexity  Inferred or declared task complexity
 * @param budgetCap   Optional hard ceiling on cost tier
 */
export function selectAgent(
  taskTypes: TaskType[],
  complexity: TaskComplexity,
  budgetCap?: CostTier,
): SelectionResult {
  const requiredSkill = COMPLEXITY_SKILL[complexity]
  const maxCostWeight = budgetCap ? COST_WEIGHT[budgetCap] : Infinity

  // Candidates that meet skill and budget thresholds
  const eligible = AGENT_REGISTRY.filter(
    (a) => a.skill >= requiredSkill && a.costWeight <= maxCostWeight
  )

  if (eligible.length === 0) {
    // Budget cap is too tight — relax it and pick the cheapest qualified agent
    const fallback = AGENT_REGISTRY
      .filter((a) => a.skill >= requiredSkill)
      .sort((a, b) => a.costWeight - b.costWeight)[0]

    if (fallback) {
      return {
        agent: fallback.name,
        profile: fallback,
        reason: `Budget cap relaxed — cheapest agent with skill ≥ ${requiredSkill} (${fallback.costTier})`,
      }
    }
    // Absolute fallback — best available agent
    const best = [...AGENT_REGISTRY].sort((a, b) => b.skill - a.skill)[0]!
    return { agent: best.name, profile: best, reason: "Absolute fallback: highest skill available" }
  }

  // Prefer specialists: eligible agents that match at least one task type, cheapest first
  const specialists = eligible
    .filter((a) => taskTypes.some((t) => a.specializations.includes(t)))
    .sort((a, b) => a.costWeight - b.costWeight || a.skill - b.skill)

  if (specialists.length > 0) {
    const pick = specialists[0]!
    return {
      agent: pick.name,
      profile: pick,
      reason: `Cheapest specialist: skill=${pick.skill}, cost=${pick.costTier}, matches [${taskTypes.join(",")}]`,
    }
  }

  // No specialist — cheapest generalist that meets skill threshold
  const generalist = eligible.sort((a, b) => a.costWeight - b.costWeight)[0]!
  return {
    agent: generalist.name,
    profile: generalist,
    reason: `No specialist available — cheapest generalist at skill ≥ ${requiredSkill}`,
  }
}

// ---------------------------------------------------------------------------
// Escalation: step up to next skill/cost tier after failure
// ---------------------------------------------------------------------------

/**
 * Return the next-tier-up agent for the same task types.
 * Used when a task fails or the result is marked low-confidence.
 *
 * @param currentAgent  The agent that just failed / underperformed
 * @param taskTypes     Task type tags (same as original selection)
 * @returns             A higher-tier agent, or null if already at ceiling
 */
export function escalateAgent(
  currentAgent: string,
  taskTypes: TaskType[],
): SelectionResult | null {
  const current = REGISTRY_MAP.get(currentAgent)
  if (!current) return null

  // Find candidates strictly above current cost weight
  const higher = AGENT_REGISTRY
    .filter(
      (a) =>
        a.costWeight > current.costWeight &&
        (taskTypes.length === 0 || taskTypes.some((t) => a.specializations.includes(t)))
    )
    .sort((a, b) => a.costWeight - b.costWeight || a.skill - b.skill)

  if (higher.length === 0) return null // already at ceiling

  const next = higher[0]!
  return {
    agent: next.name,
    profile: next,
    reason: `Escalated from ${currentAgent} (skill=${current.skill}, ${current.costTier}) → ${next.name} (skill=${next.skill}, ${next.costTier})`,
  }
}

// ---------------------------------------------------------------------------
// Task-type inference from free text
// ---------------------------------------------------------------------------

const TASK_TYPE_PATTERNS: Array<{ pattern: RegExp; type: TaskType }> = [
  { pattern: /find|search|explore|discover|identify|list|where|which file|understand|read/i,  type: "research" },
  { pattern: /implement|build|create|write|add|develop|code/i,                               type: "implementation" },
  { pattern: /refactor|rename|restructure|reorganize|clean.?up|move/i,                        type: "refactor" },
  { pattern: /fix|debug|resolve|patch|repair|diagnose|broken|error|exception|failure/i,      type: "bug-fix" },
  { pattern: /test|spec|coverage|assert|verify|validate|regression/i,                        type: "testing" },
  { pattern: /review|quality|lint|style|best practice|improve/i,                             type: "review" },
  { pattern: /architect|design|system|adr|decision|strategy|scalab/i,                        type: "architecture" },
  { pattern: /security|auth|vulnerab|cve|secret|permiss|privilege|inject/i,                  type: "security" },
  { pattern: /log|bash|shell|process|pid|stdout|stderr|journal|syslog|grep/i,               type: "logs-bash" },
  { pattern: /reason|tradeoff|trade-off|decision|compare|pros.*cons|evaluate/i,              type: "reasoning" },
  { pattern: /production|incident|outage|deploy|infra|kubernetes|k8s|server|live/i,          type: "production" },
]

/**
 * Infer task type tags from free text.
 * Returns deduplicated list, most-specific matches first.
 */
export function inferTaskTypes(text: string): TaskType[] {
  const found = new Set<TaskType>()
  for (const { pattern, type } of TASK_TYPE_PATTERNS) {
    if (pattern.test(text)) found.add(type)
  }
  return found.size > 0 ? [...found] : ["implementation"] // safe default
}

