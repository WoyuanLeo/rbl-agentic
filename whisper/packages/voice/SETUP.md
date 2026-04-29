# Voice Plugin Setup Guide

Install the system tools and register the plugin in OpenCode. This takes about 5 minutes.

---

## What this plugin does

The voice plugin gives OpenCode **two capabilities**:

| Direction | How it works | Engine |
|-----------|-------------|--------|
| **TTS** — text to speech | The LLM calls `voice:read-aloud` to speak any text, or auto-TTS summarizes & speaks assistant responses | kokoro (local neural), Edge (free cloud), or say (macOS system) |
| **STT** — speech to text | Press **Ctrl+V** in the terminal, speak, pause 1.5s → Whisper transcribes to text | @napi-rs/whisper (whisper.cpp, fully local) |

The primary design is **LLM-driven**: the LLM explicitly calls `voice:read-aloud` after providing an answer. Auto-TTS is **off by default** but can be toggled on/off or enabled via config.

Voice input is **always triggered by the user** via the hotkey — the LLM never controls recording.

---

## Step 1 — Install system audio tools

You need **at least one** of these for microphone recording (STT):

| Tool | Command | What it provides |
|------|---------|------------------|
| **sox** (recommended) | `brew install sox` | `rec` command — simple, reliable |
| **ffmpeg** (alternative) | `brew install ffmpeg` | `ffmpeg` command — works if sox isn't available |

```bash
# Install both so you always have a fallback
brew install sox ffmpeg
```

> **macOS note:** Audio playback (`afplay`, `say`) is built into macOS — no install needed.

---

## Step 2 — Register the plugin in OpenCode

Add the voice plugin to your OpenCode config. For a **local development path**, use the `file://` prefix:

```
~/.opencode/config.json              (global)
<project>/.opencode/config.json      (project-scoped)
```

```jsonc
{
  "plugin": [
    ["file:///Users/tianzh/IdeaProjects/rbl-agentic/whisper/packages/voice", {
      "ttsEngine": "say",
      "enableAutoTTS": false
    }]
  ]
}
```

### Quick-start vs full-quality configs

**Quick start** — `"say"` engine needs zero extra installs. Use this to verify the plugin loads and works:

```jsonc
{
  "plugin": [
    ["file:///Users/tianzh/IdeaProjects/rbl-agentic/whisper/packages/voice", {
      "ttsEngine": "say",
      "enableAutoTTS": false
    }]
  ]
}
```

**Full quality** — switch to `"kokoro"` for natural-sounding neural TTS. Kokoro will auto-download its ~50 MB model on first use:

