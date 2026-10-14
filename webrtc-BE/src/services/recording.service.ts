import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import * as mediasoup from "mediasoup";
import Recording, { IRecording, ITranscriptSegment } from "../models/recordingModel";
import Conversation from "../models/conversationModel";
import Meeting from "../models/meetingModel";
import User from "../models/userModel";
import { recordingConfig, transcriptionConfig } from "../config/recording";
import { isStorageConfigured, storageConfig } from "../config/storage";
import { captureProducer, CaptureHandle } from "../recording/track-capture";
import { composeRecording, ComposeEvent, extractSpeech, isAudible } from "../recording/composer";
import { transcriptionProvider } from "../recording/transcription";
import mediasoupService from "./mediasoup.service";
import meetingControls from "./meeting-controls.service";
import callRoom from "./call-room.service";
import notificationService from "./notification.service";
import storage from "./storage.service";
import { signedMediaUrl } from "./file.service";
import { broadcastMessage, emitToCall } from "./call-session.service";
import MessageService from "./message.service";
import { emitToUsers } from "../realtime/io";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { requireObjectId } from "../utils/validation";

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface LiveTrack {
    producerId: string;
    userId: string;
    kind: "audio" | "video";
    source: "camera" | "screen";
    endOffset: number | null;
    handle: CaptureHandle;
}

interface LiveEvent {
    at: number;
    userId: string;
    type: "join" | "leave" | "media";
    audio?: boolean | null;
    video?: boolean | null;
}

interface LiveRecording {
    recordingId: string;
    callId: string;
    dir: string;
    startedAtMs: number;
    tracks: Map<string, LiveTrack>;
    events: LiveEvent[];
    present: Set<string>;
    limitTimer: ReturnType<typeof setTimeout>;
    stopping: boolean;
}

const FRIENDLY = {
    processing: "We couldn't process this recording.",
    nothing: "Nothing was captured in this recording.",
    interrupted: "The recording was interrupted by a server restart.",
    transcript: "We couldn't create a transcript for this recording.",
    noEngine: "Transcription isn't available on this server.",
};

/**
 * Meeting recording, server-side and independent of anyone's UI / tab / picture-in-picture:
 *  1. while recording, every stream of the call is captured from mediasoup (one FFmpeg per stream)
 *     and a timeline of who joined / left and their mic / camera state is kept;
 *  2. after stopping, in the background, one MP4 is composed from it (gallery / presenter layout,
 *     all audio mixed), validated, and stored privately in S3;
 *  3. then each speaker's own audio is transcribed (so speakers are known) — a separate queue, with
 *     automatic retries; a failed transcript never affects the recording.
 */
class RecordingService {
    private live = new Map<string, LiveRecording>();
    private composeQueue: Promise<void> = Promise.resolve();
    private transcriptQueue: Promise<void> = Promise.resolve();
    private queuedTranscripts = new Set<string>();

    constructor() {
        mediasoupService.onPeerCallChange((callId, userId, joined) => this.presence(callId, userId, joined));
    }

    get enabled(): boolean {
        return recordingConfig.enabled;
    }

    activeFor(callId: string): { recordingId: string; startedAt: number } | null {
        const rec = this.live.get(String(callId));
        return rec && !rec.stopping ? { recordingId: rec.recordingId, startedAt: rec.startedAtMs } : null;
    }

    private dirFor(recordingId: string): string {
        return path.join(recordingConfig.tmpDir, recordingId);
    }

    private offset(live: LiveRecording, at = Date.now()): number {
        return Math.max(0, (at - live.startedAtMs) / 1000);
    }

    /** Who may start / stop: hosts and co-hosts in group meetings; either person in a 1:1 call. */
    private async requirePermission(callId: string, userId: string) {
        const { call, group } = await meetingControls.load(callId);
        if (!(call.participants || []).some((p: any) => String(p.userId) === userId && p.status === "joined")) {
            throw new ForbiddenError("Join the meeting to record it");
        }
        if (!meetingControls.isModerator(call, group, userId)) {
            throw new ForbiddenError("Only the host or a co-host can record this meeting");
        }
        return { call, group };
    }

