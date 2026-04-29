import { spawn } from "node:child_process";

// ─── Type Declarations ────────────────────────────────────────────────────────

/**
 * Core TTS engine interface implemented by all backends.
 */
export interface TTSEngine {
  /** Generate speech audio (WAV format bytes) from text. */
  generate(text: string, voice?: string): Promise<Uint8Array>;
  /** Return list of available voice identifiers. */
  getVoices(): Promise<string[]>;
  /** Clean up resources. */
  dispose?(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default sample rate for kokoro-js audio output. */
const KOKORO_SAMPLE_RATE = 24000;

/** Edge TTS REST endpoint. */
const EDGE_TTS_ENDPOINT = "https://edge.tts.microsoft.com/TTS";

/** Voice identifier → human-readable info map (supplied by kokoro-js). */
type KokoroVoiceInfo = {
  name: string;
  language: string;
  gender: "Male" | "Female";
  traits?: string;
  targetQuality: string;
  overallGrade: string;
};

/**
 * Full list of kokoro voice identifiers as defined in the model.
 *
 * These are the canonical keys recognised by kokoro-js. If the model is
 * updated, the canonical list comes from `KokoroTTS.from_pretrained()` →
 * `model.voices`, but keeping a local copy avoids an extra await for
 * `getVoices()`.
 */
const KOKORO_VOICES: readonly string[] = [
  "af_heart",
  "af_bella",
  "am_adam",
  "am_michael",
  "af_nicole",
  "af_sarah",
  "af_alloy",
  "af_aoede",
  "am_puck",
  "bf_alice",
  "bf_emma",
  "bm_fenrir",
  "bf_santa",
  "af_cori",
];

/**
 * A curated subset of common Edge TTS neural voices returned by getVoices().
 * The actual service supports several hundred voices.
 */
const EDGE_VOICES: readonly string[] = [
  "en-US-AvaMultilingualNeural",
  "en-US-AndrewMultilingualNeural",
  "en-US-EmmaMultilingualNeural",
  "en-US-BrianMultilingualNeural",
  "en-GB-SoniaMultilingualNeural",
  "en-GB-RyanMultilingualNeural",
  "en-US-JennyNeural",
  "en-US-GuyNeural",
  "en-AU-NatashaNeural",
  "en-AU-WilliamNeural",
  "en-GB-SoniaNeural",
  "en-GB-RyanNeural",
  "en-US-SteffanNeural",
  "es-ES-ElviraNeural",
  "es-ES-AlvaroNeural",
  "fr-FR-HenriNeural",
  "fr-FR-EloiseNeural",
  "de-DE-FlorianMultilingualNeural",
  "de-DE-KatjaNeural",
  "ja-JP-KeitaNeural",
  "ja-JP-NanamiNeural",
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "it-IT-DiegoNeural",
  "it-IT-ElsaNeural",
  "pt-BR-AntonioNeural",
  "pt-BR-FranciscaNeural",
  "ru-RU-DmitryNeural",
  "ru-RU-SvetlanaNeural",
  "ko-KR-HyunsuMultilingualNeural",
  "ko-KR-InJoonNeural",
];

/** SSML namespace used by Edge TTS. */
const EDGE_SSML_NAMESPACE =
  'xmlns="http://www.w3.org/2001/10/synthesis" ' +
  'xmlns:mstts="http://www.w3.org/2001/mstts" ' +
  'xml:lang="en-US"';

/** Edge TTS accept header — requests WAV output (24 kHz, 16-bit, mono). */
const EDGE_ACCEPT_HEADER = "audio/riff-24khz-16bit-mono-pcm";

// ─── WAV Encoding Utilities ───────────────────────────────────────────────────

/**
 * Convert a Float32Array of audio samples (normalised to −1.0 … 1.0) to
 * a WAV-encoded byte stream (16-bit PCM).
 *
 * @param data     PCM audio samples in Float32Array form.
 * @param sampleRate  Sample rate in Hz (default 24000, matching kokoro output).
 * @returns        WAV-encoded bytes as Uint8Array.
 */
export function floatToWav(
  data: Float32Array,
  sampleRate: number = KOKORO_SAMPLE_RATE,
): Uint8Array {
  const numSamples = data.length;
  const numBytes = numSamples * 2; // 16-bit PCM → 2 bytes per sample
  const headerSize = 44;
  const bufferSize = headerSize + numBytes;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // ── RIFF header (12 bytes) ──────────────────────────────────────────
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numBytes, true); // file size − 8
  writeString(view, 8, "WAVE");

  // ── fmt sub-chunk (24 bytes) ────────────────────────────────────────
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size (16 for PCM)
  view.setUint16(20, 1, true); // audio format = 1 (PCM)
  view.setUint16(22, 1, true); // num channels = 1 (mono)
  view.setUint32(24, sampleRate, true); // sample rate
  view.setUint32(28, sampleRate * 2, true); // avg bytes/sec = sampleRate * 2
  view.setUint16(32, 2, true); // block align = 2
  view.setUint16(34, 16, true); // bits per sample

  // ── data sub-chunk header (8 bytes) ─────────────────────────────────
  writeString(view, 36, "data");
  view.setUint32(40, numBytes, true); // data size

  // ── PCM data ────────────────────────────────────────────────────────
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    const int16 = s < 0 ? Math.floor(s * 0x8000) : Math.floor(s * 0x7fff);
    view.setInt16(headerSize + i * 2, int16, true);
  }

