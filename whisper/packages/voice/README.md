# @mem-arch/voice

Voice plugin for OpenCode — speech-to-text, text-to-speech, and audio playback.

**100% local. No API keys. No network calls.**

---

## Quick Start

1. **Install audio tools**: `brew install sox ffmpeg`
2. **Register the plugin** in your OpenCode `config.json` — see [SETUP.md](./SETUP.md) for the full config
3. **Restart OpenCode** and try `voice:speak "hello world"` to verify TTS works
4. **Press Ctrl+V** to record voice input — VAD auto-stops after 1.5s silence

Read the full [Setup Guide](./SETUP.md) for config options, model download, and troubleshooting.

---

## Features

- **STT** — Whisper.cpp transcribes speech to text via `Ctrl+V` hotkey (local, no cloud)
- **TTS** — Kokoro neural text-to-speech reads responses aloud
- **Auto-TTS** — Every assistant response is summarized and spoken automatically
- **Multilingual** — Automatic language detection, or pin to English, Chinese, Japanese, etc.
- **Fallback chain** — Kokoro → Edge TTS → macOS `say`, gracefully degrades

## Tools

| Tool | Description |
|------|-------------|
| `voice:speak` | Speak arbitrary text aloud |
| `voice:read-aloud` | Read any text aloud (LLM-facing) |
| `voice:toggle` | Toggle automatic TTS on/off |
| `voice:summarize` | Summarize and speak the last response |
| `voice:mute` | Disable auto-TTS |
| `voice:unmute` | Enable auto-TTS |
| `voice:stop` | Stop currently playing audio |

Voice input uses the **Ctrl+V** hotkey — press it in the terminal to start recording, speak, then pause 1.5s for auto-transcription. No tools needed.

## Links

- [Setup Guide](./SETUP.md) — installation, configuration, troubleshooting
- [Build Plan](../../BUILD_PLAN.md) — architecture and design decisions
