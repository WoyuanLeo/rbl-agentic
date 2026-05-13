# OpenCode Patches — mem-arch Plugin Suite

This file documents all patches needed to install the mem-arch plugin suite on OpenCode.

> **When to apply:** After installing or upgrading OpenCode, before running `opencode` with the mem-arch plugins.

---

## Patch 1: NPM Patches (Already Applied)

These patches are **already applied** via Bun's `patchedDependencies` in `/Users/tianzh/IdeaProjects/opencode/package.json`.

| Package | Patch File | Purpose |
|---|---|---|
| `@npmcli/agent@4.0.0` | `patches/@npmcli%2Fagent@4.0.0.patch` | Fix proxy URL serialization — calls `.toString()` on `this.#proxy` before returning |
| `@silvia-odwyer/photon-node@0.3.4` | `patches/@silvia-odwyer%2Fphoton-node@0.3.4.patch` | Allow Bun-compiled binary to override WASM asset path via env var |
| `@standard-community/standard-openapi@0.2.9` | `patches/@standard-community%2Fstandard-openapi@0.2.9.patch` | Handle `$ref` values that include URLs (`://`) — return remaining keys instead of treating as schema references |
| `solid-js@1.9.10` | `patches/solid-js@1.9.10.patch` | Fix Solid.js Transition reactivity issue (#2046) — set committed `node.value` on first computation during transition |

**Verification:** Run `bun install` in the OpenCode directory. Bun will automatically apply these patches based on the `patchedDependencies` field.

---

## Patch 2: Coordinator Agent Registry

> **✅ Already applied** — The coordinator agent is built into OpenCode's `agent.ts` (lines 272-297) with full permissions. This patch was upstreamed in current OpenCode versions and no longer needs manual application.

Add the `@coordinator` agent entry to OpenCode's native agent registry.

### Location

`packages/opencode/src/agent/agent.ts` — inside the `agents` object (around line 272, after the `summary` entry, before the closing `}`).

### What to Add

Add this entry to the `agents` object:

```typescript
coordinator: {
  name: "coordinator",
  description:
    "Pure orchestrator: decomposes goals into sub-tasks and delegates to specialised agents. Never performs the work itself.",
  prompt: `You are the Coordinator Agent. Decompose complex goals into focused tasks and coordinate sub-agents.

Available sub-agents: explore, general, code-reviewer, principal-engineer, quality-assurance, and others.

For each complex goal, break it into:
1. Parallel groups (independent tasks, same agent) for concurrent execution
2. Sequential tasks (with dependencies) that must run in order
3. Mandatory pre-closure code-reviewer check for progress + implementation quality

Do not declare completion when review gaps exist. Revisit gaps first.

Provide your response as structured JSON with analysis, recommendations, tasks, and parallel_groups.`,
  mode: "primary" as const,
  steps: 5,
  permission: {
    task: "allow",
    global_memory_query: "allow",
    update_task_progress: "allow",
    query_task_progress: "allow",
  },
  options: {
    allowConcurrentTasks: true,
    maxParallelTasks: 5,
    maxConcurrencyPerAgent: 1,
  },
},
```

### Where Exactly

In `agent.ts`, find the closing `}` of the `agents` object (the line after `summary: { ... }`) and insert the coordinator block before it.

The `agents` object spans approximately lines 119–272. The `coordinator` entry goes right before the closing `}` on line 272.

---

## Patch 3: Korean/CJK IME Fix

Fixes IME last-character truncation in the TUI prompt when pressing Enter with Korean (or other CJK) input method editors active.

### Location

`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`

### The Fix

Find the line containing `onSubmit={submit}` and replace it with:

```tsx
onSubmit={() => {
  // IME: double-defer so the last composed character (e.g. Korean
  // hangul) is flushed to plainText before we read it for submission.
  setTimeout(() => setTimeout(() => submit(), 0), 0)
}}
```

### Manual sed Command

```bash
cd /Users/tianzh/IdeaProjects/opencode
sed -i '' 's|onSubmit={submit}|onSubmit={() => {\n                // IME: double-defer so the last composed character (e.g. Korean\n                // hangul) is flushed to plainText before we read it for submission.\n                setTimeout(() => setTimeout(() => submit(), 0), 0)\n              }}|' packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
```

### Verification

After patching, the prompt file should contain the text `setTimeout(() => setTimeout` (a double-defer pattern).

### Reference

- Issue: [anomalyco/opencode#14371](https://github.com/anomalyco/opencode/issues/14371)
- Fork with fix: [claudianus/opencode](https://github.com/claudianus/opencode) branch `fix-zhipuai-coding-plan-thinking`

---

## Patch 4: Custom Agent Definitions

Install 8 custom agent definition `.md` files from the mem-arch project into the OpenCode agents directory.

### Source Files

All 8 files are at `/Users/tianzh/IdeaProjects/rbl-agentic/opencode/agent/`:

| File | Agent Name | Mode | Description |
|---|---|---|---|
| `analysis-planner.md` | `analysis-planner` | `primary` | Strategic analysis and planning without implementation |
| `code-reviewer-docs.md` | `code-reviewer-docs` | `subagent` | Code review with emphasis on documentation quality |
| `docs-maintainer.md` | `docs-maintainer` | `subagent` | Project documentation creation and updates |
| `investigation-bash-expert.md` | `investigation-bash-expert` | `subagent` | Deep system investigation using bash commands |
| `principal-engineer.md` | `principal-engineer` | `subagent` | Technical strategy and architecture leadership |
| `quality-assurance.md` | `quality-assurance` | `subagent` | Independent testing and quality validation |
| `risk-reviewer.md` | `risk-reviewer` | `subagent` | Security risk and dependency analysis |
| `seasoned-developer.md` | `seasoned-developer` | `subagent` | Senior implementation and refactoring |

### Target Directory

OpenCode loads `.md` agent files from directories matching `{agent,agents}/**/*.md`:
- `<project>/.opencode/agents/` (per-project)
- `~/.config/opencode/agents/` (user-global)
- Any directory listed in the `skillDirs` config

### Installation

```bash
# Per-project (inside the mem-arch project)
mkdir -p /Users/tianzh/IdeaProjects/rbl-agentic/.opencode/agents
cp /Users/tianzh/IdeaProjects/rbl-agentic/opencode/agent/*.md /Users/tianzh/IdeaProjects/rbl-agentic/.opencode/agents/

# Or user-global (available in all projects)
mkdir -p ~/.config/opencode/agents
cp /Users/tianzh/IdeaProjects/rbl-agentic/opencode/agent/*.md ~/.config/opencode/agents/
```

### How It Works

OpenCode's config agent loader (`packages/opencode/src/config/agent.ts`) uses `Glob.scan("{agent,agents}/**/*.md")` to find and parse all `.md` agent files. Each file's frontmatter (YAML `---`) defines agent properties (`description`, `mode`, `permission`, `tools`), and the markdown body becomes the system prompt.

---

## Patch 5: Custom Theme (Nord-based)

Install the Nord-based custom theme into OpenCode's theme configuration.

### Source File

`/Users/tianzh/IdeaProjects/rbl-agentic/opencode/themes/custom-theme.json`

### Target Location

The theme should be placed in the OpenCode config directory:

```bash
# Per-project (inside the project)
cp /Users/tianzh/IdeaProjects/rbl-agentic/opencode/themes/custom-theme.json /Users/tianzh/IdeaProjects/rbl-agentic/.opencode/themes.json

# Or user-global
cp /Users/tianzh/IdeaProjects/rbl-agentic/opencode/themes/custom-theme.json ~/.config/opencode/themes.json
```

### Theme Details

The custom theme uses a Nord color palette with 16 definitions (`nord0`–`nord15`):

| Color | Hex | Usage |
|---|---|---|
| `nord0` | `#0260A2` | Base dark background |
| `nord1` | `#3B4252` | Secondary background |
| `nord4` | `#fffbb9` | Cream text accent |
| `nord8` | `#88C0D0` | Primary UI color |
| `nord14` | `#A3BE8C` | Success/diff-added |
| `nord15` | `#B48EAD` | Decorative accent |

The theme covers:
- UI elements (primary, secondary, accent, error, warning, success, info)
- Text styling (text, textMuted)
- Backgrounds (background, backgroundPanel, backgroundElement)
- Borders (border, borderActive, borderSubtle)
- Diff view (added, removed, context, highlighting)
- Markdown rendering (headings, links, code, quotes, lists)
- Syntax highlighting (keywords, strings, variables, types, operators)

---

## Quick Apply Script

Run all patches at once (except NPM patches, which are already applied):

```bash
#!/usr/bin/env bash
set -euo pipefail

OPENCODE_DIR="/Users/tianzh/IdeaProjects/opencode"
PATCH_SRC="/Users/tianzh/IdeaProjects/rbl-agentic/opencode"

echo ""
echo "=== Patch 2: Coordinator Agent Registry ==="
echo "  → SKIPPED: Already built into OpenCode (see Patch 2 above)"

echo ""
echo "=== Patch 3: Korean/CJK IME Fix ==="
sed -i '' 's|onSubmit={submit}|onSubmit={() => {\n                // IME: double-defer so the last composed character (e.g. Korean\n                // hangul) is flushed to plainText before we read it for submission.\n                setTimeout(() => setTimeout(() => submit(), 0), 0)\n              }}|' \
  "$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx"
echo "  → Applied"

echo ""
echo "=== Patch 4: Custom Agent Definitions ==="
mkdir -p ~/.config/opencode/agents
cp "$PATCH_SRC/agent/"*.md ~/.config/opencode/agents/
echo "  → Installed 8 agent files to ~/.config/opencode/agents/"

echo ""
echo "=== Patch 5: Custom Theme ==="
mkdir -p ~/.config/opencode
cp "$PATCH_SRC/themes/custom-theme.json" ~/.config/opencode/themes.json
echo "  → Installed Nord theme to ~/.config/opencode/themes.json"

echo ""
echo "=== Patch 6: Mandatory Pre-Closure Review Gate ==="
echo "  → Applied in mem-arch packages/coordination/ (library consumed by memory plugin)"

echo ""
echo "Done! All patches applied."
```

---

## Patch 6: Mandatory Pre-Closure Review Gate (Orchestration Layer)

> **Note:** The coordination package (`@mem-arch/coordination`) is a **library** consumed by the memory plugin via dynamic imports (e.g., `import("@mem-arch/coordination/analyze")`). It is no longer a standalone plugin. These orchestration changes remain active within the memory plugin's analysis pipeline.

These changes add programmatic review enforcement to the mem-arch coordination package, complementing the LLM-prompt-driven instructions in `system-prompt.txt`.

### Location

`packages/coordination/src/orchestrate.ts` and `packages/coordination/src/system-prompt.txt`

### What Changed

#### A. `DecomposeOptions.reviewAgent` (orchestrate.ts, line 43–44)

Added a new option to customize which agent performs the pre-closure review:

```typescript
  /** Agent to use for pre-closure review. Defaults to "code-reviewer". */
  reviewAgent?: string
```

#### B. `pre-closure-review` task in all 5 decomposeGoal templates

Every template now ends with a mandatory review task that depends on the last implementation task:

| Template | Last Task | Review Depends On | Line |
|---|---|---|---|
| **Refactor** | `update-tests` | `["update-tests"]` | 69 |
| **Implement** | `implement-feature` | `["implement-feature"]` | 88 |
| **Fix** | `verify-fix` | `["verify-fix"]` | 109 |
| **Migrate** | `validate-migration` | `["validate-migration"]` | 130 |
| **Generic** | `main-task` | `["main-task"]` | 147 |

All use: `agent: opts.reviewAgent ?? "code-reviewer"`

#### C. Review gate enforcement in `executePlan()` (orchestrate.ts, lines 300–313)

After all tasks complete, the executor scans the `pre-closure-review` output for gap keywords. If gaps are detected, it flags the plan as failed:

```typescript
    // Review gate enforcement: check if the pre-closure review flagged gaps
    const reviewResult = results.find((r) => r.taskId === "pre-closure-review")
    if (reviewResult && reviewResult.status === "completed") {
      const reviewText = reviewResult.output.toLowerCase()
      const hasGaps = /gap|remain|miss|todo|revisit|not done|still needs|incomplete/.test(reviewText)
      if (hasGaps) {
        results.push({
          taskId: "review-gate-failed",
          status: "failed",
          output: `REVIEW_GATE_BLOCKED: The pre-closure review identified gaps that must be revisited before the goal can be considered complete. Coordinator must spawn follow-up tasks.`,
        })
        plan.status = "failed"
      }
    }
```

**Behavior:**
- **Clean review** (no gap keywords) → plan stays `completed`
- **Gaps detected** → plan set to `failed`, `review-gate-failed` result pushed, coordinator receives `REVIEW_GATE_BLOCKED` signal to spawn follow-up tasks

#### D. `system-prompt.txt` JSON output format (line 113–119)

The mandatory JSON output format now includes a `review` section:

```json
{
  "review": {
    "review_task_id": "task-3",
    "review_agent": "code-reviewer",
    "summary": "Concise status and implementation quality summary",
    "gaps": ["Gap 1", "Gap 2"],
    "revisit_required": true
  }
}
```

### How It Works Together

1. **`decomposeGoal()`** injects a `pre-closure-review` task as the final step in every plan template
2. **`executePlan()`** runs all tasks including review, then checks the output for gap indicators
3. **`system-prompt.txt`** instructs the coordinator LLM to always spawn a `code-reviewer` sub-agent in step 5 and report gaps in the JSON output
4. **Two layers of enforcement**: The orchestration layer provides a programmatic signal (`REVIEW_GATE_BLOCKED` + `plan.status = "failed"`) while the prompt layer ensures the LLM coordinator follows the workflow even when plans are constructed manually (not via `decomposeGoal`)

---

## Uninstall / Revert

To undo all custom patches and revert to stock OpenCode:

```bash
# Remove custom agent definitions
rm -f ~/.config/opencode/agents/*.md

# Remove custom theme
rm -f ~/.config/opencode/themes.json

# Revert IME fix (revert the sed change)
# Run: install-korean-ime-fix.sh again with NO argument, or re-install official release
# curl -fsSL https://opencode.ai/install | bash

# Revert coordinator agent registry entry
# (Already built into OpenCode — no revert needed)

# Revert orchestration review gate (Patch 6) — coordination is now a library
# Restore orchestrate.ts and system-prompt.txt to their prior state
git checkout HEAD -- packages/coordination/src/orchestrate.ts
git checkout HEAD -- packages/coordination/src/system-prompt.txt
```

> **Note:** Re-downloading OpenCode from `https://opencode.ai/install` will replace all source modifications with the official release.