  return new Uint8Array(buffer);
}

/**
 * Convert an Int16Array of PCM audio samples to a WAV-encoded byte stream.
 *
 * @param data     PCM audio samples as 16-bit signed integers.
 * @param sampleRate  Sample rate in Hz (default 24000).
 * @returns        WAV-encoded bytes as Uint8Array.
 */
export function int16ToWav(
  data: Int16Array,
  sampleRate: number = KOKORO_SAMPLE_RATE,
): Uint8Array {
  const numBytes = data.length * 2;
  const headerSize = 44;
  const bufferSize = headerSize + numBytes;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // ── RIFF header (12 bytes) ──────────────────────────────────────────
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numBytes, true);
  writeString(view, 8, "WAVE");

  // ── fmt sub-chunk (24 bytes) ────────────────────────────────────────
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // ── data sub-chunk header (8 bytes) ─────────────────────────────────
  writeString(view, 36, "data");
  view.setUint32(40, numBytes, true);

  // ── PCM data ────────────────────────────────────────────────────────
  uint8.set(new Uint8Array(data.buffer, data.byteOffset, numBytes), headerSize);

  return uint8;
}

/** Write an ASCII string at a given offset into a DataView. */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ─── SSML helpers ─────────────────────────────────────────────────────────────

/**
 * Escape XML special characters in text so it can safely be embedded in
 * SSML / XML content.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a minimal SSML document for Edge TTS.
 */
function buildEdgeSsml(voice: string, text: string): string {
  const escaped = escapeXml(text);
  return `<speak ${EDGE_SSML_NAMESPACE}><voice name="${voice}">${escaped}</voice></speak>`;
}

// ─── KokoroTTSEngine (local neural TTS, highest quality) ─────────────────────

/**
 * Lazy-loaded singleton for the Kokoro model instance.
 *
 * Ensures the heavy WASM model is loaded exactly once, regardless of how
 * many KokoroTTSEngine instances are created.
 */
let kokoroInstance: any = null;
let kokoroLoading: Promise<void> | null = null;

/**
 * A flag shared among all KokoroTTSEngine instances so that dispose()
 * performed by one caller unloads the model for everyone.
 */
let kokoroDisposed = false;

/**
 * Local neural TTS engine powered by kokoro-js.
 *
 * Produces the highest-quality speech among the three backends at the
 * cost of a ~50 MB model download (first run only) and higher latency
 * (~300 ms warm-up, then ~200 ms per utterance).
 *
 * The model is lazy-loaded on the first call to {@link generate}.
 */
export class KokoroTTSEngine implements TTSEngine {
  private voice: string;
  private modelLoaded = false;

