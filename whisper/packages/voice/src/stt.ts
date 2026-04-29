import {
  Whisper,
  WhisperFullParams,
  WhisperSamplingStrategy,
  type Segment,
  type WhisperContextParams,
} from "@napi-rs/whisper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by a single transcription. */
export interface STTResult {
  /** The full transcribed text. */
  text: string;
  /** Estimated confidence in the transcription, 0.0–1.0. */
  confidence: number;
  /** Per-segment timestamps and text. */
  segments: Array<{ start: number; end: number; text: string }>;
}

/**
 * Supported Whisper model sizes (GGUF / GGML format).
 *
 * | Variant | Approx. size | Speed | Accuracy |
 * |---------|-------------|-------|----------|
 * | `tiny`  | ~75 MB      | Fastest | Good for simple commands |
 * | `base`  | ~150 MB     | Fast | Better accuracy |
 * | `small` | ~500 MB     | Moderate | Best accuracy |
 */
export type ModelVariant = "tiny" | "base" | "small";

// ---------------------------------------------------------------------------
// Model download URLs
// ---------------------------------------------------------------------------

const MODEL_URLS: Readonly<Record<ModelVariant, string>> = {
  tiny: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  base: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  small: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
};

// ---------------------------------------------------------------------------
// STTEngine
// ---------------------------------------------------------------------------

/**
 * Speech-to-text engine backed by `@napi-rs/whisper` (whisper.cpp via
 * Rust/N-API bindings).  Runs locally with Metal GPU support on Apple Silicon.
 *
 * The Whisper model is loaded lazily on the first call to `transcribe()`.
 * Consecutive `transcribe()` calls are executed sequentially through an
 * internal promise queue to avoid concurrent native-API access.
 */
export class STTEngine {
  private whisper: Whisper | null = null;
  private modelLoaded = false;
  private modelBuffer: Uint8Array;
  private contextParams?: WhisperContextParams;

  /** Target language; `"auto"` triggers language detection. */
  private readonly language: string;

  /**
   * Sequential work queue.  Each transcribe call appends its work to the end
   * of the chain, guaranteeing serial execution on the native Whisper instance.
   */
  private nextWork: Promise<void> = Promise.resolve();

  /** Tracks whether a model-load is in progress (for `init()` idempotency). */
  private loadingModel = false;
  private loadingPromise: Promise<void> | null = null;

  // -- Constructor ---------------------------------------------------------

  /**
   * @param modelBuffer  GGML model binary (loaded from disk by the caller).
   * @param language     Language code (`"en"`, `"zh"`, `"ja"`, …) or `"auto"`.
   * @param contextParams Optional native-context tuning (GPU, flash-attention, …).
   */
  constructor(
    modelBuffer: Uint8Array,
    language: string = "auto",
    contextParams?: WhisperContextParams,
  ) {
    this.modelBuffer = modelBuffer;
    this.language = language;
    this.contextParams = contextParams;
  }

  // -- init() --------------------------------------------------------------

  /**
   * Initialise (lazily load) the Whisper model from the GGML binary buffer.
   *
   * Idempotent — subsequent calls return immediately if the model is already
   * loaded or in the process of loading.
   */
  async init(): Promise<void> {
    if (this.modelLoaded) return;
    if (this.loadingModel) return this.loadingPromise!;

    this.loadingModel = true;
    this.loadingPromise = this._loadModel().catch((err) => {
      this.loadingModel = false;
      this.loadingPromise = null;
      throw err;
    });
    return this.loadingPromise;
  }