    async start(callId: unknown, userId: string) {
        if (!this.enabled) {
            throw new AppError("Recording isn't available on this server", 400);
        }
        const key = String(callId || "");
        const { call } = await this.requirePermission(key, userId);
        if (call.callStatus !== "active" && call.callStatus !== "ringing") {
            throw new AppError("This meeting has ended");
        }
        if (this.live.has(key)) {
            throw new AppError("This meeting is already being recorded");
        }

        const conversation = await Conversation.findById(call.conversationId).select("groupName isGroup").lean();
        const meeting = await Meeting.findOne({ conversationId: call.conversationId }).select("_id title").lean();
        const startedAt = new Date();
        const recording = await Recording.create({
            callId: call._id,
            conversationId: call.conversationId,
            meetingId: meeting?._id || null,
            title: meeting?.title || conversation?.groupName || "Call recording",
            startedBy: oid(userId),
            startedAt,
            status: "recording",
        });

        const dir = this.dirFor(String(recording._id));
        await fs.promises.mkdir(dir, { recursive: true });
        const live: LiveRecording = {
            recordingId: String(recording._id),
            callId: key,
            dir,
            startedAtMs: startedAt.getTime(),
            tracks: new Map(),
            events: [],
            present: new Set(),
            stopping: false,
            // Safety stop
            limitTimer: setTimeout(() => void this.stop(key, null, "limit"), recordingConfig.maxMinutes * 60_000),
        };
        this.live.set(key, live);

        // Everyone already in the call, with their current mic / camera state
        const media = callRoom.snapshot(key).media;
        const peers = mediasoupService.getPeersByCallId(key);
        for (const peer of peers) {
            const id = String(peer.userId);
            live.present.add(id);
            live.events.push({ at: 0, userId: id, type: "join" });
            const state = media[id];
            if (state) {
                live.events.push({ at: 0, userId: id, type: "media", audio: !!state.audio, video: !!state.video });
            }
        }
        for (const peer of peers) {
            for (const producer of peer.producers.values()) {
                await this.addProducer(key, producer, peer.userId);
            }
        }

        const starter = await User.findById(userId).select("username").lean();
        // Never silent: everyone in the call sees it and gets told
        emitToCall(key, "call:recording", { callId: key, active: true, startedAt: startedAt.toISOString(), by: userId, byName: starter?.username || "" });
        // …and the meeting chat keeps a record of it
        try {
            const notice = await MessageService.postServiceMessage(String(call.conversationId), userId, "system", `${starter?.username || "Someone"} started recording`);
            const members = await this.memberIds(recording);
            broadcastMessage(String(call.conversationId), members, notice);
        } catch (error) {
            console.error("[recording] could not post the chat notice", error);
        }
        return { recordingId: String(recording._id), startedAt };
    }

    /** Someone's media connection joined / left a call that is being recorded. */
    private presence(callId: string, userId: string, joined: boolean): void {
        const live = this.live.get(callId);
        if (!live || live.stopping || live.present.has(userId) === joined) {
            return;
        }
        if (joined) {
            live.present.add(userId);
        } else {
            live.present.delete(userId);
        }
        live.events.push({ at: this.offset(live), userId, type: joined ? "join" : "leave" });
    }

    /** A participant's mic / camera switched (from the call:media-state announcements). */
    mediaState(callId: string, userId: string, state: { audio?: unknown; video?: unknown }): void {
        const live = this.live.get(String(callId));
        if (!live || live.stopping) {
            return;
        }
        live.events.push({
            at: this.offset(live),
            userId: String(userId),
            type: "media",
            audio: typeof state.audio === "boolean" ? state.audio : null,
            video: typeof state.video === "boolean" ? state.video : null,
        });
    }

    /** A new stream appeared while recording (someone joined, turned on a camera, started presenting). */
    async addProducer(callId: string, producer: mediasoup.types.Producer, userId: string): Promise<void> {
        const live = this.live.get(String(callId));
        if (!live || live.stopping || live.tracks.has(producer.id) || producer.closed) {
            return;
        }
        const source = ((producer.appData as any)?.source === "screen" ? "screen" : "camera") as "camera" | "screen";
        const name = `${producer.kind}-${source}-${userId}-${Date.now()}`;
        try {
            const handle = await captureProducer(mediasoupService.getRouter(), producer, live.dir, name, (code) => {
                console.error(`[recording] capture of ${name} stopped unexpectedly (code ${code})`);
                this.endTrack(callId, producer.id);
            });
            live.tracks.set(producer.id, {
                producerId: producer.id,
                userId: String(userId),
                kind: producer.kind as "audio" | "video",
                source,
                endOffset: null,
                handle,
            });
            producer.observer.once("close", () => this.endTrack(callId, producer.id));
        } catch (error) {
            // One stream failing must not stop the recording of everyone else
            console.error(`[recording] could not capture ${name}:`, error);
        }
    }

