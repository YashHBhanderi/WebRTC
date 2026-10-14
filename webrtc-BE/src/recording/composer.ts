import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { recordingConfig } from "../config/recording";

export interface ComposeTrack {
    file: string;
    kind: "audio" | "video";
    source: "camera" | "screen";
    userId: string;
    /** Seconds from recording start of the track's first packet (its file time 0) */
    start: number;
    /** Seconds from recording start */
    end: number;
}

export interface ComposeEvent {
    at: number;
    userId: string;
    type: "join" | "leave" | "media";
    audio?: boolean | null;
    video?: boolean | null;
}

export interface ComposeInput {
    /** Working directory: holds the tracks; intermediate files are written here */
    dir: string;
    duration: number;
    tracks: ComposeTrack[];
    events: ComposeEvent[];
    names: Map<string, string>;
}

export interface SpeechRange {
    userId: string;
    start: number;
    end: number;
}

export interface ComposeResult {
    duration: number;
    hasAudio: boolean;
    speech: SpeechRange[];
}

type Interval = [number, number];

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface UsableTrack extends ComposeTrack {
    /** First timestamp in the file (≈ 0) */
    fileStart: number;
}

interface Person {
    userId: string;
    name: string;
    order: number;
    nameFile: string;
    initialsFile: string;
    colors: { bg: string; fg: string };
    presence: Interval[];
    cameras: { track: UsableTrack; on: Interval[] }[];
    muted: Interval[];
    speaking: Interval[];
}

interface Segment {
    f0: number;
    f1: number;
    people: Person[];
    screen: { track: UsableTrack; range: Interval; presenter: Person | null } | null;
    key: string;
}

const W = 1280;
const H = 720;
const PAD = 16;
const GAP = 8;
const MAX_GALLERY = 16;
const STRIP_W = 240;
const STRIP_H = 136;
const EPS = 0.02;

const COLOR_BG = "0x1f1f23";
const COLOR_TILE = "0x2d2d33";
const COLOR_SPEAKING = "0x7f85f5";
const COLOR_MUTED = "0xc4314b";

// Same palette / hash as the app's generated avatars (webrtc-FE avatar.util.ts)
const PALETTE = [
    { bg: "#dbeafe", fg: "#1e40af" },
    { bg: "#dcfce7", fg: "#166534" },
    { bg: "#fef3c7", fg: "#92400e" },
    { bg: "#fce7f3", fg: "#9d174d" },
    { bg: "#ede9fe", fg: "#5b21b6" },
    { bg: "#ffedd5", fg: "#9a3412" },
    { bg: "#cffafe", fg: "#155e75" },
    { bg: "#fee2e2", fg: "#991b1b" },
    { bg: "#e0e7ff", fg: "#3730a3" },
    { bg: "#ccfbf1", fg: "#115e59" },
];

function avatarColors(name: string): { bg: string; fg: string } {
    const key = name.trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
}

const LETTER = new RegExp("[\\p{L}\\p{N}]", "u");

function avatarInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const first = (w: string | undefined) => (w ? Array.from(w).find((ch) => LETTER.test(ch)) || "" : "");
    const letters = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
    return letters.toUpperCase() || "?";
}

// ---------------------------------------------------------------- FFmpeg helpers

interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

const MAX_KEPT_OUTPUT = 20 * 1024 * 1024;

function run(args: string[], options: { cwd?: string; keepOutput?: boolean } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const proc = spawn(recordingConfig.ffmpegPath, args, { cwd: options.cwd, windowsHide: true });
        let stdout = "";
        let stderr = "";
        const add = (current: string, chunk: Buffer) => {
            const next = current + String(chunk);
            return options.keepOutput ? next.slice(-MAX_KEPT_OUTPUT) : next.slice(-4000);
        };
        proc.stdout.on("data", (chunk) => (stdout = add(stdout, chunk)));
        proc.stderr.on("data", (chunk) => (stderr = add(stderr, chunk)));
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });
}

/** Run FFmpeg; resolves on exit 0, rejects with the tail of stderr otherwise. */
export async function runFfmpeg(args: string[], cwd?: string): Promise<void> {
    const result = await run(["-hide_banner", "-nostdin", "-loglevel", "error", ...args], { cwd });
    if (result.code !== 0) {
        throw new Error(`ffmpeg exited with ${result.code}: ${result.stderr.trim()}`);
    }
}

