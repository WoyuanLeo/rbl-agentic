import { Effect, Scope } from "effect"

// ---------------------------------------------------------------------------
// Health Checker
// ---------------------------------------------------------------------------

/**
 * Health monitoring utilities for system reliability.
 * 
 * Health endpoints:
 * - GET /health - Returns 200 OK if node is healthy
 * - GET /status - Returns detailed node status (optional)
 * 
 * Timeout: 5 seconds per health check
 * Default interval: 30 seconds for periodic monitoring
 */
export const HealthChecker = {
  /**
   * Check if a remote node is healthy by sending GET to /health.
   * Falls back to "unhealthy" on any network error or non-2xx response.
   */
  checkHealth: (url: string): Effect.Effect<boolean, Error> =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(5000),
        })
        return res.ok
      },
      catch: () => false as boolean,
    }).pipe(
      Effect.orElseSucceed(() => false),
    ),

  /**
   * Check health of multiple nodes in parallel.
   * Returns a record mapping URLs to health status.
   */
  checkMultipleHealth: (urls: string[]): Effect.Effect<Record<string, boolean>, Error> =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        urls.map((u) => HealthChecker.checkHealth(u)),
        { concurrency: "unbounded" },
      )
      return Object.fromEntries(urls.map((u, i) => [u, results[i]]))
    }),

  /**
   * Periodically check all nodes and log health status.
   * 
   * WARNING: This effect runs forever. Use Effect.scoped to manage lifecycle.
   */
  monitorHealth: (urls: string[], intervalMs: number = 30_000): Effect.Effect<void, Error> =>
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(intervalMs)
        yield* HealthChecker.checkMultipleHealth(urls).pipe(
          Effect.tap((health) =>
            Effect.sync(() => {
              const healthyCount = Object.values(health).filter(Boolean).length
              const totalCount = Object.keys(health).length
              console.log(`[health-check] ${healthyCount}/${totalCount} nodes healthy`)
            }),
          ),
          Effect.catchAll(() => Effect.void), // Don't fail on health check errors
        )
      }),
    ),

  /**
   * Check health and return result as JSON string (for tool usage).
   */
  checkHealthJson: (url: string): Effect.Effect<string, Error> =>
    Effect.gen(function* () {
      const healthy = yield* HealthChecker.checkHealth(url)
      return JSON.stringify({ url, healthy, timestamp: Date.now() })
    }).pipe(Effect.orElseSucceed(() => JSON.stringify({ url, healthy: false, timestamp: Date.now(), error: "check failed" }))),
}

// ---------------------------------------------------------------------------
// Failover Manager
// ---------------------------------------------------------------------------

/**
 * Failover manager for automatic task redistribution.
 * 
 * Usage:
 * ```typescript
 * yield* FailoverManager.failover(
 *   "http://primary:8080",
 *   ["http://backup1:8080", "http://backup2:8080"],
 *   (url) => HttpClient.sendTask(url, task),
 * )
 * ```
 */
export const FailoverManager = {
  /**
   * Try each backup URL in order until one is healthy, then run action against it.
   * 
   * Returns the result of the action on the first healthy node.
   * Fails if all nodes (primary + backups) are unhealthy.
   */
  failover: <T>(
    primary: string,
    backups: string[],
    action: (url: string) => Effect.Effect<T, Error>,
  ): Effect.Effect<T, Error> =>
    Effect.gen(function* () {
      // Try primary first
      const primaryHealthy = yield* HealthChecker.checkHealth(primary)
      if (primaryHealthy) {
        return yield* action(primary)
      }

      console.log(`[failover] Primary ${primary} is unhealthy, trying backups...`)

      // Fall back to backups in order
      for (const url of backups) {
        const ok = yield* HealthChecker.checkHealth(url)
        if (ok) {
          console.log(`[failover] Backup ${url} is healthy, using it`)
          return yield* action(url)
        }
      }

      return yield* Effect.fail(
        new Error(`Failover failed: primary ${primary} and all backups (${backups.join(", ")}) are unhealthy`)
      )
    }),

  /**
   * Try each node in a list until one is healthy, then run action.
   */
  failoverFromList: <T>(
    nodes: string[],
    action: (url: string) => Effect.Effect<T, Error>,
  ): Effect.Effect<T, Error> =>
    Effect.gen(function* () {
      for (const url of nodes) {
        const ok = yield* HealthChecker.checkHealth(url)
        if (ok) {
          return yield* action(url)
        }
      }

      return yield* Effect.fail(
        new Error(`Failover failed: all nodes (${nodes.join(", ")}) are unhealthy`)
      )
    }),
}

// ---------------------------------------------------------------------------
// Circuit Breaker (Simple)
// ---------------------------------------------------------------------------

/**
 * Simple circuit breaker for remote node calls.
 * 
 * Opens circuit after `failureThreshold` consecutive failures.
 * Half-opens after `recoveryTimeoutMs`.
 */
export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed"
  private failureCount = 0
  private lastFailureTime = 0
  private readonly failureThreshold: number
  private readonly recoveryTimeoutMs: number

  constructor(opts?: { failureThreshold?: number; recoveryTimeoutMs?: number }) {
    this.failureThreshold = opts?.failureThreshold ?? 3
    this.recoveryTimeoutMs = opts?.recoveryTimeoutMs ?? 60_000
  }

  private shouldHalfOpen(): boolean {
    return Date.now() - this.lastFailureTime > this.recoveryTimeoutMs
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open" && this.shouldHalfOpen()) {
      this.state = "half-open"
    }

    if (this.state === "open") {
      throw new Error(`Circuit breaker is open for ${this.failureCount} consecutive failures`)
    }

    try {
      const result = await fn()
      this.failureCount = 0
      this.state = "closed"
      return result
    } catch (e) {
      this.failureCount++
      this.lastFailureTime = Date.now()
      if (this.failureCount >= this.failureThreshold) {
        this.state = "open"
      }
      throw e
    }
  }
}
