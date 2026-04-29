export interface VoicePluginConfig {
  sttModel: "tiny" | "base" | "small";
  ttsEngine: "kokoro" | "edge" | "say";
  voice: string;              // TTS voice identifier
  language: string;           // STT language (default: "auto")
  volume: number;             // playback volume 0-1

  // --- Voice input (STT) trigger ---
  hotkeyEnabled: boolean;     // enable SIGUSR1-based voice trigger
  // NOTE: the old `hotkey` string (e.g. "Ctrl+V") is removed.
  // OpenCode owns stdin — stdin raw-mode in a plugin hangs the TUI.
  // Use `kill -USR1 <pid>` or the voice:record tool instead.
  silenceTimeout: number;     // seconds of silence to end recording (default: 1.5)
  vadThreshold: number;       // amplitude threshold for speech detection (default: 0.03)
}

export const defaultConfig: VoicePluginConfig = {
  sttModel: "base",           // base for conversation-level accuracy
  ttsEngine: "kokoro",
  voice: "af_heart",
  language: "auto",
  volume: 0.8,

  // Voice input defaults
  hotkeyEnabled: true,
  silenceTimeout: 1.5,
  vadThreshold: 0.03,
};
