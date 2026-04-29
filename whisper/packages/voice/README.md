# @mem-arch/voice

Voice plugin for OpenCode — speech-to-text, text-to-speech, and audio playback.

**100% local. No API keys. No network calls.**

---

## Quick Start

1. **Install audio tools**: `brew install sox ffmpeg`
2. **Register the plugin** in your OpenCode `config.json` — see [SETUP.md](./SETUP.md) for the full config
3. **Restart OpenCode** and try `voice:speak "hello world"` to verify TTS works
4. **Trigger STT** using one of the two methods below

---

## Voice Input (STT) — How to Activate

> **Why not Ctrl+V?**  OpenCode is a TUI application that owns `stdin`.
> A plugin calling `setRawMode(true)` intercepts *all* keystrokes — including
> OpenCode's own — which hangs the terminal.  Two safe alternatives exist:

### Method 1 — `voice:record` tool (simplest)

Just tell the assistant to listen:

```
"transcribe what I say"
"record my voice"
"listen"
```

The LLM calls `voice:record`, recording starts immediately, and VAD
auto-stops after 1.5 s of silence.  The transcribed text is returned to
the conversation.

### Method 2 — SIGUSR1 signal (hands-free, from a second terminal)

When OpenCode starts the plugin prints its PID:

```
[voice-plugin] 🎤 Voice input ready — trigger with: kill -USR1 <pid>
```

Add a shell alias so you can trigger it with one word:

```zsh
# ~/.zshrc
alias voice='kill -USR1 $(pgrep -f opencode)'
```

Then open a second terminal and run:

```
voice
```

Recording starts, VAD auto-stops on silence, and the transcription appears
in the OpenCode conversation.

---

## Features

- **STT** — Whisper.cpp transcribes speech to text (local, no cloud)
- **TTS** — Kokoro neural text-to-speech reads responses aloud
- **Auto-TTS** — Every assistant response is summarized and spoken automatically
- **Multilingual** — Automatic language detection, or pin to English, Chinese, Japanese, etc.
- **Fallback chain** — Kokoro → Edge TTS → macOS `say`, gracefully degrades

## Tools

| Tool | Description |
|------|-------------|
| `voice:record` | Record voice → transcribe → return text to the LLM |
| `voice:speak` | Speak arbitrary text aloud |
| `voice:read-aloud` | Read any text aloud (LLM-facing) |
| `voice:summarize` | Summarize and speak the last response |
| `voice:stop` | Stop currently playing audio |

## Links

- [Setup Guide](./SETUP.md) — installation, configuration, troubleshooting
- [Build Plan](../../BUILD_PLAN.md) — architecture and design decisions
