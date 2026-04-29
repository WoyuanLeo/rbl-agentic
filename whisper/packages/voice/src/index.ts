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
  // Voice input (STT via hotkey)
  // -----------------------------------------------------------------------

  /**
   * Run a voice recording session: start capture → VAD listens → silence → transcribe.
   * Shows status to stderr so the user knows what's happening.
   */
  async function runVoiceCapture(): Promise<string | null> {
    // Ensure STT engine is ready (loads model if needed)
    await ensureSTTEngine()

    // Configure VAD: trigger onSpeechEnd after silenceTimeout of silence
    const silenceTimeoutMs = config.silenceTimeout * 1000
    let resolve!: (result: string | null) => void
    const sessionPromise = new Promise<string | null>((r) => { resolve = r })

    capture.setVADConfig(
      config.vadThreshold,
      async () => {
        // VAD fired — recording is done (VAD called capture.stop() internally)
        const audio = await capture.stop()
        if (audio.length === 0) {
          resolve(null)
          return
        }

        // Check if buffer is just silence (safety net)
        const hasContent = audio.some((v) => Math.abs(v) > 0.001)
        if (!hasContent) {
          resolve(null)
          return
        }

        // Transcribe
        const result = await sttEngine!.transcribe(audio)
        resolve(result.text.trim() || null)
      },
      silenceTimeoutMs,
    )

    // Start recording — VAD will stop it automatically when silence detected
    await capture.start()

    return sessionPromise
  }

  /**
  * Setup the hotkey listener.
    *
    * Ctrl+V (byte 0x14) starts a voice capture session. The session runs
    * independently of stdin — VAD auto-stops the recording after silence.
    *
    * This only works when stdin is a TTY (interactive terminal).
    * In headless/piped mode, voice input via hotkey is disabled.
    */
  function setupHotkey(): void {
    if (!config.hotkeyEnabled) return
    if (!process.stdin.isTTY) {
      // Not interactive — hotkey requires a real terminal
      return
    }

    // Parse the hotkey config to get the target byte
    const hotkeyByte = parseHotkey(config.hotkey)
    if (hotkeyByte === null) return

    // Enable raw mode
    process.stdin.setRawMode(true)
    process.stdin.resume()

    let sessionActive = false

    process.stdin.on("data", (raw: Buffer) => {
      for (const byte of raw) {
        if (byte === hotkeyByte && !sessionActive) {
          sessionActive = true

          // Show status and start the session
          process.stderr.write(`\r🎤 Listening... (speak now)  \n`)

          runVoiceCapture().then((text) => {
            sessionActive = false

            if (text && text.trim()) {
              // Successful transcription
              process.stderr.write(`\r📝 Transcribed: "${text}"\n\n`)
            } else {
              // No speech detected (or silence)
              process.stderr.write(`\r⏹ No speech detected.\n\n`)
            }
          }).catch((err) => {
            sessionActive = false
            process.stderr.write(`\r❌ Voice capture failed: ${err instanceof Error ? err.message : String(err)}\n\n`)
            log("[voice-plugin] voice capture error:", err)
          })

          break
        }
      }
    })
  }

  /**
   * Parse a hotkey string like "Ctrl+V" into the target byte.
   * Supports: Ctrl+<letter>, Ctrl+<number>, Esc, and common combos.
   */
  function parseHotkey(hotkey: string): number | null {
    const match = hotkey.match(/^Ctrl\+([A-Z0-9])$/i)
    if (!match) return null

    const char = match[1].toUpperCase()
    // Ctrl+X = ASCII code for X minus 64 (e.g., Ctrl+V = 0x16 - 0x40 = 0x14)
    return char.charCodeAt(0) - 64
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
  // Initialize hotkey (runs after tool registration)
  // -----------------------------------------------------------------------

  setupHotkey()

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

      // User-facing tools
      "voice:speak": speak,
    },
  }
}
