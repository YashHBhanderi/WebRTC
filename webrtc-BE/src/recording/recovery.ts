import fs from "fs";
import os from "os";
import path from "path";
import { recordingConfig } from "../config/recording";
import { probe, runFfmpeg } from "./composer";

/**
 * Interrupted-recording recovery and temporary-file hygiene.
 *
 * Track files are written with bounded Matroska clusters (track-capture.ts), so a crash loses at
 * most about a second per track. After a restart, each readable partial track is remuxed (stream
 * copy, no re-encode) and the recording continues through the normal compose → upload → transcribe
 * pipeline, marked as partial. Nothing here deletes a file of an active or unverified recording.
 *
 *   RECORDING_TMP_RETENTION_HOURS  keep temp folders of finished / failed recordings this long (default 24)
 *   RECORDING_MIN_FREE_MB          refuse to start (and stop live recordings) below this free space (default 2048)
 */

/** Stable per host + temp directory: a restarted process recognises its own interrupted recordings. */
export function recordingHost(): string {
    return `${os.hostname()}|${path.resolve(recordingConfig.tmpDir)}`;
}

export interface LiveTrackInfo {
    producerId: string;
    userId: string;
    kind: "audio" | "video";
    source: "camera" | "screen";
    file: string;
    /** When the capture was started (wall clock); the file's time 0 is its first packet, shortly after */
    captureStartedAt: Date;
}

export interface RecoveredTrack {
    userId: string;
    kind: "audio" | "video";
    source: "camera" | "screen";
    startOffset: number;
    endOffset: number;
    file: string;
}

export interface RecoveryPlan {
    tracks: RecoveredTrack[];
    duration: number;
    audio: boolean;
    video: boolean;
    /** Track files that existed but held nothing readable */
    unreadable: number;
    /** Track files that were missing */
    missing: number;
}

// FFmpeg opens its ports ~0.7 s after the capture starts; the first packet follows. Recovered tracks are
// aligned on this estimate (the exact first-packet time was only known in the lost process).
const CAPTURE_LEAD_SECONDS = 0.7;

/** Remux each readable partial track and work out where it sits on the recording's timeline. */
export async function planRecovery(startedAt: Date, liveTracks: LiveTrackInfo[], tmpOut: (t: LiveTrackInfo) => string = (t) => t.file.replace(/(\.\w+)$/, ".recovered$1")): Promise<RecoveryPlan> {
    const plan: RecoveryPlan = { tracks: [], duration: 0, audio: false, video: false, unreadable: 0, missing: 0 };
    for (const t of liveTracks) {
        if (!fs.existsSync(t.file)) { plan.missing++; continue; }
        if (fs.statSync(t.file).size === 0) { plan.unreadable++; continue; }
        const out = tmpOut(t);
        try {
            // Idempotent: a previous attempt's output is simply overwritten
            await runFfmpeg(["-y", "-i", t.file, "-map", "0", "-c", "copy", out]);
        } catch {
            // FFmpeg reports an error for a truncated last cluster but usually still writes what it read
        }
        const info = fs.existsSync(out) ? await probe(out).catch(() => null) : null;
        if (!info || info.duration < 0.5 || !(t.kind === "audio" ? info.hasAudio : info.hasVideo)) {
            plan.unreadable++;
            continue;
        }
        const startOffset = Math.max(0, (t.captureStartedAt.getTime() - startedAt.getTime()) / 1000 + CAPTURE_LEAD_SECONDS);
        const endOffset = startOffset + info.duration;
        plan.tracks.push({ userId: t.userId, kind: t.kind, source: t.source, startOffset, endOffset, file: out });
        plan.duration = Math.max(plan.duration, endOffset);
        if (t.kind === "audio") plan.audio = true; else plan.video = true;
    }
    return plan;
}

/** User-facing description of what a recovery produced (never a path or internal detail). */
export function recoveryNote(plan: RecoveryPlan): string {
    if (!plan.tracks.length) return "The recording was interrupted by a server restart and nothing could be recovered.";
    const what = plan.audio && plan.video ? "audio and video" : plan.audio ? "audio only (no video could be recovered)" : "video only (no audio could be recovered)";
    return `The recording was interrupted by a server restart. Recovered ${what}, about ${Math.round(plan.duration)} s; the last moments before the restart may be missing.`;
}

export function retentionMs(env: NodeJS.ProcessEnv = process.env): number {
    const h = Number(env.RECORDING_TMP_RETENTION_HOURS);
    return (Number.isFinite(h) && h > 0 ? h : 24) * 3600_000;
}

export function minFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
    const mb = Number(env.RECORDING_MIN_FREE_MB);
    return (Number.isFinite(mb) && mb >= 0 ? mb : 2048) * 1024 * 1024;
}

/** Free bytes on the temp directory's volume, or null if the platform cannot tell. */
export async function freeBytes(dir = recordingConfig.tmpDir): Promise<number | null> {
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        const s = await fs.promises.statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;
    }
}

const ACTIVE = new Set(["recording", "recovering", "processing"]);

/**
 * Temp folders that may be deleted: no recording record at all, or a finished / failed one — and
 * untouched for the retention period. Active statuses are never deleted, whatever their age.
 */
export async function staleTempDirs(
    statusOf: (recordingIds: string[]) => Promise<Map<string, string>>,
    liveIds: Set<string>,
    now = Date.now(),
    dir = recordingConfig.tmpDir,
    keepMs = retentionMs(),
): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const candidates = entries.filter((e) => e.isDirectory() && /^[0-9a-f]{24}$/.test(e.name) && !liveIds.has(e.name)).map((e) => e.name);
    if (!candidates.length) return [];
    const statuses = await statusOf(candidates);
    const out: string[] = [];
    for (const id of candidates) {
        const status = statuses.get(id);
        if (status && ACTIVE.has(status)) continue;
        const full = path.join(dir, id);
        const newest = await newestMtime(full);
        if (now - newest >= keepMs) out.push(full);
    }
    return out;
}

async function newestMtime(dir: string): Promise<number> {
    let newest = (await fs.promises.stat(dir)).mtimeMs;
    for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
        const st = await fs.promises.stat(path.join(dir, f)).catch(() => null);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return newest;
}