interface Capabilities {
    major: number;
    drawtext: boolean;
}

let capabilitiesPromise: Promise<Capabilities> | null = null;

function capabilities(): Promise<Capabilities> {
    capabilitiesPromise ??= (async () => {
        const version = await run(["-hide_banner", "-version"], { keepOutput: true }).catch(() => null);
        const filters = await run(["-hide_banner", "-filters"], { keepOutput: true }).catch(() => null);
        // Git builds report a date instead of a number — those are the newest
        const match = /ffmpeg version\s+n?(\d+)\./i.exec(version?.stdout || "");
        return { major: match ? Number(match[1]) : 99, drawtext: /\bdrawtext\b/.test(filters?.stdout || "") };
    })();
    return capabilitiesPromise;
}

/** `-/filter_complex file` (FFmpeg 7+) or the older `-filter_complex_script file`. */
function graphArgs(caps: Capabilities, file: string): string[] {
    return caps.major >= 7 ? ["-/filter_complex", file] : ["-filter_complex_script", file];
}

function findFont(): string | null {
    const windows = process.env.WINDIR || "C:\\Windows";
    const candidates = [
        recordingConfig.fontFile,
        path.join(windows, "Fonts", "segoeui.ttf"),
        path.join(windows, "Fonts", "arial.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ];
    return candidates.find((file) => !!file && fs.existsSync(file)) || null;
}

interface ProbeInfo {
    duration: number;
    start: number;
    hasVideo: boolean;
    hasAudio: boolean;
}

/** Container facts from FFmpeg's own header dump (no ffprobe needed). */
async function probe(file: string): Promise<ProbeInfo> {
    const { stderr } = await run(["-hide_banner", "-nostdin", "-i", file], { keepOutput: true });
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const start = /start:\s*(-?\d+(?:\.\d+)?)/.exec(stderr);
    return {
        duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
        start: start ? Number(start[1]) : 0,
        hasVideo: /Stream #\d+:\d+[^\n]*: Video:/.test(stderr),
        hasAudio: /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr),
    };
}

async function maxVolume(file: string): Promise<number | null> {
    const { code, stderr } = await run(
        ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"],
        { keepOutput: true },
    );
    const match = /max_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB/.exec(stderr);
    if (code !== 0 || !match) {
        return null;
    }
    return match[1] === "-inf" ? -Infinity : Number(match[1]);
}

/** Speech in an audio track (silencedetect), in recording time. */
async function detectSpeech(track: UsableTrack): Promise<Interval[]> {
    const length = track.end - track.start;
    const { code, stderr } = await run(
        ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-i", track.file, "-vn", "-af", "silencedetect=noise=-38dB:d=0.6", "-f", "null", "-"],
        { keepOutput: true },
    );
    if (code !== 0) {
        return [];
    }
    const silences: Interval[] = [];
    let open: number | null = null;
    const pattern = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stderr))) {
        const t = Number(m[2]) - track.fileStart;
        if (m[1] === "start") {
            open = Math.max(0, t);
        } else {
            silences.push([open ?? 0, t]);
            open = null;
        }
    }
    if (open !== null) {
        silences.push([open, length]);
    }
    return subtract([[0, length]], silences)
        .filter(([a, b]) => b - a >= 0.3)
        .map(([a, b]) => [a + track.start, b + track.start] as Interval);
}

/** Whether a file holds audible sound (peak above the noise floor of an idle microphone). */
export async function isAudible(file: string, thresholdDb = -45): Promise<boolean> {
    const peak = await maxVolume(file);
    return peak !== null && peak > thresholdDb;
}