```jsonc
{
  "plugin": [
    ["file:///Users/tianzh/IdeaProjects/rbl-agentic/whisper/packages/voice", {
      "ttsEngine": "kokoro",
      "voice": "af_heart",
      "summarizeLength": 100,
      "enableAutoTTS": false
    }]
  ]
}
```

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sttModel` | `"tiny"` \| `"base"` \| `"small"` | `"base"` | Whisper model size. `base` = ~150 MB, good for conversation. `small` = ~500 MB, best accuracy. |
| `ttsEngine` | `"kokoro"` \| `"edge"` \| `"say"` | `"kokoro"` | TTS backend (see below). |
| `voice` | string | `"af_heart"` | Voice identifier (varies by engine, see tables below). |
| `summarizeLength` | number | `100` | Max words in TTS summary. Shorter = faster speech. |
| `language` | string | `"auto"` | STT language. Use `"en"`, `"zh"`, `"ja"`, or `"auto"` to detect. |
| `enableAutoTTS` | boolean | `false` | Auto-speak assistant responses. **Off by default** — primary path is LLM calling `voice:read-aloud`. |
| `volume` | number | `0.8` | Playback volume. Range: 0.0–1.0. |
| `hotkeyEnabled` | boolean | `true` | Enable keyboard-to-voice hotkey. Set `false` to disable. |
| `hotkey` | string | `"Ctrl+V"` | The hotkey to trigger voice recording. |
| `silenceTimeout` | number | `1.5` | Seconds of silence before recording auto-stops. Range: 0.5–3.0. |
| `vadThreshold` | number | `0.03` | Amplitude threshold for speech detection. Range: 0.01–0.1. |

### TTS engine comparison

| Engine | Quality | Network? | API key? | Use case |
|--------|---------|----------|----------|----------|
| **kokoro** | Neural, natural-sounding | One-time download (~50 MB model) | No | **Recommended default** — fully local |
| **edge** | Very good (Microsoft neural voices) | Required every call | No | Good cloud alternative; supports 15+ languages |
| **say** | Robotic, system voices | No | No | Testing & zero-dependency fallback |

### Kokoro voices (15 total)

| Voice ID | Gender | Notes |
|----------|--------|-------|
| `af_heart` | Female | Warm, expressive — recommended default |
| `af_bella` | Female | Energetic, younger |
| `am_adam` | Male | Deep, authoritative |
| `am_michael` | Male | Clear, professional |
| `af_nicole` | Female | Calm, soothing |
| `af_sarah` | Female | Natural, conversational |
| `af_alloy` | Female | Smooth, radio-quality |
| `af_aoede` | Female | Rich, articulate |
| `am_puck` | Male | Light, friendly |
| `bf_alice` | Female | Soft, gentle |
| `bf_emma` | Female | Mature, composed |
| `bm_fenrir` | Male | Dark, dramatic |
| `bf_santa` | Female | Festive, cheerful |
| `af_cori` | Female | Professional, clear |

### Edge TTS voices (common subset)

Edge TTS supports several hundred voices. Here are the most useful:

| Voice ID | Language |
|----------|----------|
| `en-US-AvaMultilingualNeural` | English (US, Female) |
| `en-US-AndrewMultilingualNeural` | English (US, Male) |
| `en-US-EmmaMultilingualNeural` | English (US, Female) |
| `en-US-BrianMultilingualNeural` | English (US, Male) |
| `en-GB-SoniaMultilingualNeural` | English (UK, Female) |
| `en-GB-RyanMultilingualNeural` | English (UK, Male) |
| `en-US-JennyNeural` | English (US, Female) |
| `zh-CN-XiaoxiaoNeural` | Chinese (Simplified) |
| `zh-CN-YunxiNeural` | Chinese (Simplified, Male) |
| `ja-JP-NanamiNeural` | Japanese |
| `ja-JP-KeitaNeural` | Japanese (Male) |
| `ko-KR-HyunsuMultilingualNeural` | Korean |
| `fr-FR-HenriNeural` | French |
| `fr-FR-EloiseNeural` | French (Female) |
| `de-DE-KatjaNeural` | German |

### Say voices (macOS system voices)

Query available voices: `say -v ?`

Common ones: `Samantha`, `Moira`, `Tessa`, `Alex`, `Daniel`, `Freddy`, `Google US English`, etc.

### Local vs npm installation

| Method | Config syntax | When to use |
|--------|--------------|-------------|
| **Local dev** | `file:///absolute/path/to/voice` | During development, before publishing |
| **Published npm** | `@mem-arch/voice` | After publishing to npm registry |

---

## Step 3 — Download the STT model

The Whisper speech-to-text model downloads **automatically on first use** — you don't need to do anything. The first time you press the voice hotkey (Ctrl+V), the plugin will:

1. Detect the model is missing
2. Download from HuggingFace
3. Cache it in `models/ggml-{variant}.bin`
4. Begin transcribing

Model files are cached and reused across sessions. The default model is **`base`** (~150 MB) — a good balance of speed and accuracy for natural conversation.

Available variants:

| Variant | Size | Speed | Accuracy |
|---------|------|-------|----------|
| `tiny` | ~75 MB | Fastest | Basic — miss words, garbled names |
| `base` | ~150 MB | Fast | **Recommended** — good for conversation |
| `small` | ~500 MB | Moderate | Best accuracy |

Pick a different variant in config if you need different trade-offs:

```jsonc
{ "sttModel": "base" }
```

---

## Step 4 — Restart OpenCode

```bash
opencode
```

Check the console for plugin loading output. You should see:

```
[voice-plugin] loaded ttsEngine = say voice = af_heart autoTTS = false
```

---

## Step 5 — Verify everything works

### Quick smoke test (works with `"say"` TTS — zero installs needed)

```
voice:speak "hello world"
```

If you hear audio from your speaker, the plugin is installed and working.

### Test the primary LLM-facing tool

Ask the LLM to speak something:

```
Please answer my question and then call voice:read-aloud to read your answer out loud.

What is 2 + 2?
```

The LLM should respond and then call `voice:read-aloud` with its answer.

### Toggle auto-TTS

```
voice:toggle        → disabled
voice:toggle        → enabled
```

When auto-TTS is **on**, every assistant response is summarized and read aloud. When **off**, the LLM must explicitly call `voice:read-aloud` to speak anything.

### Convenience tools