  constructor(voice = "af_heart") {
    this.voice = voice;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Ensure the Kokoro model has been loaded (singleton pattern).
   */
  private async _ensureLoaded(): Promise<void> {
    if (this.modelLoaded) return;
    if (kokoroDisposed) {
      // Another call to dispose() is in progress; reset the flag and reload.
      kokoroDisposed = false;
    }
    if (!kokoroLoading) {
      kokoroLoading = (async () => {
        console.log("[voice-plugin] Kokoro: loading model (~50 MB, first time only)...");
        // Dynamic import — kokoro-js uses ONNX WASM and won't load at module
        // top-level (e.g. in Bun). We import it here only when kokoro is
        // actually requested.
        const { KokoroTTS } = await import("kokoro-js");
        kokoroInstance = await KokoroTTS.from_pretrained(
          "onnx-community/Kokoro-82M-v1.0-ONNX",
        );
        console.log("[voice-plugin] Kokoro: model loaded successfully");
      })();
    }
    try {
      await kokoroLoading;
    } catch (err) {
      // Reset kokoroLoading so the next call can retry loading.
      // Without this, a single transient failure permanently breaks TTS.
      kokoroLoading = null;
      kokoroInstance = null;
      console.error("[voice-plugin] Kokoro: model load failed —", err);
      throw err;
    }
    kokoroLoading = null;
    this.modelLoaded = true;
  }

  // ── Text splitting for long inputs ────────────────────────────────────

  /**
   * Split long text into chunks small enough to stay under kokoro-js's
   * ~512 token limit *after* phonemization.  Phonemization expands
   * English text ~1.5-2x, so we target ~30 characters per chunk — this
   * keeps us safely under the token ceiling while preserving word boundaries.
   *
   * All splits happen at word boundaries; no words are ever torn apart.
   */
  private _splitText(text: string): string[] {
    const MAX_CHARS = 55; // raw text chars — ~25-35 tokens after phonemization,
                          // stays safely under kokoro-js's ~512 token limit

    // Split on sentence boundaries first (. ! ?)
    const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];
    const clean: string[] = [];
    for (const s of sentences) {
      const trimmed = s.trim();
      if (trimmed) clean.push(trimmed);
    }

    const chunks: string[] = [];
    for (const sentence of clean) {
      // Word-wrap a single sentence into chunks of MAX_CHARS
      const words = sentence.split(/\s+/);
      let buf = "";
      for (const word of words) {
        if (!word) continue;
        const candidate = buf ? buf + " " + word : word;
        if (candidate.length > MAX_CHARS && buf) {
          chunks.push(buf);
          buf = word;
        } else {
          buf = candidate;
        }
      }
      if (buf) chunks.push(buf);
    }
    return chunks;
  }

  // ── TTSEngine implementation ──────────────────────────────────────────

  /**
   * Generate WAV audio bytes from plain text.
   *
   * The model is loaded lazily on the first call. Subsequent calls reuse the
   * loaded model.
   *
   * @param text    The text to synthesise.
   * @param voice   Optional voice override. Defaults to the constructor voice.
   * @returns       WAV-encoded PCM bytes (24 kHz, mono, 16-bit).
   *
   * @throws Error if the model fails to download or generate audio.
   */
 async generate(text: string, voice?: string): Promise<Uint8Array> {
    if (!text || !text.trim()) {
      return new Uint8Array(0);
    }

    await this._ensureLoaded();
    if (!kokoroInstance) {
      console.error("[KokoroTTSEngine] kokoroInstance is null after _ensureLoaded");
      console.error("[KokoroTTSEngine] kokoroInstance global:", kokoroInstance);
      return new Uint8Array(0);
    }

    // Normalize text that kokoro's phonemizer chokes on.
    // Em-dashes, en-dashes, non-breaking spaces, and zero-width characters
    // are not handled by the phonemizer and will cause silent failures.
    const normalized = text
      .replace(/[\u2014\u2013\u2015]/g, ", ")   // em-dash, en-dash, horizontal bar
      .replace(/\u00A0/g, " ")                    // non-breaking space
      .replace(/[\u200B-\u200D]/g, "");           // zero-width spaces

    const voiceName = voice ?? this.voice;

    // kokoro-js generate() has a ~512 token limit (truncation: true, no max_length)
    // so long text gets silently cut off mid-sentence.  For text > 200 chars,
    // split into sentence-respecting chunks and generate each separately,
    // then concatenate the resulting WAV files.
    if (normalized.length > 200) {
      const chunks = this._splitText(normalized);
      const wavBuffers: Uint8Array[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const result = await kokoroInstance.generate(chunks[i], {
          voice: voiceName as never,
        });

        if (!result || !result.audio || result.audio.length === 0) {
          console.warn("[KokoroTTSEngine] chunk", i + 1, "returned empty audio");
          continue;
        }
        wavBuffers.push(floatToWav(result.audio, KOKORO_SAMPLE_RATE));
      }

      if (wavBuffers.length === 0) {
        return new Uint8Array(0);
      }
      // Concatenate WAVs: first full, subsequent without the 44-byte header
      let totalWavSize = wavBuffers[0].length;
      for (let i = 1; i < wavBuffers.length; i++) {
        totalWavSize += wavBuffers[i].length - 44;
      }
      const merged = new Uint8Array(totalWavSize);
      let offset = 0;
      merged.set(wavBuffers[0], offset);
      offset += wavBuffers[0].length;
      for (let i = 1; i < wavBuffers.length; i++) {
        merged.set(wavBuffers[i].subarray(44), offset);
        offset += wavBuffers[i].length - 44;
      }
      // Update RIFF headers
      const view = new DataView(merged.buffer);
      view.setUint32(4, totalWavSize - 8, true);
      view.setUint32(40, totalWavSize - 44, true);
      return merged;
    }

    // Short text: direct generate() — no chunking needed.
    const result = await kokoroInstance.generate(normalized, {
      voice: voiceName as never,
    });

    if (!result) {
      console.warn("[KokoroTTSEngine] kokoro-js returned null result for:", text.slice(0, 60));
      return new Uint8Array(0);
    }

    // Try toWav() first (handles WASM internally). Fall back to raw .audio.
    if (typeof (result as any).toWav === "function") {
      try {
        const wavBuf = await (result as any).toWav();
        if (wavBuf && wavBuf.byteLength > 0) {
          return new Uint8Array(wavBuf);
        }
      } catch (err) {
        console.warn("[KokoroTTSEngine] toWav() failed, trying raw audio:", err);
      }
    }

    // Fallback: use the .audio Float32Array property directly.
    const rawAudio = result as { audio?: Float32Array };
    if (rawAudio.audio && rawAudio.audio.length > 0) {
      return floatToWav(rawAudio.audio, KOKORO_SAMPLE_RATE);
    }

    console.warn(
      "[KokoroTTSEngine] kokoro-js returned unexpected result shape for:",
      text.slice(0, 60),
      "keys:", Object.keys(result),
    );
    return new Uint8Array(0);
  }

