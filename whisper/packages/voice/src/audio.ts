import { spawn } from "node:child_process";
import { mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoicePluginConfig } from "./config.js";
import { defaultConfig } from "./config.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether a command exists on the system PATH.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    const test = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return await new Promise<boolean>((resolve) => {
      test.on("exit", (code) => resolve(code === 0));
      test.on("error", () => resolve(false));
      // Kill after a short timeout so we don't hang
      setTimeout(() => test.kill(), 3000);
    });
  } catch {
    return false;
  }
}

/**
 * Detect the available audio recording tool in priority order:
 * sox (rec) → ffmpeg → error.
 */
async function detectRecorder(): Promise<"sox" | "ffmpeg"> {
  // Prefer ffmpeg on macOS because `rec` (sox) doesn't reliably capture
  // from the macOS microphone — `rec` shows In:0.00% even when speaking.
  // ffmpeg's avfoundation framework works correctly on macOS.
  if (process.platform === "darwin") {
    if (await commandExists("ffmpeg")) return "ffmpeg";
    if (await commandExists("rec")) return "sox";
  }
  if (await commandExists("rec")) {
    return "sox";
  }
  if (await commandExists("ffmpeg")) {
    return "ffmpeg";
  }
  throw new Error(
    "No audio recording tool found. Install sox via `brew install sox` or ffmpeg via `brew install ffmpeg`."
  );
}

/**
 * Detect the available audio playback tool for the current platform.
 * Returns one of: "afplay" | "aplay" | "powershell" | "say" | null.
 */
async function detectPlayer(): Promise<string | null> {
  const platform = process.platform;

  if (platform === "darwin") {
    if (await commandExists("afplay")) return "afplay";
    if (await commandExists("say")) return "say";
  }

  if (platform === "linux") {
    if (await commandExists("aplay")) return "aplay";
  }

  if (platform === "win32") {
    if (await commandExists("powershell")) return "powershell";
  }

  // Cross-platform fallbacks
  if (await commandExists("afplay")) return "afplay";
  if (await commandExists("say")) return "say";
  if (await commandExists("aplay")) return "aplay";

  return null;
}

/**
 * Convert raw PCM Int16 samples to a Float32Array normalised to [-1.0, 1.0].
 */
