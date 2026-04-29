export interface VoicePluginConfig {
  sttModel: "tiny" | "base" | "small";
  ttsEngine: "kokoro" | "edge" | "say";
  voice: string;              // TTS voice identifier
  language: string;           // STT language (default: "auto")
  volume: number;             // playback volume 0-1

  // --- Voice input (STT) hotkey ---
  hotkeyEnabled: boolean;     // enable keyboard-to-voice shortcut
  hotkey: string;             // e.g. "Ctrl+V"
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
  hotkey: "Ctrl+V",
  silenceTimeout: 1.5,
  vadThreshold: 0.03,
};
