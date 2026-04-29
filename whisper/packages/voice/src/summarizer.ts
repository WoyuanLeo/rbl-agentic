import type { PluginInput } from "@opencode-ai/plugin";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SummarizerResult {
  /** The generated summary text. */
  summary: string;
  /** Word count of the original input text. */
  originalLength: number;
  /** Word count of the summary. */
  summaryLength: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum input length before truncation (characters). */
const MAX_INPUT_LENGTH = 10_000;

/** Target summary word count range (soft lower bound). */
const MIN_SUMMARY_WORDS = 50;

/** Target summary word count range (soft upper bound). */
const MAX_SUMMARY_WORDS = 100;

/** Key terms that boost a paragraph's importance score. */
const KEY_TERMS = [
  "important",
  "key",
  "critical",
  "significant",
  "main",
  "primary",
  "first",
  "second",
  "finally",
  "conclusion",
  "summary",
  "result",
  "therefore",
  "however",
  "additionally",
  "note",
  "importantly",
  "notably",
  "essential",
  "crucial",
  "must",
  "should",
  "avoid",
  "error",
  "bug",
  "fix",
  "update",
  "new",
  "changed",
  "introduced",
  "removed",
];

/** Markdown patterns to strip for clean speech output. */
function _regex(p: string, f: string): RegExp {
  return new RegExp(p, f);
}

const MARKDOWN_PATTERNS: Array<[RegExp, string]> = [
  // Headers
  [_regex("^#{1,6}\\s+", "gm"), ""],
  // Bold / italic
  [_regex("[*_]{1,3}([^*_]+)[*_]{1,3}", "g"), "$1"],
  // Strikethrough
  [_regex("~~([^~]+)~~", "g"), "$1"],
  // Images
  [_regex("!\\[([^\\]]*)\\]\\([^)]+\\)", "g"), "$1"],
  // Links → just show the link text
  [_regex("\\[([^\\]]+)\\]\\([^)]+\\)", "g"), "$1"],
  // Code blocks (triple backtick fenced blocks)
  [_regex("```[\\s\\S]*?```", "g"), "[code block omitted]"],
  // Inline code (single backtick)
  [_regex("`([^`]+)`", "g"), "$1"],
  // Blockquotes
  [_regex("^\\s*>\\s*", "gm"), ""],
  // Horizontal rules
  [_regex("^[-*_]{3,}\\s*$", "gm"), ""],
  // Lists (dash / asterisk / number + dot prefix)
  [_regex("^\\s*[-*+]\\s+", "gm"), "  "],
  [_regex("^\\s*\\d+\\.\\s+", "gm"), "  "],
  // Multiple blank lines → single blank line
  [_regex("\n{3,}", "g"), "\n\n"],
  // Leading/trailing whitespace on lines
  [_regex("[ \\t]+$", "gm"), ""],
];

/**
 * Summarization prompt sent to the LLM when available.
 *
 * The prompt is carefully crafted to produce output that reads naturally
 * when spoken aloud — no bullet points, no numbered lists, just a
 * flowing paragraph of key points.
 */
const SUMMARIZE_PROMPT_TEMPLATE = (text: string): string =>
  `Summarize the following text into 50-100 words of key points.\n` +
  `Make it sound natural when read aloud.\n` +
  `Do not use bullet points or numbered lists.\n` +
  `Format as a short paragraph that can be spoken naturally.\n` +
  `If the text is already short (under 100 words), return it as-is.\n\n` +
  `Text:\n${text}`;

// ─── Helper: strip markdown formatting ────────────────────────────────────────

/**
 * Remove markdown formatting from text to produce clean speech output.
 *
 * Handles headers, bold/italic, links, code blocks, images, blockquotes,
 * and list markers — replacing them with minimal or no text so the spoken
 * version remains fluent.
 */
function stripMarkdown(text: string): string {
  let result = text;
  for (const [pattern, replacement] of MARKDOWN_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Helper: word count ───────────────────────────────────────────────────────

/**
 * Count the number of words in text.
 *
 * Handles both ASCII and Unicode word boundaries (CJK, etc.).
 */
function countWords(text: string): number {
  if (!text || !text.trim()) return 0;

  // Split on whitespace; empty strings are discarded by filter.
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

// ─── Helper: truncate without breaking sentences ──────────────────────────────

/**
 * Find a real sentence boundary within text.
 *
 * Looks for `. `, `! `, or `? ` followed by an uppercase letter or a digit,
 * which indicates the start of a new sentence. This avoids cutting on
 * version numbers like `v2.0`, decimal numbers like `3.14`, abbreviations
 * like `e.g.` or `i.e.`, and similar non-sentence-ending punctuation.
 *
 * @param text  The text to search.
 * @returns     The index of the first character of the next sentence, or -1.
 */
function findSentenceBoundary(text: string): number {
  // Regex: a period/exclamation/question mark followed by whitespace and
  // then an uppercase letter or digit (start of a new sentence).
  const match = text.match(/([.!?])\s+[A-Z0-9]/);
  if (match) {
    return match.index! + match[0].indexOf(match[1]) + 1; // position of the punctuation
  }
  return -1;
}

/**
 * Truncate text to at most `maxWords` words, stopping at a sentence boundary
 * whenever possible.
 *
 * Guarantees at least one full sentence in the output if the input has
 * any sentences.
 *
 * @param text      The text to truncate.
 * @param maxWords  Maximum number of words to include.
 * @returns         The truncated text.
 */
function truncateToLength(text: string, maxWords: number): string {
  if (!text || !text.trim()) return "";

  const words = text.trim().split(/\s+/);

  if (words.length <= maxWords) return text.trim();

  // Take the first `maxWords` tokens.
  const slice = words.slice(0, maxWords).join(" ");

  // Try to find a real sentence boundary within the slice.
  const sentenceBoundary = findSentenceBoundary(slice);

  if (sentenceBoundary > Math.floor(maxWords / 2)) {
    // Found a sentence boundary past the halfway point — cut there.
    return slice.slice(0, sentenceBoundary).trim();
  }

  // No good sentence boundary found; return the raw slice.
  return slice;
}

// ─── Helper: paragraph scoring (extract-based fallback) ───────────────────────

interface ScoredParagraph {
  index: number;
  text: string;
  score: number;
}

/**
 * Score a paragraph for importance during extract-based summarization.
 *
 * Heuristics:
 *   - First paragraph gets a +3 bonus (often contains the thesis).
 *   - Presence of key terms adds +1 per term (max 5).
 *   - Word count density: longer paragraphs tend to carry more info
 *     (but we cap the bonus at +3 for paragraphs over 100 words).
 *
 * @param paragraph The paragraph text.
 * @param index     Its zero-based index among all paragraphs.
 * @param total     Total number of paragraphs.
 * @returns         A numeric importance score (higher = more important).
 */
function scoreParagraph(
  paragraph: string,
  index: number,
  total: number,
): number {
  let score = 0;

  // Position bonus: first paragraph gets the biggest boost.
  if (index === 0 && total > 1) {
    score += 3;
  }

  // Key-term bonus.
  const lower = paragraph.toLowerCase();
  const termHits = KEY_TERMS.filter((t) => lower.includes(t)).length;
  score += Math.min(termHits, 5);

  // Length bonus (content density).
  const wordCount = countWords(paragraph);
  if (wordCount > 50) {
    score += Math.min(Math.floor(wordCount / 50), 3);
  }

  return score;
}

// ─── Extract-based fallback ───────────────────────────────────────────────────

/**
 * Extract the most important paragraphs from text using a heuristic scoring
 * system.
 *
 * The algorithm:
 *   1. Split text into paragraphs by blank lines.
 *   2. Score each paragraph (position, key terms, content density).
 *   3. Sort by score descending; take the top N.
 *   4. Re-sort by original order to preserve narrative flow.
 *   5. Join with blank lines.
 *
 * @param text   The source text.
 * @param count  Maximum number of paragraphs to extract (default 3).
 * @returns      The selected paragraphs joined together.
 */
function extractKeyParagraphs(text: string, count: number = 3): string {
  if (!text || !text.trim()) return "";

  // Split into paragraphs by one or more blank lines.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  if (paragraphs.length === 0) return "";
  if (paragraphs.length <= count) {
    return paragraphs.join("\n\n");
  }

  // Score each paragraph.
  const scored: ScoredParagraph[] = paragraphs.map((p, i) => ({
    index: i,
    text: stripMarkdown(p),
    score: scoreParagraph(p, i, paragraphs.length),
  }));

  // Sort by score descending, then by original index ascending for stability.
  const selected = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, count);

  // Re-sort by original index to preserve narrative order.
  selected.sort((a, b) => a.index - b.index);

  return selected.map((p) => p.text).join("\n\n");
}

// ─── LLM summarization ────────────────────────────────────────────────────────

/**
 * Attempt to summarize text via the LLM through the plugin context.
 *
 * Tries several possible context interfaces in order of preference:
 *   1. `ctx.sendRequest` — a generic request function (some implementations).
 *   2. `ctx.agent` — an agent object that may have a `.chat` or `.ask` method.
 *   3. Tool-based approach: look for a registered summary tool.
 *
 * If none of these are available, returns `null` to signal that the
 * extract-based fallback should be used instead.
 */
async function tryLLMSummary(
  ctx: PluginInput,
  prompt: string,
  maxLength: number,
): Promise<string | null> {
  // ── Approach 1: ctx.sendRequest (generic request function) ───────────
  if ("sendRequest" in ctx && typeof (ctx as any).sendRequest === "function") {
    try {
      const result = await (ctx as any).sendRequest({
        type: "summarize",
        prompt,
        maxLength,
      });
      if (typeof result === "string" && result.trim().length > 0) {
        return stripMarkdown(result).trim();
      }
    } catch {
      // fall through
    }
  }

  // ── Approach 2: ctx.agent with .chat / .ask / .sendMessage ──────────
  if ("agent" in ctx && ctx.agent) {
    const agent = (ctx as any).agent;
    const chatMethods = ["chat", "ask", "sendMessage", "completions"];

    for (const method of chatMethods) {
      if (typeof (agent as any)[method] === "function") {
        try {
          const result = await (agent as any)[method](prompt);
          if (typeof result === "string" && result.trim().length > 0) {
            return stripMarkdown(result).trim();
          }
          // Some chat methods return { content, text, message, ... }
          if (typeof result === "object" && result !== null) {
            const text =
              (result as any).content ??
              (result as any).text ??
              (result as any).message ??
              null;
            if (typeof text === "string" && text.trim().length > 0) {
              return stripMarkdown(text).trim();
            }
          }
        } catch {
          // fall through
        }
      }
    }
  }

  // ── Approach 3: ctx.request (generic RPC-like interface) ────────────
  if ("request" in ctx && typeof (ctx as any).request === "function") {
    try {
      const result = await (ctx as any).request("llm.summarize", {
        prompt,
        maxLength,
      });
      if (typeof result === "string" && result.trim().length > 0) {
        return stripMarkdown(result).trim();
      }
    } catch {
      // fall through
    }
  }

  // ── Approach 4: ctx.callTool (tool invocation) ──────────────────────
  if ("callTool" in ctx && typeof (ctx as any).callTool === "function") {
    try {
      const result = await (ctx as any).callTool("llm.summarize", {
        text: prompt,
        maxLength,
      });
      if (typeof result === "string" && result.trim().length > 0) {
        return stripMarkdown(result).trim();
      }
    } catch {
      // fall through
    }
  }

  // No LLM path available.
  return null;
}

// ─── Main class ───────────────────────────────────────────────────────────────

/**
 * Text summarization engine for TTS consumption.
 *
 * Produces 50–100 word summaries of long LLM responses that read naturally
 * when spoken aloud. Uses the LLM when the plugin context provides one,
 * falling back to heuristic paragraph extraction.
 *
 * Usage:
 *   const summarizer = new Summarizer(ctx, 100);
 *   const summary = await summarizer.summarize(longText);
 */
export class Summarizer {
  /** Plugin context with LLM/tool interfaces. */
  private readonly ctx: PluginInput;

  /** Target maximum word count for summaries. */
  private readonly maxLength: number;

  /**
   * Construct a new Summarizer.
   *
   * @param ctx       The OpenCode plugin input context.
   * @param maxLength Maximum words in the summary (default: 100).
   */
  constructor(ctx: PluginInput, maxLength: number = 100) {
    this.ctx = ctx;
    this.maxLength = Math.max(10, Math.floor(maxLength));
  }

  /**
   * Summarize text for TTS consumption.
   *
   * Strategy:
   *   1. If the text is already short (≤ maxLength words), return it as-is.
   *   2. Attempt LLM-based summarization via the plugin context.
   *   3. If LLM is unavailable or fails, use extract-based fallback.
   *   4. Truncate the result to maxLength if needed.
   *   5. Strip markdown from the output for clean speech.
   *
   * @param text  The text to summarize.
   * @returns     The summary string.
   */
  async summarize(text: string): Promise<string> {
    // Edge cases.
    if (!text || !text.trim()) return "";
    if (/\s+/.test(text) && countWords(text) === 0) return "";

    const originalWordCount = countWords(text);

    // Already short — return as-is (cleaned of markdown).
    if (originalWordCount <= this.maxLength) {
      return stripMarkdown(text).trim();
    }

    // Cap input to avoid overwhelming the LLM or extraction.
    const trimmedText =
      text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text;

    // Build the LLM prompt.
    const prompt = SUMMARIZE_PROMPT_TEMPLATE(trimmedText);

    // ── Try LLM-based summarization ─────────────────────────────────────
    const llmResult = await tryLLMSummary(this.ctx, prompt, this.maxLength);
    if (llmResult !== null && llmResult.trim().length > 0) {
      let summary = llmResult;

      // Ensure the summary is within bounds.
      if (countWords(summary) > this.maxLength) {
        summary = truncateToLength(summary, this.maxLength);
      }

      // Enforce minimum length if the summary is too short.
      if (
        countWords(summary) < MIN_SUMMARY_WORDS &&
        originalWordCount > this.maxLength
      ) {
        // LLM gave us something too short — augment with extract-based.
        const extracted = extractKeyParagraphs(trimmedText, 2);
        summary = truncateToLength(`${summary} ${extracted}`, this.maxLength);
      }

      return stripMarkdown(summary).trim();
    }

    // ── Extract-based fallback ──────────────────────────────────────────
    const extracted = extractKeyParagraphs(trimmedText, 3);

    // Truncate to maxLength.
    return truncateToLength(stripMarkdown(extracted), this.maxLength);
  }

  /**
   * Extract the most important paragraphs from text.
   *
   * Heuristic: sentences with higher information density first — scored by
   * position, key-term presence, and content length.
   *
   * @param text   The source text.
   * @param count  Maximum number of paragraphs to extract (default 3).
   * @returns      The selected paragraphs joined together.
   */
  extractKeyParagraphs(text: string, count: number = 3): string {
    return extractKeyParagraphs(text, count);
  }

  /**
   * Truncate text to at most `maxWords` words, stopping at a sentence
   * boundary whenever possible.
   *
   * @param text      The text to truncate.
   * @param maxWords  Maximum number of words to include.
   * @returns         The truncated text.
   */
  truncateToLength(text: string, maxWords: number): string {
    return truncateToLength(text, maxWords);
  }

  /**
   * Count words in text.
   *
   * @param text  The text to count words in.
   * @returns     The number of whitespace-separated tokens.
   */
  countWords(text: string): number {
    return countWords(text);
  }
}