function pcmToFloat32(buffer: Buffer): Float32Array {
  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

/**
 * Strip a WAV header (first 44 bytes) if present.
 * A minimal WAV header check: "RIFF" at offset 0.
 */
function stripWavHeader(data: Buffer): Buffer {
  if (data.length >= 44 && data.readUInt32LE(0) === 0x46464952 /* "RIFF" */) {
    return data.subarray(44);
  }
  return data;
}

// ─── AudioCapture ─────────────────────────────────────────────────────────────

export class AudioCapture {
  private process: ReturnType<typeof spawn> | null = null;
  private chunks: Buffer[] = [];
  private pcmBuffer: Buffer | null = null;
  private started = false;

  // --- VAD (Voice Activity Detection) ---
  private vadSpeechEndTimer: ReturnType<typeof setTimeout> | null = null;
  private vadOnSpeechEnd?: () => void;
  private vadLastActivity = 0;
  private vadThreshold: number = 0.03;
  private vadTimeoutMs: number = 1500;

  private config: VoicePluginConfig;

  /**
   * Create an AudioCapture instance.
   * @param config Optional voice plugin config (for device index etc.).
   */
  constructor(config?: Partial<VoicePluginConfig>) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Start recording from the system microphone.
   *
   * Records at 16 kHz, mono, 16-bit PCM. Output is collected as Buffer chunks
   * emitted to stdout of the recording process.
   *
   * Tool detection order: sox (`rec`) → ffmpeg → error.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error("AudioCapture is already recording. Call stop() first.");
    }

    this.chunks = [];
    this.pcmBuffer = null;
    this._pcmProcessed = false;  // reset for each new recording session

    const recorder = await detectRecorder();

    let args: string[];

    if (recorder === "sox") {
      // sox rec outputs a proper WAV file with header to stdout
      // Using default input device (system microphone)
      args = [
        "-r", "16000",
        "-c", "1",
        "-b", "16",
        "-e", "signed-integer",
        "-t", "wav",
        "-",
      ];
      this.process = spawn("rec", args, { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      // ffmpeg fallback — outputs raw s16le (no header)
      const platform = process.platform;
      if (platform === "darwin") {
        // macOS: use avfoundation for audio capture
        const deviceIndex = this.config.audioDeviceIndex || "0";
        args = [
          "-f", "avfoundation",
          "-i", deviceIndex,
          "-ar", "16000",
          "-ac", "1",
          "-f", "s16le",
          "-",
        ];
      } else {
        // Linux: use alsa or pulseaudio
        args = [
          "-f", "alsa",
          "-i", "default",
          "-ar", "16000",
          "-ac", "1",
          "-f", "s16le",
          "-",
        ];
      }
      this.process = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    }

    this.started = true;

    // Validate that the recording device is actually producing audio data
    setTimeout(() => {
      if (this.started && this.chunks.length === 0) {
        console.error("[voice-plugin] No audio data received from recording device within 2 seconds. Check microphone permissions and device availability.");
      }
    }, 2000);

    this.process.stdout?.on("error", () => {
      // stdout error; the 'close' event will handle cleanup
    });

    this.process.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log("[voice-plugin] ffmpeg stderr:", msg);
      }
    });

    this.process.on("error", (err) => {
      this.started = false;
      throw err;
    });

    // Collect stdout chunks, with VAD processing
    this.process.stdout?.on("data", (chunk: Buffer) => {
      const buf = Buffer.from(chunk);
      this.chunks.push(buf);

      // VAD: run amplitude check on the incoming chunk directly (O(1) per chunk).
      // Align to a 1024-sample (64 ms at 16 kHz) boundary from the chunk tail.
      const aligned = this.getLastSamplesAligned(buf, 1024);
      if (aligned) {
        const float32 = pcmToFloat32(aligned);
        this.processVADChunk(float32);
        // Note: processVADChunk fires vadOnSpeechEnd via its internal timer;
        // no action needed here — the callback handles stop() itself.
      }
    });

    // Process closed — record is finished (intentionally or not)
    this.process.once("close", (code) => {
      if (this.started) {
        this.started = false;
        // Merge chunks into pcmBuffer so getRawBuffer() works
        this.pcmBuffer = Buffer.concat(this.chunks);
        this.chunks = [];
      }
    });
  }

  /**
   * Stop recording, merge all chunks into a single Buffer, strip the WAV header
   * if present, and return the raw PCM samples normalised to Float32 (-1.0..1.0).
   */
  async stop(): Promise<Float32Array> {
    if (!this.started && !this.pcmBuffer) {
      // Nothing to stop and no prior recording — return empty
      return new Float32Array(0);
    }

    // If still started, terminate the recording process
    if (this.started && this.process) {
      this.process.kill("SIGINT");

      // Wait for the process to close — the close handler registered in
      // start() will merge chunks into pcmBuffer.  We just need to give
      // it time to fire.  Don't add another close listener here, or it
      // will race with (and overwrite) the one from start().
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
    }

    // Reset started flag — either process was killed or spawn failed early
    this.started = false;

    if (!this.pcmBuffer) {
      return new Float32Array(0);
    }

    // If pcmBuffer was set by the 'close' handler (not by explicit stop),
    // it hasn't been processed yet — do it now.
    if (!this._pcmProcessed) {
      // Strip WAV header if the data starts with a RIFF marker (sox output)
      // ffmpeg outputs raw s16le without header, so this is a safe no-op.
      this.pcmBuffer = stripWavHeader(this.pcmBuffer);
      this._pcmProcessed = true;
    }

    // Convert Int16 samples to Float32 normalised to [-1.0, 1.0]
    const float32 = pcmToFloat32(this.pcmBuffer);

    return float32;
  }

  private _pcmProcessed = false;

  /**
   * Get the last `sampleCount` samples from a PCM buffer (16-bit, aligned).
   * Returns a Buffer slice or null if buffer is too small.
   */
  private getLastSamplesAligned(buf: Buffer, sampleCount: number): Buffer | null {
    const bytesNeeded = sampleCount * 2; // 16-bit
    if (buf.length < bytesNeeded) return null;
    return buf.slice(buf.length - bytesNeeded);
  }

  /**
   * Return whether recording is currently active.
   */
  isActive(): boolean {
    return this.started;
  }

  // -- VAD helpers ----------------------------------------------------------

  /** Compute RMS amplitude of a Float32 chunk. */
  private static rms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Set VAD configuration.
   * @param threshold  Amplitude threshold for speech detection (0.01–0.1).
   * @param onSpeechEnd  Callback fired after silenceTimeout seconds of silence.
   * @param timeoutMs  Silence duration in ms before triggering onSpeechEnd.
   */
  setVADConfig(
    threshold: number,
    onSpeechEnd: () => void,
    timeoutMs: number,
  ): void {
    this.vadThreshold = threshold;
    this.vadOnSpeechEnd = onSpeechEnd;
    this.vadLastActivity = 0;
    this.vadTimeoutMs = timeoutMs;

    // Clear any existing timer
    if (this.vadSpeechEndTimer) {
      clearTimeout(this.vadSpeechEndTimer);
      this.vadSpeechEndTimer = null;
    }
  }

  /**
   * Process an audio chunk for VAD.
   * Returns true if this chunk marks the end of a speech segment (silence timeout elapsed).
   */
  processVADChunk(samples: Float32Array): boolean {
    if (!this.vadOnSpeechEnd) return false;

    const amplitude = AudioCapture.rms(samples);
    const now = Date.now();

    if (amplitude > this.vadThreshold) {
      // Speech detected — reset silence timer
      this.vadLastActivity = now;
      if (this.vadSpeechEndTimer) {
        clearTimeout(this.vadSpeechEndTimer);
        this.vadSpeechEndTimer = null;
      }
    } else {
      // Silence — schedule speech-end callback
      if (this.vadLastActivity > 0 && !this.vadSpeechEndTimer) {
        this.vadSpeechEndTimer = setTimeout(() => {
          this.vadSpeechEndTimer = null;
          this.vadLastActivity = 0;
          const cb = this.vadOnSpeechEnd;
          this.vadOnSpeechEnd = undefined;  // one-shot
          cb?.();
        }, this.vadTimeoutMs);
      }
    }

    return false;  // didn't end speech in this chunk
  }

  /**
   * Start VAD mode: immediately trigger onSpeechEnd (no speech accumulation).
   * Used when the user releases the hotkey before speaking — cancel any pending VAD.
   */
  cancelVAD(): void {
    if (this.vadSpeechEndTimer) {
      clearTimeout(this.vadSpeechEndTimer);
      this.vadSpeechEndTimer = null;
    }
    this.vadLastActivity = 0;
    if (this.vadOnSpeechEnd) {
      this.vadOnSpeechEnd();  // fire immediately — means "cancel"
      this.vadOnSpeechEnd = undefined;
    }
  }

  /**
   * Record a fixed duration and return the result as Float32Array.
   *
   * Starts recording and stops after `durationMs` milliseconds.
   */
  async record(durationMs: number): Promise<Float32Array> {
    // Check if we're already recording
    if (this.started) {
      throw new Error("AudioCapture is already recording. Call stop() first.");
    }

    await this.start();

    let settled = false;

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      try {
        await this.stop();
      } catch {
        // ignore — stop may have been called from close handler already
      }
    }, durationMs + 200); // slight buffer for safety

    this.process?.once("close", async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await this.stop();
      } catch {
        // ignore
      }
    });

    // Wait until either the timer fires, the process closes, or stop() is called externally
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.started && this.pcmBuffer) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Safety net: if nothing ever settles, timeout after duration + buffer + extra
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, durationMs + 3000);
    });

    // Return the recorded audio — delegate to stop() so WAV header stripping
    // and Float32 conversion are applied consistently.
    return this.stop();
  }

  /**
   * Get the raw PCM buffer (Int16 sample data) without normalizing.
   * Returns a Buffer of the last recorded PCM bytes.
   */
  getRawBuffer(): Buffer {
    if (!this.pcmBuffer) {
      return Buffer.alloc(0);
    }
    return this.pcmBuffer;
  }
}

