import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { transcriptionConfig } from "../config/recording";

export interface SpeechSegment {
    /** Seconds from the start of the audio file */
    start: number;
    end: number;
    text: string;
}

/** Speech-to-text behind one boundary, so the engine can be replaced without touching callers. */
export interface TranscriptionProvider {
    readonly name: string;
    /** Whether the engine and a model are installed */
    available(): Promise<boolean>;
    /** One result list per input WAV (16 kHz mono), in the same order */
    transcribe(wavFiles: string[]): Promise<SpeechSegment[][]>;
}

/**
 * ggml models in order of preference (most accurate first) with the memory whisper.cpp needs to
 * run them on CPU (model + working buffers, with headroom). The first one installed that fits the
 * memory budget is used.
 */
const MODELS: { file: string; memoryMb: number }[] = [
    { file: "ggml-large-v3.bin", memoryMb: 4700 },
    { file: "ggml-large-v3-q8_0.bin", memoryMb: 2600 },
    { file: "ggml-large-v3-q5_0.bin", memoryMb: 1900 },
    { file: "ggml-large-v3-turbo.bin", memoryMb: 2200 },
    { file: "ggml-large-v3-turbo-q8_0.bin", memoryMb: 1400 },
    { file: "ggml-large-v3-turbo-q5_0.bin", memoryMb: 1100 },
    { file: "ggml-medium.bin", memoryMb: 2600 },
    { file: "ggml-medium-q5_0.bin", memoryMb: 1200 },
    { file: "ggml-small.bin", memoryMb: 1100 },
    { file: "ggml-base.bin", memoryMb: 500 },
];

/** Explicit WHISPER_MODEL, else the best installed model within the memory budget. */
function selectModel(): string | null {
    if (transcriptionConfig.whisperModel) {
        return fs.existsSync(transcriptionConfig.whisperModel) ? transcriptionConfig.whisperModel : null;
    }
    for (const model of MODELS) {
        const file = path.join(transcriptionConfig.whisperModelDir, model.file);
        if (model.memoryMb <= transcriptionConfig.maxMemoryMb && fs.existsSync(file)) {
            return file;
        }
    }
    return null;
}

// whisper marks silence / noise like "[BLANK_AUDIO]" or "(music)"
const isNoise = (text: string) => !text || /^[[(].*[\])]$/.test(text);

/**
 * whisper.cpp (MIT licence) through its native CLI — no Python, no Node addon to compile:
 *   whisper-cli -m <model> -f <wav> -l <lang> -t <threads> -oj -of <out>
 * writes <out>.json with { transcription: [{ offsets: { from, to } (ms), text }] }.
 * Runs at low CPU priority so live calls (mediasoup) always come first.
 */
class WhisperCppProvider implements TranscriptionProvider {
    readonly name = "whisper-cpp";
    private warned = false;

    async available(): Promise<boolean> {
        const bin = fs.existsSync(transcriptionConfig.whisperBin);
        const model = selectModel();
        if ((!bin || !model) && !this.warned) {
            this.warned = true;
            console.warn(!bin
                ? `[transcription] whisper.cpp not found at ${transcriptionConfig.whisperBin} (set WHISPER_CPP_BIN)`
                : `[transcription] no whisper model fits ${transcriptionConfig.maxMemoryMb} MB in ${transcriptionConfig.whisperModelDir} (set WHISPER_MODEL or WHISPER_MAX_MEMORY_MB)`);
        }
        if (bin && model) {
            this.warned = false;
        }
        return bin && !!model;
    }

    async transcribe(wavFiles: string[]): Promise<SpeechSegment[][]> {
        const model = selectModel();
        if (!model) {
            throw new Error("No whisper model available");
        }
        console.log(`[transcription] whisper.cpp with ${path.basename(model)}, ${transcriptionConfig.threads} threads, ${wavFiles.length} file(s)`);
        const out: SpeechSegment[][] = [];
        for (const wavFile of wavFiles) {
            const outBase = wavFile.replace(/\.wav$/i, "");
            try {
                await this.run([
                    "-m", model,
                    "-f", wavFile,
                    "-l", transcriptionConfig.language,
                    "-t", String(transcriptionConfig.threads),
                    // No carried-over context: avoids whisper repeating itself over long silences
                    "-mc", "0",
                    "-np",
                    "-oj",
                    "-of", outBase,
                ]);
                const raw = JSON.parse(await fs.promises.readFile(`${outBase}.json`, "utf8"));
                const items: any[] = Array.isArray(raw?.transcription) ? raw.transcription : [];
                out.push(items
                    .map((item) => ({
                        start: Number(item?.offsets?.from) / 1000,
                        end: Number(item?.offsets?.to) / 1000,
                        text: String(item?.text || "").trim(),
                    }))
                    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && !isNoise(s.text)));
            } finally {
                await fs.promises.rm(`${outBase}.json`, { force: true }).catch(() => undefined);
            }
        }
        return out;
    }

    private run(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn(transcriptionConfig.whisperBin, args, { windowsHide: true });
            if (proc.pid) {
                try {
                    os.setPriority(proc.pid, 10);
                } catch {
                    // not permitted on this host — runs at normal priority
                }
            }
            let stderr = "";
            // Large models on CPU run slower than real time; this only guards against a hung process
            const timer = setTimeout(() => proc.kill(), 8 * 60 * 60 * 1000);
            proc.stdout.resume();
            proc.stderr.on("data", (chunk) => {
                stderr = (stderr + String(chunk)).slice(-4000);
            });
            proc.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            proc.on("close", (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`whisper.cpp exited with ${code}: ${stderr.trim()}`));
                }
            });
        });
    }
}

class NoTranscription implements TranscriptionProvider {
    readonly name = "none";
    async available(): Promise<boolean> {
        return false;
    }
    async transcribe(): Promise<SpeechSegment[][]> {
        return [];
    }
}

let provider: TranscriptionProvider | null = null;

export function transcriptionProvider(): TranscriptionProvider {
    provider ??= transcriptionConfig.provider === "whisper-cpp" ? new WhisperCppProvider() : new NoTranscription();
    return provider;
}
