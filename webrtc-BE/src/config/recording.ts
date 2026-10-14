import os from "os";
import path from "path";

/**
 * Meeting recording + transcription (free / open-source tools only).
 *
 *   RECORDING_ENABLED          "true" to allow recording (default off: FFmpeg must be installed)
 *   FFMPEG_PATH                FFmpeg binary (default "ffmpeg" on PATH)
 *   RECORDING_TMP_DIR          where raw tracks are written while recording / processing
 *                              (default <os tmp>/chat-app-recordings); needs free disk space
 *   RECORDING_PORT_MIN / MAX   local UDP ports FFmpeg listens on for captured RTP (default 51000-51999,
 *                              loopback only — no firewall change needed)
 *   RECORDING_MAX_MINUTES      safety stop for one recording (default 240)
 *   RECORDING_RETENTION_DAYS   recordings expire after this many days (default 30). Enforced by an S3
 *                              lifecycle rule applied at startup (needs s3:PutLifecycleConfiguration;
 *                              if denied, set an equivalent rule on the bucket for the recordings/ prefix)
 *   RECORDING_FPS              frame rate of the composed meeting video (default 25)
 *   RECORDING_FONT_FILE        TTF/OTF used for names / initials in the video (default: a system font)
 *
 *   TRANSCRIPTION_PROVIDER     "whisper-cpp" (default) or "none"
 *   TRANSCRIPTION_LANGUAGE     "auto" or a language code such as "en" (default "auto")
 *   TRANSCRIPTION_MAX_ATTEMPTS automatic attempts before a transcript is marked failed (default 3)
 *
 *   whisper.cpp (native, MIT licence — see scripts/install-whisper.sh):
 *   WHISPER_CPP_BIN            whisper.cpp CLI (default /opt/whisper.cpp/build/bin/whisper-cli)
 *   WHISPER_MODEL              a specific ggml model file; when unset the largest model in
 *                              WHISPER_MODEL_DIR that fits the memory budget is used
 *   WHISPER_MODEL_DIR          directory of ggml-*.bin models (default /opt/whisper.cpp/models)
 *   WHISPER_MAX_MEMORY_MB      memory whisper may use (default 60% of RAM — calls keep the rest)
 *   WHISPER_THREADS            CPU threads for transcription (default: half the cores)
 */
const int = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const recordingConfig = {
    enabled: process.env.RECORDING_ENABLED === "true",
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    tmpDir: process.env.RECORDING_TMP_DIR || path.join(os.tmpdir(), "chat-app-recordings"),
    portMin: int(process.env.RECORDING_PORT_MIN, 51000),
    portMax: int(process.env.RECORDING_PORT_MAX, 51999),
    maxMinutes: int(process.env.RECORDING_MAX_MINUTES, 240),
    retentionDays: int(process.env.RECORDING_RETENTION_DAYS, 30),
    fps: Math.min(30, int(process.env.RECORDING_FPS, 25)),
    fontFile: process.env.RECORDING_FONT_FILE || "",
};

export type TranscriptionProviderName = "whisper-cpp" | "none";

export const transcriptionConfig = {
    provider: ((process.env.TRANSCRIPTION_PROVIDER || "").trim().toLowerCase() === "none" ? "none" : "whisper-cpp") as TranscriptionProviderName,
    language: process.env.TRANSCRIPTION_LANGUAGE || "auto",
    maxAttempts: int(process.env.TRANSCRIPTION_MAX_ATTEMPTS, 3),
    threads: int(process.env.WHISPER_THREADS, Math.max(1, Math.floor(os.cpus().length / 2))),
    whisperBin: process.env.WHISPER_CPP_BIN || "/opt/whisper.cpp/build/bin/whisper-cli",
    whisperModel: process.env.WHISPER_MODEL || "",
    whisperModelDir: process.env.WHISPER_MODEL_DIR || "/opt/whisper.cpp/models",
    maxMemoryMb: int(process.env.WHISPER_MAX_MEMORY_MB, Math.floor((os.totalmem() / 1024 / 1024) * 0.6)),
};