  private async _loadModel(): Promise<void> {
    try {
      this.whisper = new Whisper(this.modelBuffer, this.contextParams);
      this.modelLoaded = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load Whisper model: ${message}. ` +
          `The model binary may be corrupted, truncated, or incompatible with ` +
          `this platform. Ensure you downloaded it with:\n\n` +
          `  npx download-whisper-model tiny   # or base / small\n\n` +
          `The file should be saved as models/ggml-tiny.bin (relative to the ` +
          `project root).`,
      );
    } finally {
      this.loadingModel = false;
      this.loadingPromise = null;
    }
  }

  // -- transcribe() --------------------------------------------------------

  /**
   * Transcribe a raw PCM audio buffer.
   *
   * **Expected format:** 16 kHz mono Float32 samples in the range `[-1.0, 1.0]`.
   *
   * The model is auto-initialised on the first call.  Concurrent calls are
   * queued and executed serially.
   */
  async transcribe(audio: Float32Array): Promise<STTResult> {
    // -- Guard: empty buffer ------------------------------------------------
    if (!audio || audio.length === 0) {
      return { text: "", confidence: 0, segments: [] };
    }

    // -- Guard: silence detection -------------------------------------------
    const hasContent = audio.some((v) => Math.abs(v) > 0.001);
    if (!hasContent) {
      return { text: "", confidence: 0, segments: [] };
    }

    // -- Guard: minimum duration --------------------------------------------
    const durationSeconds = audio.length / 16_000;
    if (durationSeconds < 0.5) {
      console.warn(
        `[STT] Audio buffer is shorter than 0.5 s (${durationSeconds.toFixed(2)} s). ` +
          "Transcription may be unreliable.",
      );
    }

    // -- Enqueue work in the sequential chain --------------------------------
    let resolve!: (result: STTResult) => void;
    const workPromise = new Promise<STTResult>((r) => {
      resolve = r;
    });

    const previousWork = this.nextWork;
    this.nextWork = previousWork
      .then(() => this._doTranscribe(audio))
      .then((result) => {
        resolve(result);
      })
      .catch((err) => {
        // On failure, drain the chain so the next caller gets a clean slate.
        this.nextWork = Promise.resolve();
        throw err;
      });

    return workPromise;
  }

  // -- dispose() -----------------------------------------------------------

  /**
   * Release native model memory when the plugin is unloaded.
   *
   * Safe to call multiple times or when the model is not loaded — always a
   * no-op in that case.
   */
  dispose(): void {
    if (!this.whisper) {
      this.modelLoaded = false;
      return;
    }

    // Version 0.0.4 of @napi-rs/whisper does not expose a `free()` method;
    // Rust's `Drop` trait handles native cleanup when the JS object is
    // garbage-collected.  If a future version adds `free()`, call it.
    if (typeof (this.whisper as any).free === "function") {
      (this.whisper as any).free();
    }

    this.whisper = null;
    this.modelLoaded = false;
  }

  // -- isLoaded() ----------------------------------------------------------

  /** Returns `true` if the Whisper model has been successfully loaded. */
  isLoaded(): boolean {
    return this.modelLoaded && this.whisper !== null;
  }

  // -- Private helpers -----------------------------------------------------

  /**
   * Perform the actual transcription against the native Whisper instance.
   * Called from the sequential work queue (so `this.whisper` is guaranteed
   * non-null).
   */
  private _doTranscribe(audio: Float32Array): STTResult {
    if (!this.whisper) {
      throw new Error(
        "Whisper model is not loaded.  Ensure `init()` completed " +
          "successfully before calling `transcribe()`.",
      );
    }

    try {
      const params = new WhisperFullParams(WhisperSamplingStrategy.Greedy);

      // Language configuration
      if (this.language === "auto") {
        params.language = "";
        params.detectLanguage = true;
      } else {
        params.language = this.language;
        params.detectLanguage = false;
      }

      // Behavioural knobs
      params.printProgress = false;
      params.printRealtime = false;
      params.printTimestamps = false;
      params.printSpecial = false;
      params.singleSegment = false;
      params.noTimestamps = false;
      params.tokenTimestamps = false;
      params.maxLen = 0;
      params.maxTokens = 0;
      params.translate = false;
      params.splitOnWord = true;
      params.suppressBlank = false;
      params.temperature = 0;

      // Concurrency hint — keep it modest so other processes aren't starved.
      const availableCores =
        typeof navigator !== "undefined"
          ? navigator.hardwareConcurrency
          : 4;
      params.nThreads = Math.min(4, Math.max(1, availableCores));

      // Capture per-segment output via the callback.
      // `full()` is synchronous; the callback fires *during* its execution.
      const segments: Segment[] = [];
      params.onNewSegment = (segment) => {
        segments.push(segment);
      };

      // --- Run transcription (synchronous native call) ---
      const text = this.whisper.full(params, audio);

      return {
        text: text.trim(),
        confidence: this._estimateConfidence(text, segments),
        segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Transcription failed: ${message}`);
    }
  }

  /**
   * Heuristic confidence estimate.
   *
   * `@napi-rs/whisper` v0.0.4 does not expose per-segment or per-token
   * confidence scores, so we derive an estimate from contextual signals:
   *
   * - Auto language detection slightly reduces confidence.
   * - Very short transcriptions (< 3 characters) are penalised.
   * - Multiple segments imply richer content and a small bump.
   */
  private _estimateConfidence(text: string, segments: Segment[]): number {
    if (!text || text.trim().length === 0) return 0;

    let confidence = 0.9;

    if (this.language === "auto") {
      confidence -= 0.05; // language detection adds uncertainty
    }

    if (text.length < 3) {
      confidence -= 0.1; // single-token / very short output
    }

    if (segments.length >= 2) {
      confidence += 0.02; // multi-segment transcription is generally more reliable
    }

    return Math.max(0, Math.min(1, confidence));
  }
}

// ---------------------------------------------------------------------------
// downloadWhisperModel()
// ---------------------------------------------------------------------------

/**
 * Download a Whisper model binary from HuggingFace.
 *
 * @param variant  Model variant (`"tiny"`, `"base"`, or `"small"`).
 * @param outputDir  Directory inside which the model will be saved under
 *                   `models/ggml-{variant}.bin`.
 * @returns Absolute path to the downloaded model file.
 *
 * @example
 * ```ts
 * const modelPath = await downloadWhisperModel("tiny", ".");
 * // => "./models/ggml-tiny.bin"
 * ```
 */
export async function downloadWhisperModel(
  variant: ModelVariant | string,
  outputDir: string,
): Promise<string> {
  const url = MODEL_URLS[variant as ModelVariant];
  if (!url) {
    const supported = Object.keys(MODEL_URLS).join(", ");
    throw new Error(
      `Unknown model variant "${variant}". Supported variants: ${supported}. ` +
        `Run \`npx download-whisper-model\` to list all available models.`,
    );
  }

  const fs = await import("node:fs");
  const path = await import("node:path");

  const fileName = `ggml-${variant}.bin`;
  const fullPath = path.join(outputDir, "models", fileName);

  // Ensure output directory exists.
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  // Skip if already downloaded.
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    console.log(
      `Model "${variant}" already exists at ${fullPath} (${sizeMB} MB). Skipping download.`,
    );
    return fullPath;
  }

  console.log(`Downloading ${variant} model from HuggingFace …`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download model: HTTP ${response.status} ${response.statusText}. ` +
        `URL: ${url}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  let downloadedBytes = 0;

  // Stream the fetch response body to disk, with optional progress display.
  // We use the Web ReadableStream's getReader() to avoid mixing Node/
  // Web stream APIs (which causes TypeScript type errors).
  const reader = response.body!.getReader();
  const fileStream = fs.createWriteStream(fullPath);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    downloadedBytes += value!.byteLength;

    // Progress reporting (only when we know total size).
    if (totalBytes > 0) {
      const pct = ((downloadedBytes / totalBytes) * 100).toFixed(0);
      const downMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
      const totMB = (totalBytes / (1024 * 1024)).toFixed(1);
      process.stdout.write(`\r  ${downMB}/${totMB} MB (${pct}%)  `);
    }

    // Write chunk, handling backpressure.
    const ok = fileStream.write(Buffer.from(value!));
    if (!ok) {
      await new Promise<void>((resolve) => {
        fileStream.once("drain", resolve);
      });
    }
  }

  fileStream.end();
  await new Promise<void>((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });

  if (totalBytes > 0) {
    process.stdout.write("\n");
  }

  const stat = fs.statSync(fullPath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  console.log(`Download complete: ${fullPath} (${sizeMB} MB)`);
  return fullPath;
}