  /**
   * Return the full list of available kokoro voice identifiers.
   */
  getVoices(): Promise<string[]> {
    return Promise.resolve([...KOKORO_VOICES]);
  }

  /**
   * Free WASM and model memory.
   *
   * Safe to call multiple times or before the process exits.
   * After disposal the model must be reloaded on next generate() call.
   */
  dispose(): void {
    if (kokoroInstance) {
      // Try to dispose if the method exists (future compatibility).
      const instance = kokoroInstance as { dispose?: () => void };
      if (typeof instance.dispose === "function") {
        instance.dispose();
      }
      kokoroInstance = null;
    }
    kokoroLoading = null;
    // Reset the disposed flag so a new KokoroTTSEngine instance can reload
    // the model without throwing.  Each instance tracks its own modelLoaded
    // state so re-entrant calls are safe.
    kokoroDisposed = false;
    this.modelLoaded = false;
  }

  /**
   * Explicitly load the model. This is called automatically by generate()
   * if not called first — useful when you want to show a loading indicator.
   */
  async init(): Promise<void> {
    await this._ensureLoaded();
  }
}

// ─── EdgeTTSEngine (Microsoft Edge free TTS) ──────────────────────────────────

/**
 * Free TTS engine backed by Microsoft Edge's built-in neural TTS service.
 *
 * Quality is good (near-kokoro neural voices) and requires no API key, but
 * depends on an internet connection and the Edge REST endpoint being reachable.
 *
 * Audio is returned directly in WAV format (24 kHz, 16-bit, mono).
 */
export class EdgeTTSEngine implements TTSEngine {
  private voice: string;
  private _voiceCache: string[] | null = null;

  constructor(voice = "en-US-AvaMultilingualNeural") {
    this.voice = voice;
  }

  /**
   * Generate WAV audio bytes from plain text via the Edge TTS REST API.
   *
   * @param text    The text to synthesise.
   * @param voice   Optional voice override.
   * @returns       WAV-encoded PCM bytes.
   */
  async generate(text: string, voice?: string): Promise<Uint8Array> {
    if (!text || !text.trim()) {
      return new Uint8Array(0);
    }

    const selectedVoice = voice ?? this.voice;
    const ssml = buildEdgeSsml(selectedVoice, text);

    const response = await fetch(EDGE_TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type":
          "application/ssml+xml;model-schema=v1.0;codec=speechaudio;" +
          "format=riff-24khz-16bit-mono-pcm",
        "Accept": EDGE_ACCEPT_HEADER,
        "X-Timestamp": new Date().toISOString(),
        "Origin": "https://www.bing.com",
        "Referer": "https://www.bing.com/",
      },
      body: ssml,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Edge TTS request failed (${response.status} ${response.statusText}): ` +
          `${bodyText.slice(0, 500)}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  /**
   * Return a curated list of common Edge TTS neural voices.
   *
   * The actual service supports several hundred voices; this list covers the
   * most commonly-used ones for English and a handful of other languages.
   */
  getVoices(): Promise<string[]> {
    if (this._voiceCache) return Promise.resolve([...this._voiceCache]);

    // The Edge TTS API doesn't expose a public voice-listing endpoint,
    // so we return our curated list.
    this._voiceCache = [...EDGE_VOICES];
    return Promise.resolve(this._voiceCache);
  }

  /**
   * EdgeTTSEngine has no local resources to clean up.
   */
  dispose(): void {
    // no-op
  }
}

// ─── SayTTSEngine (macOS system voice, zero dependencies) ─────────────────────

/**
 * Fallback TTS engine using the macOS `say` command.
 *
 * Zero dependencies — works out of the box on macOS with system voices.
 * Produces no WAV bytes; audio is played directly through the system speaker.
 *
 * On non-macOS platforms this engine will still return empty audio and
 * list no voices (since `say` is macOS-specific).
 */
export class SayTTSEngine implements TTSEngine {
  private voice?: string;
  private _voiceCache: string[] | null = null;

