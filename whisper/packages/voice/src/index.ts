import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import * as fs from "node:fs"
import * as path from "node:path"
import { defaultConfig, type VoicePluginConfig } from "./config.js"
import { AudioCapture, AudioPlayer } from "./audio.js"
import type { STTEngine } from "./stt.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the model file path relative to the source directory.
 * The source lives at packages/voice/src/ — go up two levels to find
 * the project-root models/ directory where ggml-{variant}.bin resides.
 */
function resolveModelPath(variant: string): string {
  const distDir = path.dirname(new URL(".", import.meta.url).pathname)
  // distDir is packages/voice/dist/ — go up 3 to get to whisper/
  const projectRoot = path.resolve(distDir, "..", "..", "..")
  return path.join(projectRoot, "models", `ggml-${variant}.bin`)
}

// File logger — always writes to disk, even in headless/fullscreen mode
const LOG_FILE = path.join(process.env.HOME || "/", ".opencode-voice.log")

function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const VoicePlugin: Plugin = async (ctx: PluginInput, pluginConfig?: Record<string, unknown>) => {
  // --- Configuration ---
  const rawConfig = (pluginConfig as unknown as VoicePluginConfig) || {}
  const config: VoicePluginConfig = {
    ...defaultConfig,
    ...rawConfig,
  }

  // Ensure a valid engine is configured
  if (!config.ttsEngine) {
    config.ttsEngine = "kokoro"
  }

  console.log("[voice-plugin] loaded ttsEngine =", config.ttsEngine, "voice =", config.voice)
  log("[voice-plugin] loaded", { ttsEngine: config.ttsEngine, voice: config.voice })

  // --- State ---

  // Audio subsystem
  const capture = new AudioCapture()
  const player = new AudioPlayer()

  // STT subsystem — single persistent engine, model loaded once
  let sttEngine: STTEngine | null = null
  let sttModelBuffer: Uint8Array | null = null
  let sttLoading: Promise<void> | null = null

  /**
   * Ensure the Whisper STT engine is loaded.
   *
   * The model binary is read from disk exactly once and cached.
   * The Whisper native model is loaded lazily on the first transcription
   * and stays alive for the entire plugin session — no reloads.
   */
  async function ensureSTTEngine(): Promise<STTEngine> {
    if (sttEngine) return sttEngine

    // Already loading — await it, then return
    if (sttLoading) {
      await sttLoading
      return sttEngine!
    }

    sttLoading = (async () => {
      try {
        // Lazy-load the STT module (native deps, don't block plugin init)
        const { STTEngine: STTEngineCtor } = await import("./stt.js")

        // Read model binary once (cached in memory for the session)
        if (!sttModelBuffer) {
          const modelPath = resolveModelPath(config.sttModel)
          try {
            sttModelBuffer = new Uint8Array(await fs.promises.readFile(modelPath))
          } catch {
            // Model not present — download it to the project-root models/ dir
            const { downloadWhisperModel } = await import("./stt.js")
            const distDir = path.dirname(new URL(".", import.meta.url).pathname)
            const projectRoot = path.resolve(distDir, "..", "..", "..")
            const downloadPath = await downloadWhisperModel(config.sttModel, projectRoot)
            sttModelBuffer = new Uint8Array(await fs.promises.readFile(downloadPath))
          }
        }

        // Create engine and lazily load the native model
        sttEngine = new STTEngineCtor(sttModelBuffer, config.language)
        await sttEngine.init()
      } catch (err) {
        sttLoading = null
        sttEngine = null
        console.error("[voice-plugin] STT engine init failed:", err)
        throw err
      }
      sttLoading = null
    })()

    await sttLoading
    return sttEngine!
  }

  // -----------------------------------------------------------------------
  // TTS helpers
  // -----------------------------------------------------------------------

  let ttsEngine: ReturnType<typeof import("./tts.js")["createTTSEngine"]> | null = null
  let ttsLoading: Promise<void> | null = null

  async function ensureTTSEngine() {
    if (ttsEngine) return ttsEngine
    if (ttsLoading) {
      await ttsLoading
      return ttsEngine!
    }

    ttsLoading = (async () => {
      const mod = await import("./tts.js")
      ttsEngine = mod.createTTSEngine(config.ttsEngine, config.voice)
      if (ttsEngine instanceof mod.KokoroTTSEngine) {
        await ttsEngine.init()
      }
      console.log("[voice-plugin] TTS engine ready:", config.ttsEngine, "/", config.voice)
    })()

    await ttsLoading
    return ttsEngine!
  }

  /** Speak text using the persistent TTS engine */
  async function speakText(text: string): Promise<{ status: string; message: string }> {
    if (!text || !text.trim()) {
      return { status: "error", message: "Empty text" }
    }

    const engine = await ensureTTSEngine()
    const audio = await engine.generate(text, config.voice)
    if (audio.length === 0) {
      return { status: "error", message: "TTS returned empty audio" }
    }

    await player.play(audio, config.volume)
    return { status: "spoken", message: `🔊 Spoken: "${text.slice(0, 100)}"` }
  }

  // -----------------------------------------------------------------------
  // Voice input (STT)
  // -----------------------------------------------------------------------

  /** Maximum recording duration before force-stopping (ms). Prevents infinite hangs. */
  const MAX_RECORD_MS = 30_000

  /**
   * Run one voice recording session:
   *   start capture → VAD detects speech → silence timeout → transcribe → return text.
   *
   * Resolves with the transcribed string, or null if nothing was captured.
   * Always resolves within MAX_RECORD_MS regardless of VAD state.
   */
  async function runVoiceCapture(): Promise<string | null> {
    // Ensure STT engine is ready (loads Whisper model on first call)
    await ensureSTTEngine()

    const silenceTimeoutMs = config.silenceTimeout * 1000

    let settled = false
    let resolve!: (result: string | null) => void
    const sessionPromise = new Promise<string | null>((r) => { resolve = r })

    // Safety net: if VAD never fires (total silence, mic error, etc.) resolve
    // after MAX_RECORD_MS so the tool call doesn't hang the LLM forever.
    const safetyTimer = setTimeout(async () => {
      if (settled) return
      settled = true
      log("[voice-plugin] safety timeout reached — stopping recording")
      const audio = await capture.stop().catch(() => new Float32Array(0))
      if (audio.length === 0) { resolve(null); return }
      const hasContent = audio.some((v) => Math.abs(v) > 0.001)
      if (!hasContent) { resolve(null); return }
      const result = await sttEngine!.transcribe(audio).catch(() => null)
      resolve(result ? result.text.trim() || null : null)
    }, MAX_RECORD_MS)

    capture.setVADConfig(
      config.vadThreshold,
      async () => {
        if (settled) return
        settled = true
        clearTimeout(safetyTimer)

        const audio = await capture.stop().catch(() => new Float32Array(0))
        if (audio.length === 0) { resolve(null); return }

        const hasContent = audio.some((v) => Math.abs(v) > 0.001)
        if (!hasContent) { resolve(null); return }

        const result = await sttEngine!.transcribe(audio).catch(() => null)
        resolve(result ? result.text.trim() || null : null)
      },
      silenceTimeoutMs,
    )

    // Start recording — VAD will stop it automatically when silence detected
    await capture.start()

    return sessionPromise
  }

  // -----------------------------------------------------------------------
  // SIGUSR1-based voice trigger
  //
  // Why not stdin raw-mode (Ctrl+V)?
  //   OpenCode is a TUI application that owns stdin.  Calling
  //   process.stdin.setRawMode(true) inside a plugin intercepts ALL input,
  //   including keystrokes meant for the TUI — this hangs / corrupts the
  //   terminal.
  //
  // How to trigger from a second terminal:
  //   kill -USR1 $(pgrep -f opencode)
  //
  // Or add a shell alias:
  //   alias voice='kill -USR1 $(pgrep -f opencode)'
  //   then just type: voice
  // -----------------------------------------------------------------------

  function setupSignalTrigger(): void {
    if (!config.hotkeyEnabled) return

    let sessionActive = false

    process.on("SIGUSR1", () => {
      if (sessionActive) {
        log("[voice-plugin] SIGUSR1 received but session already active — ignoring")
        return
      }

      sessionActive = true
      log("[voice-plugin] SIGUSR1 received — starting voice capture")

      runVoiceCapture().then((text) => {
        sessionActive = false
        if (text && text.trim()) {
          log("[voice-plugin] transcribed:", text)
          console.log(`\n📝 Voice: "${text}"\n`)
        } else {
          log("[voice-plugin] no speech detected")
        }
      }).catch((err) => {
        sessionActive = false
        log("[voice-plugin] voice capture error:", err)
        console.error("[voice-plugin] voice capture failed:", err instanceof Error ? err.message : String(err))
      })
    })

    log("[voice-plugin] SIGUSR1 trigger ready — activate with: kill -USR1", process.pid)
    console.log(`[voice-plugin] 🎤 Voice input ready — trigger with: kill -USR1 ${process.pid}`)
  }

  // -----------------------------------------------------------------------
  // TTS tools (LLM-facing)
  // -----------------------------------------------------------------------

  const readAloud = tool({
    description: "Read text aloud using text-to-speech. Use this to speak any message, explanation, or summary to the user. For example: after providing an answer, call voice:read-aloud with your full response so the user can hear it. Also call it when the user asks 'read this' or 'read aloud'.",
    args: {
      text: tool.schema.string().describe("The text to read aloud"),
    },
    execute: async (args: { text: string }) => {
      const result = await speakText(args.text)
      if (result.status === "error") {
        console.error("[voice-plugin] read-aloud failed:", result.message)
      }
      return JSON.stringify(result)
    },
  })

  const speak = tool({
    description: "Speak arbitrary text aloud. Use this when you want the assistant to read a custom message to you.",
    args: {
      text: tool.schema.string().describe("The text to speak aloud"),
    },
    execute: async (args: { text: string }) => {
      const result = await speakText(args.text)
      if (result.status === "error") {
        console.error("[voice-plugin] speak failed:", result.message)
      }
      return JSON.stringify(result)
    },
  })

  const stopTool = tool({
    description: "Stop any currently playing audio immediately.",
    args: {},
    execute: async () => {
      player.stop()
      return JSON.stringify({ status: "stopped", message: "Audio playback stopped." })
    },
  })

  // -----------------------------------------------------------------------
  // voice:record — LLM-callable tool that captures speech and returns text.
  //
  // This is the primary way to do STT inside OpenCode:
  //   1. The user asks "transcribe what I say" or "listen"
  //   2. The LLM calls voice:record
  //   3. The plugin starts recording, VAD auto-stops on silence
  //   4. Transcription is returned to the LLM as text
  // -----------------------------------------------------------------------

  const recordTool = tool({
    description:
      "Record the user's voice and transcribe it to text using local Whisper STT. " +
      "Call this tool whenever the user says: 'listen', 'record', 'I'll speak', " +
      "'transcribe what I say', 'voice input', 'speak my question', or anything similar. " +
      "The microphone opens immediately when this tool is called — tell the user to speak now. " +
      "Recording stops automatically after silence is detected (about 1.5 s of quiet). " +
      "Use the returned text as the user's next message and respond to it.",
    args: {
      prompt: tool.schema.string().optional().describe(
        "Optional context hint to improve transcription accuracy (e.g. 'user is naming a file')",
      ),
    },
    execute: async (_args: { prompt?: string }) => {
      try {
        const text = await runVoiceCapture()
        if (!text || !text.trim()) {
          return JSON.stringify({ status: "no_speech", text: "", message: "No speech detected." })
        }
        return JSON.stringify({ status: "ok", text, message: `Transcribed: "${text}"` })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log("[voice-plugin] voice:record error:", msg)
        return JSON.stringify({ status: "error", text: "", message: msg })
      }
    },
  })

  // -----------------------------------------------------------------------
  // Initialize signal trigger (safe — does not touch stdin)
  // -----------------------------------------------------------------------

  setupSignalTrigger()

  // -----------------------------------------------------------------------
  // Return plugin definition
  // -----------------------------------------------------------------------

  return {
    // Tool definitions
    tool: {
      // LLM-facing tools
      "voice:read-aloud": readAloud,
      "voice:stop": stopTool,
      "voice:summarize": readAloud, // alias
      "voice:record": recordTool,   // STT: record → transcribe → return text

      // User-facing tools
      "voice:speak": speak,
    },
  }
}