    private endTrack(callId: string, producerId: string): void {
        const live = this.live.get(String(callId));
        const track = live?.tracks.get(producerId);
        if (!live || !track || track.endOffset !== null) {
            return;
        }
        track.endOffset = this.offset(live);
        void track.handle.stop().catch(() => undefined);
    }

    /** Stop by a moderator (userId), or automatically (call ended / time limit) with userId = null. */
    async stop(callId: unknown, userId: string | null, reason: "user" | "ended" | "limit" = "user") {
        const key = String(callId || "");
        const live = this.live.get(key);
        if (!live || live.stopping) {
            if (userId) {
                throw new AppError("This meeting isn't being recorded");
            }
            return;
        }
        if (userId) {
            await this.requirePermission(key, userId);
        }
        live.stopping = true;
        clearTimeout(live.limitTimer);
        this.live.delete(key);
        const endedAtMs = Date.now();
        const duration = this.offset(live, endedAtMs);

        await Promise.all([...live.tracks.values()].map(async (t) => {
            if (t.endOffset === null) {
                t.endOffset = duration;
            }
            await t.handle.stop().catch(() => undefined);
        }));
        live.present.forEach((id) => live.events.push({ at: duration, userId: id, type: "leave" }));

        // A track's timeline starts at its first packet; streams that never sent anything are dropped
        const tracks = [...live.tracks.values()]
            .filter((t) => t.handle.firstPacketAt !== null)
            .map((t) => ({
                userId: oid(t.userId),
                kind: t.kind,
                source: t.source,
                startOffset: this.offset(live, t.handle.firstPacketAt as number),
                endOffset: Math.min(duration, t.endOffset ?? duration),
                file: t.handle.file,
            }))
            .filter((t) => t.endOffset > t.startOffset);

        const recording = await Recording.findByIdAndUpdate(live.recordingId, {
            $set: {
                status: "processing",
                endedAt: new Date(endedAtMs),
                duration: Math.round(duration),
                stoppedBy: userId ? oid(userId) : null,
                tracks,
                timeline: live.events.map((e) => ({ ...e, userId: oid(e.userId) })),
            },
        }, { new: true });
        emitToCall(key, "call:recording", { callId: key, active: false, reason });

        if (recording) {
            const members = await this.memberIds(recording);
            this.emitUpdate(recording, members);
            // The chat card appears right away ("Recording processing") and follows the status live
            await this.postCard(recording, members);
        }
        this.enqueueCompose(live.recordingId);
    }

    /** Call ended: stop its recording (if any). */
    stopForCall(callId: string): void {
        if (this.live.has(String(callId))) {
            void this.stop(callId, null, "ended").catch((error) => console.error("[recording] auto-stop failed", error));
        }
    }

    /**
     * Server start: a live recording's streams are gone (failed); finished captures still on disk are
     * processed again; transcripts that were waiting are queued again.
     */
    async recoverOnStartup(): Promise<void> {
        const res = await Recording.updateMany(
            { status: { $in: ["starting", "recording"] } },
            { $set: { status: "failed", error: FRIENDLY.interrupted } },
        );
        if (res.modifiedCount) {
            console.warn(`[recording] ${res.modifiedCount} interrupted recording(s) marked failed`);
        }
        const processing = await Recording.find({ status: "processing" }).select("tracks").lean();
        for (const r of processing) {
            const id = String(r._id);
            if ((r.tracks || []).some((t: any) => fs.existsSync(t.file))) {
                this.enqueueCompose(id);
            } else {
                await Recording.updateOne({ _id: r._id }, { $set: { status: "failed", error: FRIENDLY.interrupted } });
            }
        }
        const transcripts = await Recording.find({ status: "completed", transcriptStatus: { $in: ["pending", "processing"] } }).select("_id").lean();
        for (const r of transcripts) {
            await Recording.updateOne({ _id: r._id }, { $set: { transcriptStatus: "pending", transcriptAttempts: 0 } });
            this.enqueueTranscript(String(r._id));
        }
        // Retention lives in the bucket itself (a lifecycle rule), not only in this process
        if (isStorageConfigured()) {
            try {
                await storage.ensureExpiryRule(`${storageConfig.keyPrefix}/recordings/`, recordingConfig.retentionDays);
            } catch (error) {
                console.error(`[recording] could not apply the ${recordingConfig.retentionDays}-day S3 lifecycle rule; set one on the recordings/ prefix manually:`, error);
            }
        }
    }