  constructor(voice?: string) {
    this.voice = voice;
  }

  /**
   * Produce WAV audio from text using macOS `say` → `afplay`.
   *
   * Uses `say -f <text> -o <audiofile>` to render AIFF, then converts to
   * WAV. The audio file is cleaned up after reading.
   *
   * @param text    The text to synthesize.
   * @param _voice  Optional voice override (defaults to `"Samantha"`).
   * @returns       WAV-encoded PCM bytes.
   */
  async generate(text: string, _voice?: string): Promise<Uint8Array> {
    if (!text || !text.trim()) {
      return new Uint8Array(0);
    }

    const { mkdtemp, writeFile, readFile, unlink, rmdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "voice-say-"));
    const txtPath = join(dir, "text.txt");
    const aiffPath = join(dir, "audio.aiff");

    try {
      // Write text to temp file
      await writeFile(txtPath, text, "utf-8");

      // Render AIFF via say
      const voiceArg = _voice ? ["-v", _voice, "-f", txtPath, "-o", aiffPath] : ["-f", txtPath, "-o", aiffPath];
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("say", voiceArg, {
          stdio: ["ignore", "ignore", "pipe"],
        });
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`say exited with code ${code}`));
        });
        proc.on("error", reject);
      });

      // Read AIFF (afplay plays AIFF natively on macOS)
      const aiffData = await readFile(aiffPath);
      return new Uint8Array(aiffData);
    } finally {
      // Clean up temp files
      try { await unlink(txtPath); } catch { /* ignore */ }
      try { await unlink(aiffPath); } catch { /* ignore */ }
      try { await rmdir(dir); } catch { /* ignore */ }
    }
  }

  /**
   * Return the list of macOS system voices by querying `say -v ?`.
   *
   * @returns A promise resolving to voice names such as `"Samantha"`,
   *          `"Moira"`, `"Tessa"`, etc.
   */
  async getVoices(): Promise<string[]> {
    if (this._voiceCache !== null) {
      return [...this._voiceCache];
    }

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn("say", ["-v", "?"], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        const parts: Buffer[] = [];
        proc.stdout.on("data", (chunk: Buffer) => parts.push(chunk));
        proc.stderr.on("data", () => {
          // say writes to stderr for the voice list on some macOS versions
        });
        proc.on("close", (code) => {
          if (code === 0) resolve(Buffer.concat(parts).toString());
          else reject(new Error(`say exited with code ${code}`));
        });
        proc.on("error", reject);
      });

      // The `say -v ?` output looks like:
      //   Name: Samantha   Language: en-US
      //   Name: Moira      Language: en-US
      // Parse "Name: ..." lines.
      this._voiceCache = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("Name:"))
        .map((line) => line.replace(/^Name:\s*/i, ""))
        .filter(Boolean);
    } catch {
      // macOS not available or `say` not installed — return empty list
      this._voiceCache = [];
    }

    return [...this._voiceCache];
  }

  /**
   * SayTTSEngine has no local resources to clean up.
   */
  dispose(): void {
    // no-op
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a TTS engine instance based on the configured engine type.
 *
 * @param engine  Engine identifier: `"kokoro"` | `"edge"` | `"say"`.
 * @param voice   Optional voice override. Falls back to the engine's default.
 * @returns       A fully constructed TTSEngine implementation.
 */
export function createTTSEngine(
  engine: "kokoro" | "edge" | "say",
  voice?: string,
): TTSEngine {
  switch (engine) {
    case "kokoro":
      return new KokoroTTSEngine(voice ?? "af_heart");
    case "edge":
      return new EdgeTTSEngine(
        voice ?? "en-US-AvaMultilingualNeural",
      );
    case "say":
      return new SayTTSEngine(voice);
  }
}