// ─── AudioPlayer ──────────────────────────────────────────────────────────────

export class AudioPlayer {
  private playbackProcess: ReturnType<typeof spawn> | null = null;
  private playing = false;
  private tempFile: string | null = null;
  private tempDir: string | null = null;

  /**
   * Play audio bytes (WAV format) through the system speaker.
   *
   * Writes audio to a temporary WAV file and plays it using the best available
   * tool for the current platform:
   *   - macOS:   `afplay`  (preferred) or `say`
   *   - Linux:   `aplay`
  *   - Windows: PowerShell `SoundPlayer`
    *
    * Waits for any ongoing playback to finish, then starts new audio.
    * New utterances queue up naturally instead of interrupting each other.
    *
    * @param audio     Audio bytes in WAV format.
   * @param volume    Volume level 0.0–1.0 (macOS afplay only).
   */
  async play(audio: Uint8Array, volume?: number): Promise<void> {
    // Wait for any ongoing playback to finish before starting new audio.
    // New utterances queue up naturally instead of interrupting each other.
    while (this.playing && this.playbackProcess) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    const player = await detectPlayer();
    if (!player) {
      throw new Error(
        "No audio playback tool found. Install afplay (macOS), aplay (Linux), or say (cross-platform)."
      );
    }

    // Detect audio format and set appropriate extension
    const isAiff = audio.length > 12 && audio[0] === 0x46 && audio[1] === 0x4F && audio[2] === 0x52 && audio[3] === 0x4D && audio[8] === 0x41 && audio[9] === 0x49 && audio[10] === 0x46 && audio[11] === 0x46; // FORM....AIFF
    const ext = isAiff ? "aiff" : "wav";
    const dir = await mkdtemp(join(tmpdir(), "voice-"));
    const tempPath = join(dir, `audio.${ext}`);

    // Write audio bytes to temp file
    await writeFile(tempPath, audio);

    this.tempDir = dir;
    this.tempFile = tempPath;

    // Spawn the playback process
    const platform = process.platform;

    if (platform === "darwin" && player === "afplay") {
      const vol = volume ?? 1.0;
      const clampedVol = Math.max(0, Math.min(1, vol));
      this.playbackProcess = spawn("afplay", [
        "-v", String(clampedVol),
        tempPath,
      ], { stdio: ["ignore", "ignore", "ignore"] });
    } else if (platform === "linux" && player === "aplay") {
      this.playbackProcess = spawn("aplay", [tempPath], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } else if (platform === "win32" && player === "powershell") {
      // Escape the temp path for PowerShell (handle spaces, etc.)
      const escapedPath = tempPath.replace(/'/g, "''");
      this.playbackProcess = spawn("powershell", [
        "-c",
        `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`,
      ], { stdio: ["ignore", "ignore", "ignore"] });
    } else {
      // Fallback: say (macOS text-to-speech reads files)
      this.playbackProcess = spawn("say", [
        "-f", tempPath,
      ], { stdio: ["ignore", "ignore", "ignore"] });
    }

    this.playing = true;

    this.playbackProcess.once("close", () => {
      this.playing = false;
      // Clean up temp file
      this.cleanup();
    });

    this.playbackProcess.on("error", () => {
      this.playing = false;
      this.cleanup();
    });
  }

  /**
   * Stop currently playing audio. A no-op if nothing is playing.
   */
  stop(): void {
    if (!this.playing && !this.playbackProcess) {
      return;
    }

    if (this.playbackProcess) {
      try {
        this.playbackProcess.kill("SIGINT");
      } catch {
        // Process already exited; ignore
      }
      this.playbackProcess = null;
    }

    this.playing = false;
    this.cleanup();
  }

  /**
   * Check if audio is currently playing.
   */
  isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Clean up temporary files.
   */
  private async cleanup(): Promise<void> {
    if (this.tempFile) {
      try {
        await unlink(this.tempFile);
      } catch {
        // File may already be deleted; ignore
      }
      this.tempFile = null;
    }

    if (this.tempDir) {
      try {
        await rmdir(this.tempDir);
      } catch {
        // Directory may already be deleted or non-empty; ignore
      }
      this.tempDir = null;
    }
  }
}