```
voice:mute          → disable auto-TTS
voice:unmute        → enable auto-TTS
voice:stop          → stop currently playing audio
```

### Voice input test (requires sox/ffmpeg + mic)

```
1. Press Ctrl+V in the terminal (while OpenCode is focused)
   → 🎤 Listening... (speak now)
2. Speak a sentence clearly
3. Pause for 1.5 seconds
   → 📝 Transcribed: "your text here"
```

If the transcription returns your spoken words, the STT pipeline (VAD + Whisper) is working.

---

## Switching to full quality

After confirming `"say"` works, update your config:

```jsonc
{
  "plugin": [
    ["file:///Users/tianzh/IdeaProjects/rbl-agentic/whisper/packages/voice", {
      "ttsEngine": "kokoro",
      "sttModel": "base",
      "voice": "af_heart",
      "summarizeLength": 100,
      "enableAutoTTS": false
    }]
  ]
}
```

Then restart OpenCode. Kokoro will download its model (~50 MB) on first use.

---

## Troubleshooting

### No audio output

| Symptom | Check | Fix |
|---------|-------|-----|
| Silence when speaking | `afplay -v 0.5 /System/Library/Sounds/Ping.aiff` | Test macOS audio. If silent, check System Settings > Sound > Output |
| Low volume | `volume` config | Increase `volume` to `1.0` |
| No available player | OpenCode console logs | Install `sox` and `ffmpeg` (`brew install sox ffmpeg`) |

### Microphone not detected

| Symptom | Check | Fix |
|---------|-------|-----|
| `command not found: rec` | Run `which rec` | Install sox: `brew install sox` |
| `command not found: ffmpeg` | Run `which ffmpeg` | Install ffmpeg: `brew install ffmpeg` |
| Audio permission denied | System Settings > Privacy > Microphone | Allow Terminal/iTerm in Privacy settings |

### Voice hotkey doesn't work

| Symptom | Check | Fix |
|---------|-------|-----|
| Nothing happens on Ctrl+V | Is stdin a TTY? (interactive terminal) | Only works in interactive terminal, not piped/headless |
| Hotkey is disabled | `hotkeyEnabled` config | Set to `true` |
| Wrong key detected | `hotkey` config | Verify format: `"Ctrl+V"` (Ctrl + letter) |

### Whisper model download fails

| Symptom | Check | Fix |
|---------|-------|-----|
| Network timeout | HuggingFace may be slow | Try again, or download manually from https://huggingface.co/ggerganov/whisper.cpp/tree/main |
| Disk full | Check available space | `base` needs ~200 MB, `small` needs ~1 GB |

### Edge TTS fails

| Symptom | Check | Fix |
|---------|-------|-----|
| Network error | Edge TTS requires internet | Ensure you have an active connection |
| Rate limited | Too many rapid calls | Add delays between calls |

### TTS quality is poor

| TTS Engine | Expected quality | Recommendation |
|------------|-----------------|----------------|
| `kokoro` | Neural, natural-sounding | Best quality, fully local — use as default |
| `edge` | Very good (Microsoft voices) | Good alternative if kokoro fails |
| `say` | Robotic, system voices | Fallback only — use for testing, not production |

---

## All registered tools

| Tool | Who calls it | Description |
|------|-------------|-------------|
| `voice:read-aloud` | **LLM** | Speak any text aloud. The LLM should call this after answering. |
| `voice:summarize` | **LLM** | Alias for `voice:read-aloud`. |
| `voice:speak` | **User** | Speak arbitrary text (not tied to a message). |
| `voice:toggle` | **User** | Toggle auto-TTS on/off. |
| `voice:mute` | **User** | Explicitly disable auto-TTS. |
| `voice:unmute` | **User** | Explicitly enable auto-TTS. |
| `voice:stop` | **User** | Stop currently playing audio immediately. |

**Voice input** is triggered by the **Ctrl+V** hotkey (press in terminal, speak, pause 1.5s for auto-transcription). No tool call needed.

---

## Privacy

The voice plugin is **100% local** after model downloads:

- **kokoro**: One-time ~50 MB download, then fully offline. No audio ever leaves your machine.
- **whisper (STT)**: One-time model download (~150–500 MB), then fully offline.
- **Edge TTS**: Requires internet on every call. Use `kokoro` or `say` for fully offline operation.
- **say**: Zero dependencies, zero network, macOS only.
- **Hotkey**: Only active when the terminal is in the foreground. No background listening.

No API keys, no telemetry, no analytics. Audio processing happens entirely on-device.