    // ---------------------------------------------------------------- processing

    private enqueueCompose(recordingId: string): void {
        // Processing never blocks the meeting; jobs run one at a time
        this.composeQueue = this.composeQueue.then(() => this.process(recordingId)).catch((error) => {
            console.error(`[recording] processing ${recordingId} crashed:`, error);
        });
    }

    private async names(recording: IRecording): Promise<Map<string, string>> {
        const ids = [...new Set([...recording.tracks.map((t) => String(t.userId)), ...recording.timeline.map((e) => String(e.userId))])];
        const users = await User.find({ _id: { $in: ids.map(oid) } }).select("username").lean();
        return new Map(users.filter((u: any) => u.username).map((u: any) => [String(u._id), String(u.username)]));
    }

    private async process(recordingId: string): Promise<void> {
        const recording = await Recording.findById(recordingId);
        if (!recording || recording.status !== "processing") {
            return;
        }
        const dir = this.dirFor(recordingId);
        const members = await this.memberIds(recording);
        const output = path.join(dir, "recording.mp4");
        try {
            if (!recording.tracks.length) {
                throw Object.assign(new Error("No stream sent any media"), { friendly: FRIENDLY.nothing });
            }
            const events: ComposeEvent[] = recording.timeline.map((e) => ({
                at: e.at,
                userId: String(e.userId),
                type: e.type,
                audio: e.audio,
                video: e.video,
            }));
            const result = await composeRecording({
                dir,
                duration: recording.duration,
                tracks: recording.tracks.map((t) => ({
                    file: t.file,
                    kind: t.kind,
                    source: t.source,
                    userId: String(t.userId),
                    start: t.startOffset,
                    end: t.endOffset ?? recording.duration,
                })),
                events,
                names: await this.names(recording),
            }, output);

            const stat = await fs.promises.stat(output);
            const storageKey = `${storageConfig.keyPrefix}/recordings/${recording.conversationId}/${recordingId}.mp4`;
            await storage.put({
                key: storageKey,
                body: fs.createReadStream(output),
                contentType: "video/mp4",
                contentLength: stat.size,
                metadata: { "recording-id": recordingId },
                cacheControl: "private, max-age=31536000, immutable",
            });
            const engine = result.hasAudio && await transcriptionProvider().available();
            recording.status = "completed";
            recording.error = null;
            recording.storageKey = storageKey;
            recording.size = stat.size;
            recording.duration = Math.round(result.duration);
            recording.speech = result.speech.map((s) => ({ userId: oid(s.userId), start: s.start, end: s.end }));
            recording.transcriptStatus = engine ? "pending" : "none";
            recording.transcriptAttempts = 0;
            await recording.save();
            await fs.promises.rm(output, { force: true }).catch(() => undefined);
            await this.announce(recording, members, `Recording ready: ${recording.title}`);
            if (engine) {
                this.enqueueTranscript(recordingId);
            } else {
                if (result.hasAudio && transcriptionConfig.provider !== "none") {
                    console.warn(`[recording] transcription engine "${transcriptionConfig.provider}" is not available — no transcript for ${recordingId}`);
                }
                await this.cleanup(recordingId);
            }
        } catch (error) {
            console.error(`[recording] processing ${recordingId} failed:`, error);
            recording.status = "failed";
            recording.error = (error as { friendly?: string })?.friendly || FRIENDLY.processing;
            recording.transcriptStatus = "none";
            await recording.save();
            await this.announce(recording, members, `Recording failed: ${recording.title}`);
            await this.cleanup(recordingId);
        }
    }

    private async cleanup(recordingId: string): Promise<void> {
        await fs.promises.rm(this.dirFor(recordingId), { recursive: true, force: true }).catch(() => undefined);
    }

