import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import Recording from "../src/models/recordingModel";
import { runAsSystem } from "../src/tenancy/context";
import { recordingConfig } from "../src/config/recording";
import { CRASH_SAFE, ffmpegArgs } from "../src/recording/track-capture";
import { planRecovery, recordingHost, staleTempDirs } from "../src/recording/recovery";
import { api, makeUser, sleep, startSocketServer } from "./helpers";

/**
 * Phase 5C: interrupted recordings. Uses real FFmpeg (skipped if it is not installed): tracks are
 * written with the production capture flags, the process is hard-killed mid-recording (like a crash),
 * and recovery must salvage them through the real compose pipeline. Only the S3 upload is stubbed.
 */
const hasFfmpeg = spawnSync(recordingConfig.ffmpegPath, ["-version"]).status === 0;
const oid = () => new mongoose.Types.ObjectId();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-recovery-"));

/** Capture synthetic audio / video in real time with the production flags, then kill -9 after `ms`. */
async function crashCapture(kind: "audio" | "video", file: string, ms: number): Promise<void> {
    const input = kind === "audio"
        ? ["-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "96k"]
        : ["-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-c:v", "libvpx", "-deadline", "realtime", "-g", "50", "-b:v", "300k"];
    const p = spawn(recordingConfig.ffmpegPath, ["-hide_banner", "-loglevel", "error", ...input, ...CRASH_SAFE, "-y", file]);
    await sleep(ms);
    p.kill("SIGKILL");
    await new Promise((r) => p.once("exit", r));
}

describe.skipIf(!hasFfmpeg)("interrupted recording recovery (real FFmpeg)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    let service: typeof import("../src/services/recording.service").default;
    let storage: typeof import("../src/services/storage.service").default;
    const savedTmp = recordingConfig.tmpDir;

    beforeAll(async () => {
        (recordingConfig as any).tmpDir = tmp;
        server = await startSocketServer(); // announcements emit to sockets
        service = (await import("../src/services/recording.service")).default;
        storage = (await import("../src/services/storage.service")).default;
    });
    afterAll(async () => {
        (recordingConfig as any).tmpDir = savedTmp;
        await server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("capture uses crash-safe muxing for both audio and video", () => {
        for (const kind of ["audio", "video"] as const) {
            const args = ffmpegArgs(kind, "in.sdp", "out.mkv").join(" ");
            expect(args).toContain("-flush_packets 1");
            expect(args).toContain("-cluster_time_limit 1000");
        }
    });

    async function interrupted(seconds: number, opts: { host?: string | null; audio?: boolean; video?: boolean; emptyAudio?: boolean } = {}) {
        const id = oid();
        const dir = path.join(tmp, String(id));
        fs.mkdirSync(dir, { recursive: true });
        const startedAt = new Date(Date.now() - 30_000);
        const liveTracks: any[] = [];
        // A real (global) conversation: recordings take their scope from it (fail-closed otherwise)
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const conversationId = (await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) })).body.conversationId;
        const user = alice._id;
        if (opts.audio !== false) {
            const file = path.join(dir, `audio-camera-${user}-1.mka`);
            if (opts.emptyAudio) fs.writeFileSync(file, ""); else await crashCapture("audio", file, seconds * 1000);
            liveTracks.push({ producerId: "pa", userId: user, kind: "audio", source: "camera", file, captureStartedAt: new Date(startedAt.getTime() + 1000) });
        }
        if (opts.video) {
            const file = path.join(dir, `video-camera-${user}-1.mkv`);
            await crashCapture("video", file, seconds * 1000);
            liveTracks.push({ producerId: "pv", userId: user, kind: "video", source: "camera", file, captureStartedAt: new Date(startedAt.getTime() + 1000) });
        }
        await runAsSystem(() => Recording.create({
            _id: id, callId: oid(), conversationId, startedBy: user, startedAt, status: "recording",
            host: opts.host === undefined ? recordingHost() : opts.host, liveTracks,
        }), "test-fixture");
        return { id: String(id), dir };
    }
    const load = (id: string) => runAsSystem(() => Recording.findById(id).lean(), "test-inspection");
    const settled = async (id: string, ms = 60_000) => {
        const t0 = Date.now();
        for (;;) {
            const r: any = await load(id);
            if (["completed", "failed"].includes(r.status) || Date.now() - t0 > ms) return r;
            await sleep(250);
        }
    };

    it("a crash after ~5 s: both audio and video are recovered and finalised through the normal pipeline", async () => {
        const put = vi.spyOn(storage, "put").mockResolvedValue(undefined as any);
        const { id } = await interrupted(5, { video: true });
        await runAsSystem(() => service.recoverOnStartup(), "test");
        const r: any = await settled(id);
        expect(r.status).toBe("completed");
        expect(r.recovery).toMatchObject({ partial: true, audio: true, video: true });
        expect(r.recovery.seconds).toBeGreaterThanOrEqual(4);
        expect(r.error).toBeNull(); // completed; the partial-recovery facts stay in r.recovery
        expect(put).toHaveBeenCalledTimes(1);
        put.mockRestore();
    }, 120_000);

    it("recovery runs exactly once under concurrent restarts (atomic claim)", async () => {
        const put = vi.spyOn(storage, "put").mockResolvedValue(undefined as any);
        const { id } = await interrupted(3);
        await Promise.all([1, 2, 3].map(() => runAsSystem(() => service.recoverInterrupted(id), "test")));
        const r: any = await settled(id);
        expect(r.status).toBe("completed");
        expect(put).toHaveBeenCalledTimes(1);
        // A later (stray) recovery of a finished recording is a no-op
        await runAsSystem(() => service.recoverInterrupted(id), "test");
        expect((await load(id) as any).status).toBe("completed");
        expect(put).toHaveBeenCalledTimes(1);
        put.mockRestore();
    }, 120_000);

    it("an empty track file: accurate failure state, nothing invented", async () => {
        const { id } = await interrupted(0, { emptyAudio: true });
        await runAsSystem(() => service.recoverOnStartup(), "test");
        const r: any = await load(id);
        expect(r.status).toBe("failed");
        expect(r.recovery).toMatchObject({ audio: false, video: false });
        expect(r.error).toMatch(/nothing could be recovered/);
    });

    it("another host's live recording is never touched by this host's restart", async () => {
        const { id } = await interrupted(0, { host: "other-host|/tmp/x", emptyAudio: true });
        await runAsSystem(() => service.recoverOnStartup(), "test");
        expect((await load(id) as any).status).toBe("recording");
        // …and cannot be claimed directly either
        await runAsSystem(() => service.recoverInterrupted(id), "test");
        expect((await load(id) as any).status).toBe("recording");
    });

    it("upload failure after recovery: failed with a safe reason, temp folder removed", async () => {
        const put = vi.spyOn(storage, "put").mockRejectedValue(Object.assign(new Error("S3 down"), { friendly: "We couldn't store this recording." }));
        const { id, dir } = await interrupted(3);
        await runAsSystem(() => service.recoverOnStartup(), "test");
        const r: any = await settled(id);
        expect(r.status).toBe("failed");
        expect(r.error).not.toMatch(/S3 down/);
        // The temp folder is removed right after the failed state is saved
        for (let i = 0; i < 50 && fs.existsSync(dir); i++) await sleep(100);
        expect(fs.existsSync(dir)).toBe(false);
        put.mockRestore();
    }, 120_000);

    it("planRecovery reports missing and unreadable files separately", async () => {
        const plan = await planRecovery(new Date(), [
            { producerId: "x", userId: String(oid()), kind: "audio", source: "camera", file: path.join(tmp, "missing.mka"), captureStartedAt: new Date() },
        ]);
        expect(plan).toMatchObject({ tracks: [], missing: 1, unreadable: 0 });
    });
});

