# Voice Plugin Build Plan

A voice interaction plugin for OpenCode that enables speech-to-text input and text-to-speech output with intelligent summarization.

## Table of Contents

- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Module Design](#module-design)
- [Plugin Hooks & Tools](#plugin-hooks--tools)
- [Configuration](#configuration)
- [Implementation Order](#implementation-order)
- [Risk Factors](#risk-factors)
- [Future: Seamless Phase](#future-seamless-phase)

---

## Technology Stack

### Selections

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **STT** | `@napi-rs/whisper` | Native whisper.cpp via Rust/N-API, best Bun compat, Metal GPU on Apple Silicon, real-time segment callbacks |
| **TTS** | `kokoro-js` (local neural) | 50MB model, Apache-2.0, 100% local — audio never leaves the machine |
| **Audio player** | `say` / `afplay` (macOS native) via `child_process` | Zero dependencies, built-in |
| **Mic capture** | `child_process` → `sox`/`ffmpeg` | Reliable local audio capture |
| **Orchestration** | Effect (already a dependency) | Consistent with mem-arch ecosystem |
| **Runtime** | Bun | Existing project runtime, full N-API support |

### Design Principle: 100% Local, Zero Network Calls

Every audio sample, every transcription, every spoken response stays on-device.
No telemetry, no API keys, no external servers. The entire audio pipeline — capture → transcribe → process → synthesize → playback — runs locally with no outbound network requests.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Voice Plugin                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Input Path (STT):                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │
│  │  Mic     │───▶│  Buffer  │───▶│ Whisper  │───▶│ "text"     │
│  │ Capture  │    │  (PCM)   │    │ STT      │    │ prompt     │
│  └──────────┘    └──────────┘    └──────────┘    │             │
│                                                   ▼             │
│                                            ┌──────────┐         │
│                                            │ Opencode │         │
│                                            │ Core     │         │
│                                            └──────────┘         │
│                                                                  │
│  Response Path (TTS):                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  Opencode│───▶│  Summar- │───▶│  Kokoro  │───▶│ Speaker  │  │
│  │  Core    │    │  ize     │    │  TTS     │    │ (afplay) │  │
│  │  (hook)  │    │  (LLM)   │    │  (local) │    │          │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│       │                                                     │    │
│       └── Full text shown in TUI ───────────────────────────┘  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Plugin Hooks:                                                   │
│  • "chat.message"    → intercept assistant output for TTS       │
│  • Tool registration → voice:start, voice:stop, voice:toggle    │
│  • Tool registration → voice:summarize, voice:speak             │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**STT (User speaks → text input):**
1. User triggers `voice:start-recording` tool (or presses a hotkey)
2. `audio.ts` captures mic → raw PCM buffer (16kHz mono, Float32)
3. User triggers `voice:stop-recording` tool
4. `stt.ts` (whisper.cpp via `@napi-rs/whisper`) transcribes → text
5. Text is returned to user as: `🎤 [transcribed text]`
6. User edits and sends as normal message (Phase 1) / injected directly (Phase 2)

**TTS (Assistant responds → audio):**
1. `chat.message` hook intercepts assistant response
2. `summarizer.ts` asks the running LLM to summarize → 50-100 word key points
3. `tts.ts` converts summary to speech (kokoro-js, fully local)
4. `audio.ts` plays audio through system speaker (macOS `say`)
5. Full text is still shown in TUI — user reads details at their pace
6. User can also run `voice:summarize` on-demand for any message

---

## Module Design

### Project Structure

```
whisper/packages/voice/
├── package.json        # @mem-arch/voice, Effect + opencode-ai/plugin deps
├── tsconfig.json
├── src/
│   ├── index.ts        # Plugin entry: config, init, tool/hook registration
│   ├── config.ts       # VoicePluginConfig interface + defaultConfig
│   ├── stt.ts          # Speech-to-text engine (whisper.cpp wrapper)
│   ├── tts.ts          # Text-to-speech engine (kokoro-js local neural)
│   ├── audio.ts        # Mic capture + speaker playback
│   └── summarizer.ts   # LLM-based text summarization for TTS
└── models/             # Whisper model binaries (git-ignored, downloaded at runtime)
    └── .gitignore
```

### `src/config.ts`

```typescript
export interface VoicePluginConfig {
  /** STT model size: tiny (fastest), base, or small (best accuracy) */
  sttModel: "tiny" | "base" | "small";
  /** TTS engine: kokoro (local neural) or say (macOS system voice, fallback) */
  ttsEngine: "kokoro" | "say";
  /** TTS voice identifier */
  voice: string;
  /** Maximum number of words for the TTS summary */
  summarizeLength: number;
  /** STT detection language ("auto" or specific like "en", "zh", "ja") */
  language: string;
  /** Automatically play TTS on assistant responses */
  enableAutoTTS: boolean;
  /** Playback volume (0.0 - 1.0) */
  volume: number;
}

export const defaultConfig: VoicePluginConfig = {
  sttModel: "tiny",
  ttsEngine: "kokoro",
  voice: "af_heart",
  summarizeLength: 100,
  language: "auto",
  enableAutoTTS: true,
  volume: 0.8,
};
```

### `src/stt.ts` — Speech-to-Text Engine

```typescript
import { Whisper, WhisperFullParams, WhisperSamplingStrategy, decodeAudioAsync } from "@napi-rs/whisper";

export interface STTResult {
  text: string;
  confidence: number;
  segments: Array<{ start: number; end: number; text: string }>;
}

export class STTEngine {
  private whisper: Whisper | null = null;
  private modelBuffer: Uint8Array;

  constructor(modelBuffer: Uint8Array) {
    this.modelBuffer = modelBuffer;
  }

  /**
   * Initialize the whisper model (called lazily on first recording).
   * The Whisper binary is loaded once and cached for the session.
   */
  init(): Promise<STTEngine> {
    // Create Whisper instance from GGML model binary
    // Lazy init: load model only when first recording starts
    return this;
  }

  /**
   * Transcribe a raw PCM audio buffer (16kHz, mono, Float32Array).
   * Uses whisper.cpp backend via @napi-rs/whisper.
   */
  async transcribe(audio: Float32Array): Promise<STTResult> {
    // Convert Float32Array → AudioBuffer via decodeAudioAsync
    // Run whisper.full() with Greedy sampling
    // Return text, confidence, and per-segment timestamps
  }

  /**
   * Free model memory when plugin is unloaded.
   */
  dispose(): void {
    this.whisper?.free();
    this.whisper = null;
  }
}
```

**Key considerations:**
- Model is loaded lazily (only when first recording starts) to avoid blocking plugin init
- Whisper model binaries are ~75MB (tiny), ~150MB (base), ~500MB (small) — downloaded once via `npx download-whisper-model`
- `@napi-rs/whisper` provides `decodeAudioAsync()` which handles MP3/WAV/FLAC → raw PCM via Symphonia
- Real-time segment callbacks available via `params.onNewSegment` if we want incremental transcription

### `src/tts.ts` — Text-to-Speech Engine

```typescript
import { KokoroTTS } from "kokoro-js";

export interface TTSEngine {
  generate(text: string, voice?: string): Promise<Uint8Array>;  // Returns WAV bytes
  getVoices(): Promise<string[]>;
  dispose?(): void;
}

// --- Kokoro (local neural, default) ---
export class KokoroTTSEngine implements TTSEngine {
  private kokoro: KokoroTTS | null = null;

  async init(): Promise<KokoroTTSEngine> {
    // Load kokoro-js ONNX model (~50MB from HuggingFace, cached on disk)
    // One-time load; model stays in memory for the session
  }

  async generate(text: string, voice = "af_heart"): Promise<Uint8Array> {
    // kokoro.generate(text, { voice }) → returns raw audio buffer
    // Wrap to WAV container format for macOS `afplay`/`say` compatibility
    // No audio leaves the machine — inference runs entirely via ONNX Runtime WASM
  }

  async getVoices(): Promise<string[]> {
    // Return kokoro-js available voices (16 English voices: af_heart, af_bella, am_adam, etc.)
  }

  dispose(): void {
    // Free WASM memory
  }
}

// --- macOS say (system fallback, zero deps) ---
export class SayTTSEngine implements TTSEngine {
  // `say` plays directly from stdin — it does not produce a file
  // Used as a fallback when kokoro is unavailable
  async generate(text: string, voice?: string): Promise<Uint8Array> {
    // Return empty buffer; audio.ts handles playback via spawn("say", ...) directly
    return new Uint8Array(0);
  }
}
```

**Key considerations:**
- Kokoro voices: 16 English voices (af_heart, af_bella, am_adam, am_michael, af_nicole, af_sarah, etc.)
- No cloud TTS — every byte of audio is generated locally
- The `TTSEngine` interface allows swapping backends via config (kokoro → say fallback)

### `src/audio.ts` — Audio I/O

```typescript
import { spawn } from "node:child_process";
import { Writable } from "node:stream";

export class AudioCapture {
  private proc: ReturnType<typeof spawn> | null = null;
  private chunks: Buffer[] = [];
  private _active = false;

  /**
   * Start recording from system microphone.
   * Uses `rec` (sox) or `ffmpeg` depending on what's available.
   * Output: 16kHz, mono, 16-bit PCM → collected as Buffer.
   */
  async start(): Promise<void> {
    // Detect available tool (sox → ffmpeg → error)
    // Spawn: rec -r 16000 -c 1 -b 16 -e signed-integer -t wav -
    // or:     ffmpeg -f avfoundation -i ":0" -ar 16000 -ac 1 -f s16le -
    // Pipe stdout → chunks buffer
  }

  /**
   * Stop recording and return raw PCM as Float32Array.
   */
  async stop(): Promise<Float32Array> {
    // Kill recording process
    // Merge chunks → Buffer
    // Convert Int16Array → Float32Array (normalize to -1.0..1.0)
    // Return for STT engine
  }

  isActive(): boolean {
    return this._active;
  }

  /**
   * Record a fixed duration and return result.
   * Useful for simple "speak your command" UX.
   */
  async record(durationMs: number): Promise<Float32Array> {
    await this.start();
    await new Promise(r => setTimeout(r, durationMs));
    return this.stop();
  }
}

export class AudioPlayer {
  private current: ReturnType<typeof spawn> | null = null;

  /**
   * Play audio bytes (WAV format) through system speaker.
   * On macOS: uses `say` or `afplay`.
   * Cross-platform: detects available player.
   */
  async play(audio: Uint8Array): Promise<void> {
    // If kokoro generated WAV: write to temp file, afplay it
    // If say engine: write to temp file, `say -f` it
    // Cancel any ongoing playback
  }

  stop(): void {
    this.current?.kill();
    this.current = null;
  }
}
```

**Key considerations:**
- Mic capture depends on having `sox` (`brew install sox`) or `ffmpeg` (`brew install ffmpeg`)
- On macOS, `rec` (from sox) is the simplest approach: `rec -r 16000 -c 1 -b 16 -t wav -`
- On macOS, `afplay` or `say` plays audio files
- Cross-platform fallback: detect available tools at runtime
- Auto-install helper could be added to suggest `brew install sox ffmpeg`

### `src/summarizer.ts` — Text Summarization

```typescript
import type { PluginInput } from "@opencode-ai/plugin";

export class Summarizer {
  private ctx: PluginInput;
  private maxLength: number;

  constructor(ctx: PluginInput, maxLength: number) {
    this.ctx = ctx;
    this.maxLength = maxLength;
  }

  /**
   * Summarize long text into key points suitable for speech.
   * Sends a prompt to the running LLM via the plugin context.
   */
  async summarize(text: string): Promise<string> {
    // Use the LLM to summarize:
    // Prompt: "Summarize this text into 50-100 words of key points.
    //         Make it sound natural when read aloud.
    //         Do not use bullet points. Format as a short paragraph."
    // Return summary
  }

  /**
   * Fallback: extract the first N paragraphs when LLM is unavailable.
   */
  extractKeyParagraphs(text: string, count: number = 3): string {
    // Split by blank lines
    // Return first `count` paragraphs
    // Strip markdown formatting for clean speech output
  }

  /**
   * Truncate text to max tokens/characters without breaking sentences.
   */
  truncateToLength(text: string, maxWords: number): string {
    // Split by words, take first N, ensure we end at a sentence boundary
  }
}
```

**Key considerations:**
- The summarization step is critical: without it, TTS would read entire multi-paragraph responses
- Uses the *existing* LLM that's already running in the OpenCode session (via `ctx`)
- If LLM call fails, falls back to simple first-paragraph extraction
- Summary is always shorter (50-100 words) than the full response (500-3000 words)
- The `summarizeLength` config controls the target word count

### `src/index.ts` — Plugin Entry Point

```typescript
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { defaultConfig, type VoicePluginConfig } from "./config.js";
import { STTEngine } from "./stt.js";
import { TTSEngine, KokoroTTSEngine, SayTTSEngine } from "./tts.js";
import { AudioCapture, AudioPlayer } from "./audio.js";
import { Summarizer } from "./summarizer.js";

export const VoicePlugin: Plugin = async (ctx: PluginInput) => {
  // --- Config ---
  const config: VoicePluginConfig = { ...defaultConfig, ...ctx.config };

  // --- State ---
  let recording = false;
  let capture = new AudioCapture();
  let player = new AudioPlayer();
  let stt: STTEngine | null = null;
  let tts: TTSEngine | null = null;
  let summarizer = new Summarizer(ctx, config.summarizeLength);
  let autoTTS = config.enableAutoTTS;

  // --- Lazy init helpers ---
  async function ensureSTT(): Promise<STTEngine> {
    if (!stt) {
      // Load whisper model binary (download if missing)
      const modelPath = path.join(ctx.directory, "models", `${config.sttModel}.bin`);
      const modelBuffer = await fs.promises.readFile(modelPath);
      stt = new STTEngine(modelBuffer);
    }
    return stt;
  }

  async function ensureTTS(): Promise<TTSEngine> {
    if (!tts) {
      if (config.ttsEngine === "say") {
        tts = new SayTTSEngine();
      } else {
        // Default: kokoro (local neural)
        tts = new KokoroTTSEngine();
        await tts.init();
      }
    }
    return tts;
  }

  // --- Tool: start recording ---
  const startRecording = tool({
    description: "Start voice recording. Speak your message clearly.",
    args: {},
    execute: async () => {
      await capture.start();
      return JSON.stringify({ status: "recording", message: "🎤 Recording... speak now" });
    },
  });

  // --- Tool: stop recording ---
  const stopRecording = tool({
    description: "Stop recording and transcribe speech to text.",
    args: {},
    execute: async (_args, _toolCtx) => {
      const audio = await capture.stop();
      const engine = await ensureSTT();
      const result = await engine.transcribe(audio);
      return JSON.stringify({
        status: "transcribed",
        text: result.text,
        confidence: result.confidence,
        message: `🎤 Transcribed: "${result.text}"`,
      });
    },
  });

  // --- Tool: toggle auto TTS ---
  const toggleTTS = tool({
    description: "Toggle automatic text-to-speech on assistant responses.",
    args: {},
    execute: async () => {
      autoTTS = !autoTTS;
      return JSON.stringify({ status: "tts_toggle", enabled: autoTTS });
    },
  });

  // --- Tool: summarize and speak ---
  const summarizeAndSpeak = tool({
    description: "Summarize the last assistant message and speak the key points.",
    args: {
      message_index: tool.schema.number().describe("Which message to summarize (0 = latest)").default(0).optional(),
    },
    execute: async (args) => {
      const text = /* retrieve last assistant message from ctx */ "";
      const summary = await summarizer.summarize(text);
      const engine = await ensureTTS();
      const audio = await engine.generate(summary, config.voice);
      await player.play(audio);
      return JSON.stringify({
        status: "spoken",
        summary,
        message: `🔊 Speaking: "${summary}"`,
      });
    },
  });

  // --- Tool: speak arbitrary text ---
  const speak = tool({
    description: "Speak arbitrary text aloud (not tied to a conversation message).",
    args: {
      text: tool.schema.string().describe("The text to speak aloud"),
    },
    execute: async (args) => {
      const engine = await ensureTTS();
      const audio = await engine.generate(args.text, config.voice);
      await player.play(audio);
      return JSON.stringify({ status: "spoken", message: `🔊 Speaking: "${args.text}"` });
    },
  });

  // --- Hook: intercept assistant messages for auto TTS ---
  const chatMessageHook = async (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: { role: string }; parts: unknown[] },
  ): Promise<void> => {
    if (!autoTTS) return;
    if (output.message.role !== "assistant") return;

    // Extract text from parts
    const text = output.parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");

    if (!text) return;

    try {
      // Summarize for speech
      const summary = await summarizer.summarize(text);

      // TTS
      const engine = await ensureTTS();
      const audio = await engine.generate(summary, config.voice);

      // Play
      await player.play(audio);
    } catch (err) {
      // Silently fail — TTS should never break the main conversation
      console.error("[voice-plugin] TTS failed:", err);
    }
  };

  // --- Cleanup on plugin unload ---
  // (Effect framework handles cleanup; we store disposers)

  // --- Return plugin ---
  return {
    // Tools
    "voice:start-recording": startRecording,
    "voice:stop-recording": stopRecording,
    "voice:toggle": toggleTTS,
    "voice:summarize": summarizeAndSpeak,
    "voice:speak": speak,

    // Hooks
    "chat.message": chatMessageHook,
  };
};

export type { VoicePluginConfig } from "./config.js";
```

---

## Plugin Hooks & Tools

### Tools

| Tool | Description | Args | Returns |
|------|-------------|------|---------|
| `voice:start-recording` | Start voice recording | — | `🎤 Recording... speak now` |
| `voice:stop-recording` | Stop and transcribe | — | Transcribed text + confidence |
| `voice:toggle` | Toggle auto TTS on/off | — | `enabled: true/false` |
| `voice:summarize` | Summarize & speak last response | `message_index?` (number) | Summary text + playback status |
| `voice:speak` | Speak arbitrary text | `text` (string) | Playback status |

### Hooks

| Hook | Input Type | Output Type | Behavior |
|------|-----------|-------------|----------|
| `chat.message` | `{ sessionID, agent, model, message }` | `{ role, parts }` | If assistant message + autoTTS → summarize → TTS → play |

---

## Configuration

### In opencode `config.json`

```json
{
  "plugin": [
    ["@mem-arch/voice", {
      "sttModel": "tiny",
      "ttsEngine": "kokoro",
      "voice": "af_heart",
      "summarizeLength": 100,
      "language": "auto",
      "enableAutoTTS": true,
      "volume": 0.8
    }]
  ]
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sttModel` | `"tiny"` \| `"base"` \| `"small"` | `"tiny"` | Whisper model size. `tiny`: ~75MB, fast. `small`: ~500MB, best accuracy. |
| `ttsEngine` | `"kokoro"` \| `"say"` | `"kokoro"` | TTS backend. Kokoro = local neural. Say = macOS system voice (fallback). |
| `voice` | string | `"af_heart"` | Voice identifier. Kokoro: `af_heart`, `af_bella`, `am_adam`, etc. Say: macOS voice name (`Samantha`, `Moira`, etc.). |
| `summarizeLength` | number | `100` | Max words in TTS summary. Shorter = faster speech. |
| `language` | string | `"auto"` | STT language. Use `"en"`, `"zh"`, `"ja"` for specific languages. |
| `enableAutoTTS` | boolean | `true` | Auto-play TTS on every assistant response. |
| `volume` | number | `0.8` | Playback volume. Range: 0.0–1.0. |

---

## Implementation Order

### Priority 1: TTS Pipeline (Highest Value, Simplest)

The TTS pipeline delivers immediate value — users can hear key points of any response.

1. **`src/config.ts`** — ✅ Already created
2. **`src/tts.ts`** — Kokoro wrapper + TTSEngine interface
   - `kokoro-js` initialization
   - `generate(text, voice)` → WAV bytes
   - `getVoices()` → list available voices
   - SayTTSEngine fallback (macOS system voice, zero deps)
3. **`src/audio.ts`** (playback half) — `AudioPlayer` class
   - `play(wavBytes)` → write to temp file, `afplay`/`say` it
   - `stop()` → kill playback process
4. **`src/summarizer.ts`** — Text summarization
   - `summarize(text)` → prompt LLM for key points
   - `extractKeyParagraphs(text)` → fallback
5. **`src/index.ts`** — Plugin entry (TTS tools + hook)
   - Register `voice:toggle`, `voice:summarize`, `voice:speak` tools
   - Register `chat.message` hook for auto TTS
   - Wire up config, TTS engine, summarizer, player

**Milestone**: Users can run `voice:speak "hello world"` or get auto TTS on assistant responses. Full text still in TUI.

### Priority 2: STT Pipeline

Add voice input capability.

1. **`src/stt.ts`** — Whisper wrapper
   - `@napi-rs/whisper` initialization (lazy load)
   - `transcribe(Float32Array)` → text + confidence
   - Model download helper
2. **`src/audio.ts`** (capture half) — `AudioCapture` class
   - `start()` → spawn `rec` or `ffmpeg` process
   - `stop()` → return raw PCM buffer
   - `record(durationMs)` → convenience method
3. **`src/index.ts`** — STT tools
   - Register `voice:start-recording`, `voice:stop-recording` tools
   - Wire up STT engine

**Milestone**: Users can speak prompts directly via microphone.

### Priority 3: Polish & UX

1. **Model download automation** — auto-download whisper model on first use if missing
2. **Dependency detection** — check for `sox`/`ffmpeg`/`say` at startup, suggest installation
3. **TTS per-message toggle** — user can opt in/out per response
4. **Voice indicator in TUI** — show recording state, TTS playing state
5. **Config validation** — validate config on plugin load, warn on bad values
6. **Graceful degradation** — if kokoro fails → say, in that order
7. **Streaming audio** — if kokoro supports streaming, play audio as it generates (lower latency)

---

## Risk Factors

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `@napi-rs/whisper` Bun compat issues | STT broken | Low–Medium | Provide clear install instructions; test on target platforms; use prebuilt binaries |
| Kokoro WASM memory pressure in Bun | TTS crashes | Low | Kokoro ~200MB WASM + ~50MB model — acceptable on modern machines; show memory warning if low |
| Mic capture needs `sox`/`ffmpeg` | Setup friction | Medium | Provide `voice:setup` tool that detects + suggests `brew install` |
| LLM summarization adds latency | Slow TTS | Medium | Async/background summarization; show "🔊 speaking..." status; cache summaries |
| `say` voice quality varies by macOS | Poor TTS UX | Low | Kokoro is the default; `say` is only a fallback |
| Whisper model download slow (first use) | First-run delay | Medium | Pre-bundle tiny model; show progress bar; cache model in project dir |
| Kokoro initial load time | First TTS call slow | Low | Pre-load kokoro on plugin init; cache model on disk; warm up on first use |

---

## Future: Seamless Phase

The tool-based Phase 1 requires the user to explicitly run `voice:start-recording` → `voice:stop-recording` → edit → send. For a more seamless experience, Phase 2 would add two hooks to the opencode core:

```typescript
// Proposed hooks for opencode core:

/** Inject transcribed text directly as user input */
"voice.input": (rawText: string) => void;

/** Play audio in the TUI (native speaker output) */
"voice.play": (audioData: Uint8Array) => void;
```

With these hooks:
- **STT**: Recording ends → text is injected directly as the next user message (no copy/paste)
- **TTS**: Audio plays through TUI's audio system (not just `say` in background)
- **UX**: A small microphone button and audio wave indicator in the TUI prompt bar
- **Hotkey support**: `Cmd+Space` or custom keybinding to trigger recording

This would require changes to the opencode core (or a separate `@mem-arch/voice-tui` package that patches the TUI), but would make voice feel like a first-class feature rather than a tool-based workaround.

---

## Build Instructions

### Prerequisites

```bash
# Audio capture tools (one of these):
brew install sox        # provides `rec` command
# OR
brew install ffmpeg     # provides `ffmpeg` command

# For kokoro TTS — models auto-download from HuggingFace
# For whisper STT — download model:
npx download-whisper-model tiny  # or base, small
```

### Install & Build

```bash
cd whisper
bun install              # installs @mem-arch/voice + dependencies
cd packages/voice
bun run build            # compiles TypeScript
```

### Register Plugin

Add to your opencode config (`~/.opencode/config.json` or `<project>/.opencode/config.json`):

```json
{
  "plugin": [
    ["@mem-arch/voice", {
      "sttModel": "tiny",
      "ttsEngine": "kokoro",
      "voice": "af_heart",
      "summarizeLength": 100,
      "enableAutoTTS": true
    }]
  ]
}
```

---

## Dependencies Summary

### Required (runtime, all local)
| Package | Purpose | Size |
|---------|---------|------|
| `@opencode-ai/plugin` | Plugin framework | — |
| `effect` | Orchestration | ~200KB |
| `@napi-rs/whisper` | STT (whisper.cpp native) | ~5MB native binary |
| `kokoro-js` | TTS (local neural) | ~50MB model + ~200MB ONNX deps |

### Optional (system tools)
| Tool | Purpose | Install |
|------|---------|---------|
| `sox` (`rec`) | Mic capture | `brew install sox` |
| `ffmpeg` | Audio conversion | `brew install ffmpeg` |
| `say` / `afplay` | Audio playback | macOS built-in |

### Network Requirements
| Source | Purpose | When |
|--------|---------|------|
| HuggingFace Hub | Download kokoro model weights | First use only, cached on disk |
| HuggingFace Hub | Download whisper GGML model | First use only, cached on disk |

**After the one-time model downloads, the plugin operates completely offline.** No API keys, no telemetry, no outbound requests during normal use.