    private enqueueTranscript(recordingId: string): void {
        if (this.queuedTranscripts.has(recordingId)) {
            return;
        }
        this.queuedTranscripts.add(recordingId);
        this.transcriptQueue = this.transcriptQueue
            .then(() => this.runTranscript(recordingId))
            .catch((error) => console.error(`[recording] transcription ${recordingId} crashed:`, error))
            .then(() => {
                this.queuedTranscripts.delete(recordingId);
            });
    }

    /** Transcribe with automatic retries; the final state (completed / failed) cleans the temp files. */
    private async runTranscript(recordingId: string): Promise<void> {
        const recording = await Recording.findById(recordingId);
        if (!recording || recording.status !== "completed" || recording.transcriptStatus !== "pending") {
            return;
        }
        const members = await this.memberIds(recording);
        if (!(await transcriptionProvider().available())) {
            recording.transcriptStatus = "failed";
            recording.transcriptError = FRIENDLY.noEngine;
            await recording.save();
            this.emitUpdate(recording, members);
            return;
        }
        for (;;) {
            recording.transcriptStatus = "processing";
            recording.transcriptError = null;
            recording.transcriptAttempts = (recording.transcriptAttempts || 0) + 1;
            await recording.save();
            this.emitUpdate(recording, members);
            try {
                recording.transcript = await this.buildTranscript(recording);
                recording.transcriptStatus = "completed";
                await recording.save();
                await this.announce(recording, members, `Transcript ready: ${recording.title}`);
                break;
            } catch (error) {
                console.error(`[recording] transcription of ${recordingId} failed (attempt ${recording.transcriptAttempts}):`, error);
                if (recording.transcriptAttempts >= transcriptionConfig.maxAttempts) {
                    recording.transcriptStatus = "failed";
                    recording.transcriptError = FRIENDLY.transcript;
                    await recording.save();
                    this.emitUpdate(recording, members);
                    break;
                }
                await sleep(30_000 * recording.transcriptAttempts);
            }
        }
        await this.cleanup(recordingId);
    }

    /**
     * Each speaker's own audio track when the captures are still on disk (exact speakers);
     * otherwise the stored MP4, with speakers matched from who was speaking at the time.
     */
    private async buildTranscript(recording: IRecording): Promise<ITranscriptSegment[]> {
        const provider = transcriptionProvider();
        const dir = this.dirFor(String(recording._id));
        await fs.promises.mkdir(dir, { recursive: true });
        const names = await this.names(recording);
        const labels = new Map<string, string>();
        const speakerName = (userId: string | null) => {
            const key = userId || "unknown";
            if (!labels.has(key)) {
                labels.set(key, (userId && names.get(userId)) || `Speaker ${[...labels.values()].filter((v) => v.startsWith("Speaker ")).length + 1}`);
            }
            return labels.get(key) as string;
        };
        const round = (v: number) => Math.round(v * 100) / 100;
        const segments: ITranscriptSegment[] = [];

        const onDisk = recording.tracks.filter((t) => t.kind === "audio" && fs.existsSync(t.file));
        if (onDisk.length) {
            // Only tracks with audible sound (a muted / idle microphone would just make whisper invent text)
            const local: typeof onDisk = [];
            for (const track of onDisk) {
                if (await isAudible(track.file)) {
                    local.push(track);
                }
            }
            const wavs: string[] = [];
            for (const track of local) {
                const wav = path.join(dir, `${path.basename(track.file).replace(/\.\w+$/, "")}.wav`);
                await extractSpeech(track.file, wav);
                wavs.push(wav);
            }
            try {
                const results = wavs.length ? await provider.transcribe(wavs) : [];
                local.forEach((track, i) => {
                    const userId = String(track.userId);
                    const spoke = (recording.speech || []).filter((sp) => String(sp.userId) === userId);
                    for (const s of results[i] || []) {
                        const start = track.startOffset + s.start;
                        const end = track.startOffset + s.end;
                        // Drop lines placed where this person wasn't speaking (whisper hallucinating over silence)
                        if (spoke.length && !spoke.some((sp) => Math.min(end, sp.end + 1) - Math.max(start, sp.start - 1) > 0)) {
                            continue;
                        }
                        segments.push({
                            speakerId: track.userId,
                            speaker: speakerName(userId),
                            startTime: round(start),
                            endTime: round(end),
                            text: s.text,
                        });
                    }
                });
            } finally {
                await Promise.all(wavs.map((w) => fs.promises.rm(w, { force: true }).catch(() => undefined)));
            }
        } else {
            if (!recording.storageKey) {
                throw new Error("The recording file is not stored");
            }
            const source = path.join(dir, "source.mp4");
            const wav = path.join(dir, "source.wav");
            try {
                await storage.downloadToFile(recording.storageKey, source);
                if (!(await isAudible(source))) {
                    return [];
                }
                await extractSpeech(source, wav);
                const [result] = await provider.transcribe([wav]);
                for (const s of result || []) {
                    // Whoever spoke the most during the segment
                    let best: { userId: string; overlap: number } | null = null;
                    for (const sp of recording.speech || []) {
                        const overlap = Math.min(s.end, sp.end) - Math.max(s.start, sp.start);
                        if (overlap > 0 && (!best || overlap > best.overlap)) {
                            best = { userId: String(sp.userId), overlap };
                        }
                    }
                    segments.push({
                        speakerId: best ? oid(best.userId) : null,
                        speaker: speakerName(best?.userId || null),
                        startTime: round(s.start),
                        endTime: round(s.end),
                        text: s.text,
                    });
                }
            } finally {
                await fs.promises.rm(source, { force: true }).catch(() => undefined);
                await fs.promises.rm(wav, { force: true }).catch(() => undefined);
            }
        }
        return segments.sort((a, b) => a.startTime - b.startTime);
    }