describe("recording temp-file cleanup", () => {
    it("deletes only finished / failed / unknown folders older than the retention; never active ones", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-clean-"));
        const ids = { done: String(oid()), failed: String(oid()), unknown: String(oid()), active: String(oid()), processing: String(oid()), recent: String(oid()), live: String(oid()) };
        for (const id of Object.values(ids)) {
            fs.mkdirSync(path.join(dir, id));
            fs.writeFileSync(path.join(dir, id, "t.mka"), "x");
        }
        fs.mkdirSync(path.join(dir, "not-a-recording"));
        const statuses = new Map([[ids.done, "completed"], [ids.failed, "failed"], [ids.active, "recording"], [ids.processing, "processing"], [ids.recent, "completed"], [ids.live, "recording"]]);
        const old = Date.now() + 48 * 3600_000; // "now" two days later; ids.recent touched at that time
        fs.utimesSync(path.join(dir, ids.recent, "t.mka"), new Date(old), new Date(old));
        const out = await staleTempDirs(async () => statuses, new Set([ids.live]), old, dir, 24 * 3600_000);
        expect(out.map((p) => path.basename(p)).sort()).toEqual([ids.done, ids.failed, ids.unknown].sort());
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to start a recording when the disk is nearly full", async () => {
        const service = (await import("../src/services/recording.service")).default;
        const saved = { enabled: recordingConfig.enabled, min: process.env.RECORDING_MIN_FREE_MB };
        (recordingConfig as any).enabled = true;
        process.env.RECORDING_MIN_FREE_MB = String(1024 * 1024 * 1024); // 1 PB
        vi.spyOn(service as any, "requirePermission").mockResolvedValue({ call: { _id: oid(), conversationId: oid(), callStatus: "active" }, group: null });
        const before = await runAsSystem(() => Recording.countDocuments({}), "test-inspection");
        await expect(service.start(String(oid()), String(oid()))).rejects.toMatchObject({ status: 503 });
        expect(await runAsSystem(() => Recording.countDocuments({}), "test-inspection")).toBe(before);
        (recordingConfig as any).enabled = saved.enabled;
        if (saved.min === undefined) delete process.env.RECORDING_MIN_FREE_MB; else process.env.RECORDING_MIN_FREE_MB = saved.min;
        vi.restoreAllMocks();
    });
});