/** 16 kHz mono WAV for speech recognition. */
export function extractSpeech(file: string, output: string): Promise<void> {
    return runFfmpeg(["-i", file, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", output]);
}

// ---------------------------------------------------------------- interval maths

function normalize(list: Interval[]): Interval[] {
    const sorted = list.filter(([a, b]) => b - a > EPS).map(([a, b]) => [a, b] as Interval).sort((x, y) => x[0] - y[0]);
    const out: Interval[] = [];
    for (const [a, b] of sorted) {
        const last = out[out.length - 1];
        if (last && a <= last[1] + EPS) {
            last[1] = Math.max(last[1], b);
        } else {
            out.push([a, b]);
        }
    }
    return out;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
    const out: Interval[] = [];
    for (const [a0, a1] of a) {
        for (const [b0, b1] of b) {
            const s = Math.max(a0, b0);
            const e = Math.min(a1, b1);
            if (e - s > EPS) {
                out.push([s, e]);
            }
        }
    }
    return normalize(out);
}

function subtract(a: Interval[], b: Interval[]): Interval[] {
    let rest = normalize(a);
    for (const [b0, b1] of normalize(b)) {
        const next: Interval[] = [];
        for (const [a0, a1] of rest) {
            if (b1 <= a0 || b0 >= a1) {
                next.push([a0, a1]);
                continue;
            }
            if (b0 > a0) {
                next.push([a0, b0]);
            }
            if (b1 < a1) {
                next.push([b1, a1]);
            }
        }
        rest = next;
    }
    return normalize(rest);
}

const covers = (list: Interval[], t: number) => list.some(([a, b]) => a <= t && t < b);

/** When a mic / camera flag was on, from the participants' media-state announcements (default on). */
function flagIntervals(events: ComposeEvent[], userId: string, key: "audio" | "video", end: number): Interval[] {
    const changes = events
        .filter((e) => e.userId === userId && e.type === "media" && typeof e[key] === "boolean")
        .sort((x, y) => x.at - y.at);
    const out: Interval[] = [];
    let on = true;
    let since = 0;
    for (const e of changes) {
        const value = e[key] as boolean;
        if (value === on) {
            continue;
        }
        if (on) {
            out.push([since, e.at]);
        }
        on = value;
        since = e.at;
    }
    if (on) {
        out.push([since, end]);
    }
    return normalize(out);
}

function presenceIntervals(events: ComposeEvent[], userId: string, end: number): Interval[] {
    const changes = events.filter((e) => e.userId === userId && (e.type === "join" || e.type === "leave")).sort((x, y) => x.at - y.at);
    const out: Interval[] = [];
    let joinedAt: number | null = null;
    changes.forEach((e, i) => {
        if (e.type === "join" && joinedAt === null) {
            joinedAt = e.at;
        } else if (e.type === "leave") {
            if (joinedAt !== null) {
                out.push([joinedAt, e.at]);
            } else if (i === 0) {
                // Was already in the meeting when recording began
                out.push([0, e.at]);
            }
            joinedAt = null;
        }
    });
    if (joinedAt !== null) {
        out.push([joinedAt, end]);
    }
    return out;
}

// ---------------------------------------------------------------- layout

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

/** Teams-like gallery: equal 16:9 tiles, rows centred. */
function galleryRects(n: number): Rect[] {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cellW = (W - 2 * PAD - (cols - 1) * GAP) / cols;
    const cellH = (H - 2 * PAD - (rows - 1) * GAP) / rows;
    let tw = cellW;
    let th = (cellW * 9) / 16;
    if (th > cellH) {
        th = cellH;
        tw = (th * 16) / 9;
    }
    tw = even(tw);
    th = even(th);
    const blockH = rows * th + (rows - 1) * GAP;
    const y0 = (H - blockH) / 2;
    const rects: Rect[] = [];
    for (let r = 0; r < rows; r++) {
        const count = Math.min(cols, n - r * cols);
        const rowW = count * tw + (count - 1) * GAP;
        const x0 = (W - rowW) / 2;
        for (let c = 0; c < count; c++) {
            rects.push({ x: even(x0 + c * (tw + GAP)), y: even(y0 + r * (th + GAP)), w: tw, h: th });
        }
    }
    return rects;
}

/** Presenting: the shared screen large on the left, participants in a strip on the right. */
function screenLayout(n: number): { screen: Rect; tiles: Rect[] } {
    if (!n) {
        return { screen: { x: PAD, y: PAD, w: even(W - 2 * PAD), h: even(H - 2 * PAD) }, tiles: [] };
    }
    const screen = { x: PAD, y: PAD, w: even(W - 2 * PAD - GAP - STRIP_W), h: even(H - 2 * PAD) };
    const max = Math.floor((H - 2 * PAD + GAP) / (STRIP_H + GAP));
    const count = Math.min(n, max);
    const blockH = count * STRIP_H + (count - 1) * GAP;
    const y0 = (H - blockH) / 2;
    const tiles = Array.from({ length: count }, (_, i) => ({ x: W - PAD - STRIP_W, y: even(y0 + i * (STRIP_H + GAP)), w: STRIP_W, h: STRIP_H }));
    return { screen, tiles };
}

/** Tiles to draw: everyone that fits, the rest summarised as "+N". */
function placeTiles(people: Person[], rects: (n: number) => Rect[], max: number): { person: Person | null; overflow: number; rect: Rect }[] {
    const shown = people.length > max ? people.slice(0, max - 1) : people;
    const overflow = people.length - shown.length;
    const slots = rects(shown.length + (overflow ? 1 : 0));
    const tiles: { person: Person | null; overflow: number; rect: Rect }[] = shown.map((person, i) => ({ person, overflow: 0, rect: slots[i] }));
    if (overflow && slots[shown.length]) {
        tiles.push({ person: null, overflow, rect: slots[shown.length] });
    }
    return tiles.filter((t) => !!t.rect);
}

// ---------------------------------------------------------------- rendering

interface RenderContext {
    dir: string;
    fps: number;
    caps: Capabilities;
    text: boolean;
}

function rgb(hex: string): [number, number, number] {
    const v = hex.replace("#", "");
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** One layout segment (who is on screen doesn't change) → seg_k.mp4, video only. */
async function renderSegment(ctx: RenderContext, seg: Segment, index: number): Promise<string> {
    const { fps } = ctx;
    const a = seg.f0 / fps;
    const b = seg.f1 / fps;
    const frames = seg.f1 - seg.f0;
    const dur = frames / fps;
    const inputs: string[] = [];
    const filters: string[] = [];
    let inputCount = 0;
    let step = 0;
    let cur = "base";

    filters.push(`color=c=${COLOR_BG}:s=${W}x${H}:r=${fps}:d=${(dur + 1).toFixed(3)},format=yuv420p[base]`);
    const chain = (filter: string) => {
        const next = `v${++step}`;
        filters.push(`[${cur}]${filter}[${next}]`);
        cur = next;
    };
    const overlay = (src: string, x: number, y: number, extra: string) => {
        const next = `v${++step}`;
        filters.push(`[${cur}][${src}]overlay=x=${x}:y=${y}:${extra}[${next}]`);
        cur = next;
    };
    // Segment-relative intervals → timeline expression for `enable`
    const local = (list: Interval[]) => intersect(list, [[a, b]]).map(([s, e]) => [s - a, e - a] as Interval);
    const enableExpr = (list: Interval[]) => list.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join("+");
    const label = (file: string, size: number, color: string) =>
        `drawtext=fontfile=font.ttf:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${color}`;

    /** A video track positioned on this segment's timeline (seeked, read only as far as needed). */
    const videoInput = (track: UsableTrack, prepare: string): string => {
        const seek = a - track.start - track.fileStart;
        const args = ["-reinit_filter", "0"];
        let offset: number;
        let readFrom: number;
        if (seek > 0.05) {
            args.push("-ss", seek.toFixed(3));
            offset = 0;
            readFrom = a;
        } else {
            offset = track.fileStart + track.start - a;
            readFrom = track.start + track.fileStart;
        }
        args.push("-t", (Math.max(0.5, b - readFrom) + 2).toFixed(3), "-i", track.file);
        inputs.push(...args);
        const idx = inputCount++;
        const out = `in${idx}`;
        filters.push(`[${idx}:v]setpts=PTS+${offset.toFixed(3)}/TB,${prepare}[${out}]`);
        return out;
    };

    // Shared screen
    let tiles: { person: Person | null; overflow: number; rect: Rect }[];
    if (seg.screen) {
        const layout = screenLayout(seg.people.length);
        const s = layout.screen;
        chain(`drawbox=x=${s.x}:y=${s.y}:w=${s.w}:h=${s.h}:color=black:t=fill`);
        const visible = local(intersect([seg.screen.range], [[seg.screen.track.start, seg.screen.track.end]]));
        if (visible.length) {
            const src = videoInput(
                seg.screen.track,
                `scale=${s.w}:${s.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=w=${s.w}:h=${s.h}:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1`,
            );
            overlay(src, s.x, s.y, `eof_action=pass:enable='${enableExpr(visible)}'`);
        }
        if (ctx.text && seg.screen.presenter) {
            chain(`${label(`present_${seg.screen.presenter.order}.txt`, 18, "white")}:box=1:boxcolor=0x000000@0.55:boxborderw=8:x=${s.x + 12}:y=${s.y + 12}`);
        }
        const presenter = seg.screen.presenter;
        const people = presenter && seg.people.includes(presenter)
            ? [presenter, ...seg.people.filter((p) => p !== presenter)]
            : seg.people;
        tiles = placeTiles(people, (n) => screenLayout(n).tiles, layout.tiles.length);
    } else {
        tiles = seg.people.length ? placeTiles(seg.people, galleryRects, MAX_GALLERY) : [];
    }

    for (const tile of tiles) {
        const { x, y, w, h } = tile.rect;
        chain(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${COLOR_TILE}:t=fill`);
        if (!tile.person) {
            if (ctx.text) {
                chain(`drawtext=fontfile=font.ttf:text=+${tile.overflow}:fontsize=${Math.round(h * 0.25)}:fontcolor=white:x=${x + w / 2}-tw/2:y=${y + h / 2}-th/2`);
            }
            continue;
        }
        const p = tile.person;

        // Avatar circle with initials (visible whenever the camera is off)
        const d = even(Math.min(w, h) * 0.46);
        const [r, g, bl] = rgb(p.colors.bg);
        const c = ((d - 1) / 2).toFixed(1);
        const avatar = `av${++step}`;
        let avatarChain = `color=c=black@0.0:s=${d}x${d}:r=1:d=1,format=rgba,` +
            `geq=r=${r}:g=${g}:b=${bl}:a='if(lte(hypot(X-${c},Y-${c}),${(d / 2).toFixed(1)}),255,0)'`;
        if (ctx.text) {
            avatarChain += `,${label(p.initialsFile, Math.round(d * 0.38), p.colors.fg.replace("#", "0x"))}:x=(w-tw)/2:y=(h-th)/2`;
        }
        filters.push(`${avatarChain}[${avatar}]`);
        overlay(avatar, even(x + (w - d) / 2), even(y + (h - d) / 2), "eof_action=repeat");

        // Camera, only while it was on
        for (const cam of p.cameras) {
            const on = local(cam.on);
            if (!on.length) {
                continue;
            }
            const src = videoInput(cam.track, `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`);
            overlay(src, x, y, `eof_action=pass:enable='${enableExpr(on)}'`);
        }

        const speaking = local(p.speaking);
        if (speaking.length) {
            chain(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${COLOR_SPEAKING}:t=4:enable='${enableExpr(speaking)}'`);
        }
        const muted = local(p.muted);
        const fontSize = Math.max(12, Math.min(22, Math.round(h * 0.075)));
        if (ctx.text) {
            chain(`${label(p.nameFile, fontSize, "white")}:box=1:boxcolor=0x000000@0.55:boxborderw=6:x=${x + 10}:y=${y + h - 10}-th`);
            if (muted.length) {
                chain(`drawtext=fontfile=font.ttf:text=Muted:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=${COLOR_MUTED}@0.9:boxborderw=5:` +
                    `x=${x + w - 10}-tw:y=${y + 10}:enable='${enableExpr(muted)}'`);
            }
        } else if (muted.length) {
            chain(`drawbox=x=${x + w - 28}:y=${y + 10}:w=18:h=18:color=${COLOR_MUTED}@0.95:t=fill:enable='${enableExpr(muted)}'`);
        }
    }

    const graphFile = `seg_${index}.txt`;
    const outFile = `seg_${index}.mp4`;
    await fs.promises.writeFile(path.join(ctx.dir, graphFile), filters.join(";\n"), "utf8");
    await runFfmpeg([
        ...inputs,
        ...graphArgs(ctx.caps, graphFile),
        "-map", `[${cur}]`,
        "-frames:v", String(frames),
        "-r", String(fps),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-g", String(fps * 2),
        "-an",
        "-video_track_timescale", "90000",
        "-y", outFile,
    ], ctx.dir);
    return outFile;
}

/**
 * One MP4 (H.264 + AAC) that looks like the meeting did:
 *  - gallery of everyone present (tiles reflow as people join / leave), camera when it was on,
 *    otherwise their avatar; name label, "Muted" badge and an active-speaker border;
 *  - while someone presents: the screen large with the participants in a strip beside it;
 *  - audio: every captured stream (microphones, screen audio) placed at its real time and mixed.
 * Segments are rendered separately on one frame grid and joined, so memory stays bounded and
 * video never drifts from the audio. The result is validated before it is accepted.
 */
export async function composeRecording(input: ComposeInput, output: string): Promise<ComposeResult> {
    const fps = recordingConfig.fps;
    const totalFrames = Math.max(1, Math.round(input.duration * fps));
    const total = totalFrames / fps;
    const caps = await capabilities();

    const usable: UsableTrack[] = [];
    for (const t of input.tracks) {
        const stat = await fs.promises.stat(t.file).catch(() => null);
        if (!stat || stat.size < 1024 || t.end - t.start < 0.2) {
            continue;
        }
        const info = await probe(t.file).catch(() => null);
        if (!info || (t.kind === "video" ? !info.hasVideo : !info.hasAudio)) {
            console.warn(`[recording] skipping unreadable ${t.kind} track ${path.basename(t.file)}`);
            continue;
        }
        usable.push({ ...t, start: Math.max(0, t.start), end: Math.min(t.end, total), fileStart: info.start });
    }
    if (!usable.length) {
        throw new Error("Nothing was captured");
    }
    const audioTracks = usable.filter((t) => t.kind === "audio");
    const screenTracks = usable.filter((t) => t.kind === "video" && t.source === "screen").sort((x, y) => x.start - y.start);

    // ---- who was there, and what their mic / camera did
    const userIds = [...new Set([...input.events.map((e) => e.userId), ...usable.map((t) => t.userId)])];
    const people: Person[] = [];
    const speech: SpeechRange[] = [];
    for (const userId of userIds) {
        const own = usable.filter((t) => t.userId === userId);
        const presence = intersect(
            normalize([...presenceIntervals(input.events, userId, total), ...own.map((t) => [t.start, t.end] as Interval)]),
            [[0, total]],
        );
        if (!presence.length) {
            continue;
        }
        const name = input.names.get(userId) || `Speaker ${people.length + 1}`;
        const videoOn = flagIntervals(input.events, userId, "video", total);
        const audioOn = flagIntervals(input.events, userId, "audio", total);
        const mics = own.filter((t) => t.kind === "audio");
        const live = intersect(normalize(mics.map((t) => [t.start, t.end] as Interval)), audioOn);
        const speaking: Interval[] = [];
        for (const mic of mics) {
            speaking.push(...(await detectSpeech(mic)));
        }
        const spoke = intersect(normalize(speaking), live);
        spoke.forEach(([start, end]) => speech.push({ userId, start, end }));
        people.push({
            userId,
            name,
            order: people.length,
            nameFile: `name_${people.length}.txt`,
            initialsFile: `ini_${people.length}.txt`,
            colors: avatarColors(name),
            presence,
            cameras: own
                .filter((t) => t.kind === "video" && t.source === "camera")
                .map((track) => ({ track, on: intersect([[track.start, track.end]], videoOn) })),
            muted: subtract(presence, live),
            speaking: spoke,
        });
    }
    people.sort((x, y) => x.presence[0][0] - y.presence[0][0] || x.name.localeCompare(y.name));

    const screens = screenTracks.map((track) => ({
        track,
        range: [track.start, track.end] as Interval,
        presenter: people.find((p) => p.userId === track.userId) || null,
    }));
    for (let i = 0; i < screens.length - 1; i++) {
        screens[i].range[1] = Math.min(screens[i].range[1], screens[i + 1].range[0]);
    }

    // ---- labels / font in the working dir (FFmpeg runs there, so the graph has no OS paths)
    const font = caps.drawtext ? findFont() : null;
    const text = !!font;
    if (font) {
        await fs.promises.copyFile(font, path.join(input.dir, "font.ttf"));
        for (const p of people) {
            await fs.promises.writeFile(path.join(input.dir, p.nameFile), p.name.replace(/[\r\n]+/g, " "), "utf8");
            await fs.promises.writeFile(path.join(input.dir, p.initialsFile), avatarInitials(p.name), "utf8");
            await fs.promises.writeFile(path.join(input.dir, `present_${p.order}.txt`), `${p.name.replace(/[\r\n]+/g, " ")} is presenting`, "utf8");
        }
    } else {
        console.warn("[recording] FFmpeg drawtext or a font is unavailable — the video is composed without names (set RECORDING_FONT_FILE)");
    }

    // ---- layout segments on the frame grid
    const cuts = new Set<number>([0, totalFrames]);
    const addCut = (t: number) => cuts.add(Math.min(totalFrames, Math.max(0, Math.round(t * fps))));
    people.forEach((p) => p.presence.forEach(([s, e]) => { addCut(s); addCut(e); }));
    screens.forEach((s) => { addCut(s.range[0]); addCut(s.range[1]); });
    const grid = [...cuts].sort((x, y) => x - y);
    const segments: Segment[] = [];
    for (let i = 0; i < grid.length - 1; i++) {
        const f0 = grid[i];
        const f1 = grid[i + 1];
        if (f1 <= f0) {
            continue;
        }
        const mid = (f0 + f1) / 2 / fps;
        const present = people.filter((p) => covers(p.presence, mid));
        const screen = screens.find((s) => covers([s.range], mid)) || null;
        const key = `${screen ? screens.indexOf(screen) : -1}|${present.map((p) => p.order).join(",")}`;
        const last = segments[segments.length - 1];
        if (last && last.key === key) {
            last.f1 = f1;
        } else {
            segments.push({ f0, f1, people: present, screen, key });
        }
    }

    const ctx: RenderContext = { dir: input.dir, fps, caps, text };
    const parts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        parts.push(await renderSegment(ctx, segments[i], i));
    }
    await fs.promises.writeFile(path.join(input.dir, "concat.txt"), parts.map((f) => `file '${f}'`).join("\n"), "utf8");

    // ---- final file: joined video + every audio stream at its real time, mixed
    const args = ["-f", "concat", "-safe", "0", "-i", "concat.txt"];
    const audioFilters: string[] = [];
    audioTracks.forEach((t, i) => {
        args.push("-i", t.file);
        const ms = Math.max(0, Math.round(t.start * 1000));
        audioFilters.push(`[${i + 1}:a]aresample=48000,adelay=delays=${ms}:all=1[a${i}]`);
    });
    if (audioTracks.length) {
        const labels = audioTracks.map((_, i) => `[a${i}]`).join("");
        audioFilters.push(`${labels}amix=inputs=${audioTracks.length}:normalize=0:dropout_transition=0,apad,atrim=end=${total.toFixed(3)},asetpts=N/SR/TB[aout]`);
        await fs.promises.writeFile(path.join(input.dir, "audio.txt"), audioFilters.join(";\n"), "utf8");
        args.push(...graphArgs(caps, "audio.txt"), "-map", "0:v:0", "-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-ar", "48000");
    } else {
        args.push("-map", "0:v:0");
    }
    args.push("-c:v", "copy", "-t", total.toFixed(3), "-movflags", "+faststart", "-y", output);
    await runFfmpeg(args, input.dir);

    // ---- validate before anyone sees it
    const info = await probe(output);
    if (!info.hasVideo) {
        throw new Error("The composed recording has no video stream");
    }
    if (audioTracks.length && !info.hasAudio) {
        throw new Error("The composed recording lost its audio stream");
    }
    if (info.duration < total - 2) {
        throw new Error(`The composed recording is too short (${info.duration.toFixed(1)}s of ${total.toFixed(1)}s)`);
    }
    if (info.hasAudio && speech.length) {
        const peak = await maxVolume(output);
        if (peak !== null && peak < -70) {
            throw new Error(`The mixed audio is silent (peak ${peak} dB) although speech was captured`);
        }
    }
    await Promise.all(parts.map((f) => fs.promises.rm(path.join(input.dir, f), { force: true }).catch(() => undefined)));
    return { duration: total, hasAudio: info.hasAudio, speech };
}