    /** Manual retry of a failed (or missing) transcript. */
    async retryTranscript(recordingId: unknown, userId: string) {
        const recording = await this.forMember(recordingId, userId);
        if (recording.status !== "completed" || this.expiry(recording).expired) {
            throw new AppError("This recording can't be transcribed");
        }
        if (recording.transcriptStatus === "pending" || recording.transcriptStatus === "processing") {
            return { transcriptStatus: recording.transcriptStatus };
        }
        if (recording.transcriptStatus === "completed") {
            throw new AppError("The transcript is already available");
        }
        if (!(await transcriptionProvider().available())) {
            throw new AppError(FRIENDLY.noEngine);
        }
        recording.transcriptStatus = "pending";
        recording.transcriptError = null;
        recording.transcriptAttempts = 0;
        await recording.save();
        this.emitUpdate(recording, await this.memberIds(recording));
        this.enqueueTranscript(String(recording._id));
        return { transcriptStatus: recording.transcriptStatus };
    }

    /** The chat card: one message per recording; its state is read live from /recordings/:id. */
    private async postCard(recording: IRecording, members: string[]): Promise<void> {
        try {
            const card = await MessageService.postServiceMessage(String(recording.conversationId), String(recording.startedBy), 'recording', recording.title, {
                recording: { recordingId: String(recording._id) },
            });
            broadcastMessage(String(recording.conversationId), members, card);
        } catch (error) {
            console.error('[recording] could not post the chat card', error);
        }
    }

    /** When the recording is deleted from storage (S3 lifecycle) — metadata is kept. */
    private expiry(recording: { endedAt?: Date | null; startedAt: Date }) {
        const base = recording.endedAt || recording.startedAt;
        const expiresAt = new Date(new Date(base).getTime() + recordingConfig.retentionDays * 86400000);
        return { expiresAt, expired: expiresAt.getTime() <= Date.now() };
    }

    private async memberIds(recording: IRecording): Promise<string[]> {
        const conversation = await Conversation.findById(recording.conversationId).select("members").lean();
        return (conversation?.members || []).map(String);
    }

    /** Live state for open cards / pages (no Activity entry). */
    private emitUpdate(recording: IRecording, members: string[]): void {
        emitToUsers(members, "recording:updated", {
            recordingId: String(recording._id),
            conversationId: String(recording.conversationId),
            status: recording.status,
            transcriptStatus: recording.transcriptStatus,
            startedBy: String(recording.startedBy),
            title: recording.title,
        });
    }

    /** A milestone: live update + one Activity entry per member. */
    private async announce(recording: IRecording, members: string[], text: string): Promise<void> {
        this.emitUpdate(recording, members);
        try {
            await notificationService.notify(members.map((userId) => ({
                userId,
                type: "recording" as const,
                conversationId: String(recording.conversationId),
                meetingId: recording.meetingId ? String(recording.meetingId) : null,
                recordingId: String(recording._id),
                text,
            })));
        } catch (error) {
            console.error("[recording] could not send notifications", error);
        }
    }

    // ---------------------------------------------------------------- access

    private async forMember(recordingId: unknown, userId: string) {
        const recording = await Recording.findById(requireObjectId(recordingId, "recordingId"));
        if (!recording) {
            throw new NotFoundError("Recording not found");
        }
        const member = await Conversation.exists({ _id: recording.conversationId, members: oid(userId) });
        if (!member) {
            // Same answer as "not found": never reveal that a private recording exists
            throw new NotFoundError("Recording not found");
        }
        return recording;
    }

    async get(recordingId: unknown, userId: string) {
        const recording = await this.forMember(recordingId, userId);
        const starter = await User.findById(recording.startedBy).select("username").lean();
        const { expiresAt, expired } = this.expiry(recording);
        const available = recording.status === "completed" && !!recording.storageKey && !expired;
        return {
            ...recording.toJSON(),
            transcript: undefined,
            transcriptAvailable: recording.transcriptStatus === "completed" && recording.transcript.length > 0,
            expiresAt,
            expired,
            startedByName: starter?.username || "",
            // Short-lived private links (no public URL is ever stored)
            playbackUrl: available ? await signedMediaUrl(recording.storageKey ?? '') : null,
            downloadUrl: available
                ? await signedMediaUrl(recording.storageKey ?? '', Date.now(), `${recording.title.replace(/[^\w\- ]+/g, "").trim() || "recording"}.mp4`)
                : null,
        };
    }

    async transcript(recordingId: unknown, userId: string) {
        const recording = await this.forMember(recordingId, userId);
        return { status: recording.transcriptStatus, error: recording.transcriptError || null, segments: recording.transcript };
    }

    async exportTranscript(recordingId: unknown, userId: string, format: unknown) {
        const recording = await this.forMember(recordingId, userId);
        if (recording.transcriptStatus !== "completed") {
            throw new AppError("The transcript isn't ready yet");
        }
        const segments = recording.transcript;
        const ts = (sec: number, sep: "," | ".") => {
            const ms = Math.max(0, Math.round(sec * 1000));
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            const r = ms % 1000;
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(r).padStart(3, "0")}`;
        };
        const base = recording.title.replace(/[^\w\- ]+/g, "").trim() || "transcript";
        switch (format) {
            case "srt":
                return {
                    filename: `${base}.srt`,
                    contentType: "application/x-subrip",
                    body: segments.map((s, i) => `${i + 1}\n${ts(s.startTime, ",")} --> ${ts(s.endTime, ",")}\n${s.speaker}: ${s.text}\n`).join("\n"),
                };
            case "vtt":
                return {
                    filename: `${base}.vtt`,
                    contentType: "text/vtt",
                    body: "WEBVTT\n\n" + segments.map((s) => `${ts(s.startTime, ".")} --> ${ts(s.endTime, ".")}\n<v ${s.speaker}>${s.text}\n`).join("\n"),
                };
            default:
                return {
                    filename: `${base}.txt`,
                    contentType: "text/plain; charset=utf-8",
                    body: segments.map((s) => `[${ts(s.startTime, ".").slice(0, 8)}] ${s.speaker}: ${s.text}`).join("\n"),
                };
        }
    }

    async listForConversation(conversationId: unknown, userId: string) {
        const id = requireObjectId(conversationId, "conversationId");
        const member = await Conversation.exists({ _id: id, members: oid(userId) });
        if (!member) {
            throw new NotFoundError("Conversation not found");
        }
        const rows = await Recording.find({ conversationId: oid(id) }).sort({ startedAt: -1 }).limit(50)
            .select("title startedAt endedAt duration status transcriptStatus size").lean();
        return rows.map((r: any) => ({
            _id: String(r._id),
            title: r.title,
            startedAt: r.startedAt,
            duration: r.duration,
            status: r.status,
            transcriptStatus: r.transcriptStatus,
            size: r.size,
            expired: this.expiry(r).expired,
        }));
    }
}

export default new RecordingService();
