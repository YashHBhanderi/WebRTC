import type { Device, types as Ms } from "mediasoup-client";
import { SpreeWeError, Store, type ReadableStore, type SpreeWeClient, type Unsubscribe } from "@spreewe/core";
import type { CallInvite, CallMode, CallPhase, CallSettings, CallState, CallType, Participant } from "./types.js";

const CALLS_SERVICE = Symbol.for("spreewe.calls");

export interface CallsOptions {
    /**
     * Create the mediasoup Device. Default: `new Device()` from mediasoup-client (loaded on the first
     * call, so pages that never call don't download it). Tests and non-browser runtimes can pass
     * e.g. `() => new Device({ handlerFactory: FakeHandler.createFactory(...) })`.
     */
    createDevice?: () => Device | Promise<Device>;
    /** Capture local media. Default: navigator.mediaDevices.getUserMedia */
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    /** Capture a screen. Default: navigator.mediaDevices.getDisplayMedia */
    getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
    /** Audio constraints (default: echo cancellation, noise suppression, auto gain) */
    audioConstraints?: MediaTrackConstraints;
    /** Video constraints (default: 1280×720 ideal) */
    videoConstraints?: MediaTrackConstraints;
    /** Simulcast encodings for the camera (default: three layers). [] disables simulcast. */
    cameraEncodings?: RTCRtpEncodingParameters[];
    /** Re-list producers this often while connected, to catch missed events (default 10 000 ms) */
    syncIntervalMs?: number;
}

/** The client's call service. Pass options on the first call only. */
export function getCalls(client: SpreeWeClient, options?: CallsOptions): CallService {
    return client.service(CALLS_SERVICE, (c) => new CallService(c, options));
}

const initialState = (): CallState => ({
    phase: "idle",
    callId: null,
    conversationId: null,
    callType: "audio",
    mode: null,
    initiatedBy: null,
    startedAt: null,
    role: null,
    hostIds: [],
    cohostIds: [],
    settings: {},
    lobby: [],
    participants: [],
    local: { stream: null, screen: null, audio: false, video: false, sharing: false, handRaised: false },
    screenSharerUserId: null,
    recording: null,
    connection: "new",
    error: null,
});

interface RemoteProducer {
    producerId: string;
    userId: string;
    kind: "audio" | "video";
    source?: "camera" | "screen" | string;
}

/**
 * Audio / video calls through SpreeWe's SFU (mediasoup), with the same signaling as the SpreeWe apps.
 *
 * One call at a time per client. An app takes part as another device of its user, and SpreeWe allows
 * one media session per user: if the user is already in the call elsewhere, `phase` becomes
 * "elsewhere" and `takeOver()` moves the session here.
 *
 * Scopes: calls:read (invites, state), calls:write (start / join / media / screen sharing),
 * calls:manage (host controls), recordings:write (recording), realtime:connect.
 */
export class CallService {
    readonly client: SpreeWeClient;
    private readonly opts: CallsOptions;
    private readonly stateStore = new Store<CallState>(initialState());
    private readonly invitesStore = new Store<CallInvite[]>([]);
    private readonly offs: Unsubscribe[] = [];
    private wired = false;
    private me = "";
    private device: Device | null = null;
    private sendTransport: Ms.Transport | null = null;
    private recvTransport: Ms.Transport | null = null;
    private readonly producers = new Map<"audio" | "video" | "screen", Ms.Producer>();
    private readonly consumers = new Map<string, { consumer: Ms.Consumer; userId: string; source: string }>();
    private readonly consumedProducers = new Set<string>();
    private consumeChain: Promise<void> = Promise.resolve();
    private syncTimer: ReturnType<typeof setInterval> | null = null;
    private readonly transportStates = new Map<string, string>();
    private readonly reactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private startWaiter: { resolve: (p: { callId: string; resumed?: boolean }) => void; reject: (e: Error) => void; conversationId: string } | null = null;
    private admittedWaiter: (() => void) | null = null;
    private joining = false;

    constructor(client: SpreeWeClient, options: CallsOptions = {}) {
        this.client = client;
        this.opts = options;
    }

    get state(): ReadableStore<CallState> {
        return this.stateStore;
    }

    /** Ringing and joinable calls for this user */
    get invites(): ReadableStore<CallInvite[]> {
        return this.invitesStore;
    }

    get myUserId(): string {
        return this.me;
    }

    private patch(p: Partial<CallState>): void {
        this.stateStore.update((s) => ({ ...s, ...p }));
    }

    private patchParticipant(userId: string, p: Partial<Participant>): void {
        this.stateStore.update((s) => {
            const exists = s.participants.some((x) => x.userId === userId);
            const participants = exists
                ? s.participants.map((x) => (x.userId === userId ? { ...x, ...p } : x))
                : [...s.participants, { userId, stream: null, screen: null, hasAudio: false, hasVideo: false, handRaised: false, level: 0, ...p }];
            return { ...s, participants };
        });
    }

    /** Listen for invites (call:incoming, pending rings) and call events. Idempotent. */
    async start(): Promise<void> {
        if (!this.me) this.me = await this.client.userId();
        if (!this.wired) {
            this.wired = true;
            this.wire();
        }
        await this.client.realtime.connect();
    }

    // ------------------------------------------------------------------ events

    private wire(): void {
        const rt = this.client.realtime;
        const isCurrent = (callId: unknown) => !!callId && String(callId) === this.stateStore.value.callId;
        const invite = (kind: "ring" | "active") => (p: any) => {
            if (!p?.callId || String(p.initiatedBy) === this.me) return;
            const inv: CallInvite = { callId: String(p.callId), conversationId: String(p.groupId), callType: p.callType === "video" ? "video" : "audio", mode: p.mode === "meetNow" ? "meetNow" : "ring", initiatedBy: String(p.initiatedBy || ""), kind };
            this.invitesStore.update((list) => [...list.filter((i) => i.callId !== inv.callId), inv]);
        };
        this.offs.push(
            rt.on("call:incoming", invite("ring")),
            rt.on("call:meeting-active", invite("active")),
            rt.on<{ calls?: any[] }>("call:pending-rings", (p) => {
                // Authoritative on every connect: drop rings that are no longer ringing
                const rings = (p?.calls || []).filter((c) => String(c.initiatedBy) !== this.me).map(
                    (c): CallInvite => ({ callId: String(c.callId), conversationId: String(c.groupId), callType: c.callType === "video" ? "video" : "audio", mode: c.mode === "meetNow" ? "meetNow" : "ring", initiatedBy: String(c.initiatedBy || ""), kind: "ring" }),
                );
                this.invitesStore.update((list) => [...list.filter((i) => i.kind === "active"), ...rings]);
            }),
            rt.on<{ callId: string; groupId: string; callType: CallType; mode: CallMode; initiatedBy: string; resumed?: boolean }>("call:started", (p) => {
                const w = this.startWaiter;
                if (w && String(p.groupId) === w.conversationId) {
                    this.startWaiter = null;
                    this.patch({ mode: p.mode, initiatedBy: String(p.initiatedBy), callType: p.callType === "video" ? "video" : this.stateStore.value.callType });
                    w.resolve({ callId: String(p.callId), resumed: p.resumed });
                }
            }),
            rt.on<{ message: string }>("call:error", (p) => {
                if (this.startWaiter) {
                    const w = this.startWaiter;
                    this.startWaiter = null;
                    w.reject(new SpreeWeError({ code: "SOCKET_REFUSED", message: p?.message || "The call couldn't start." }));
                } else if (this.stateStore.value.phase !== "idle") this.patch({ error: p?.message || null });
            }),
            rt.on<{ callId: string; reason?: string }>("call:ended", (p) => {
                this.invitesStore.update((list) => list.filter((i) => i.callId !== String(p?.callId)));
                if (isCurrent(p?.callId)) void this.teardown("ended");
            }),
            rt.on<{ callId: string; userId: string }>("call:participant-joined", (p) => isCurrent(p?.callId) && String(p.userId) !== this.me && this.patchParticipant(String(p.userId), {})),
            rt.on<{ callId: string; userId: string }>("call:participant-left", (p) => {
                if (!isCurrent(p?.callId)) return;
                const id = String(p.userId);
                if (id === this.me) return;
                this.dropUserMedia(id);
                this.stateStore.update((s) => ({ ...s, participants: s.participants.filter((x) => x.userId !== id) }));
            }),
            rt.on<{ callId: string; userId: string }>("call:participant-rejected", (p) => {
                if (!isCurrent(p?.callId)) this.invitesStore.update((list) => list.filter((i) => !(i.callId === String(p?.callId) && String(p.userId) === this.me)));
            }),
            rt.on<{ callId: string; callType: CallType }>("call:media-updated", (p) => isCurrent(p?.callId) && this.patch({ callType: p.callType === "video" ? "video" : "audio" })),
            rt.on<{ callId: string; settings: CallSettings; cohostIds?: string[] }>("call:settings", (p) => isCurrent(p?.callId) && this.patch({ settings: p.settings || {}, cohostIds: (p.cohostIds || []).map(String) })),
            rt.on<{ callId: string; waiting: any }>("call:lobby", (p) => {
                if (!isCurrent(p?.callId)) return;
                const waiting = Array.isArray(p.waiting) ? p.waiting : [];
                this.patch({ lobby: waiting.map((w: any) => ({ userId: String(w?.userId ?? w?._id ?? w) })) });
            }),
            rt.on<{ callId: string }>("call:admitted", (p) => {
                if (isCurrent(p?.callId) && this.admittedWaiter) {
                    const w = this.admittedWaiter;
                    this.admittedWaiter = null;
                    w();
                }
            }),
            rt.on<{ callId: string }>("call:denied", (p) => isCurrent(p?.callId) && void this.teardown("denied")),
            rt.on<{ callId: string }>("call:removed", (p) => isCurrent(p?.callId) && void this.teardown("removed")),
            rt.on<{ callId: string }>("call:force-leave", (p) => isCurrent(p?.callId) && void this.teardown("other-device")),
            rt.on<{ callId: string }>("call:force-muted", (p) => isCurrent(p?.callId) && void this.setMicrophone(false)),
            rt.on<{ callId: string }>("call:share-stopped", (p) => isCurrent(p?.callId) && void this.stopScreenShare()),
            rt.on<{ callId: string; userId: string; raised: boolean }>("call:hand", (p) => isCurrent(p?.callId) && this.patchParticipant(String(p.userId), { handRaised: !!p.raised })),
            rt.on<{ callId: string; userId: string; emoji: string }>("call:reaction", (p) => {
                if (!isCurrent(p?.callId)) return;
                const id = String(p.userId);
                this.patchParticipant(id, { reaction: p.emoji });
                clearTimeout(this.reactionTimers.get(id));
                this.reactionTimers.set(id, setTimeout(() => this.patchParticipant(id, { reaction: undefined }), 4000));
            }),
            rt.on<{ callId: string; levels: any }>("call:audio-levels", (p) => {
                if (!isCurrent(p?.callId) || !p.levels) return;
                const entries: [string, number][] = Array.isArray(p.levels)
                    ? p.levels.map((l: any) => [String(l.userId), Number(l.volume ?? l.level ?? 0)])
                    : Object.entries(p.levels).map(([k, v]) => [k, Number(v)]);
                const map = new Map(entries);
                this.stateStore.update((s) => ({ ...s, participants: s.participants.map((x) => ({ ...x, level: normalizeLevel(map.get(x.userId)) })) }));
            }),
            rt.on<{ callId: string; userId: string }>("screen:started", (p) => isCurrent(p?.callId) && this.patch({ screenSharerUserId: String(p.userId) })),
            rt.on<{ callId: string; userId: string }>("screen:stopped", (p) => isCurrent(p?.callId) && this.patch({ screenSharerUserId: null })),
            rt.on<{ callId: string; active: boolean; startedAt?: string; byName?: string }>("call:recording", (p) =>
                isCurrent(p?.callId) && this.patch({ recording: p.active ? { active: true, startedAt: p.startedAt, byName: p.byName } : null }),
            ),
            rt.on<RemoteProducer>("mediasoup:newProducer", (p) => {
                if (this.stateStore.value.phase !== "connected" || !p?.producerId) return;
                void this.consume(p);
            }),
            rt.on<{ producerId: string; userId: string; source?: string }>("mediasoup:producerClosed", (p) => p?.producerId && this.closeConsumerFor(String(p.producerId))),
            rt.onConnect(() => {
                const s = this.stateStore.value;
                if (s.callId && (s.phase === "connected" || s.phase === "reconnecting")) void this.rejoin();
            }),
        );
        this.offs.push(
            this.client.realtime.state.subscribe((st) => {
                const s = this.stateStore.value;
                if ((st === "reconnecting" || st === "offline") && s.phase === "connected") this.patch({ phase: "reconnecting" });
            }),
        );
    }

    // ------------------------------------------------------------------ lifecycle

    /**
     * Start a call in a conversation (or join the one already running there). Default mode: video
     * calls "meetNow" (members can join), audio calls "ring" — the server's defaults.
     */
    async startCall(conversationId: string, callType: CallType = "video", options: { mode?: CallMode } = {}): Promise<void> {
        await this.start();
        this.ensureIdle();
        this.stateStore.set({ ...initialState(), phase: "starting", conversationId, callType });
        try {
            const started = await new Promise<{ callId: string; resumed?: boolean }>((resolve, reject) => {
                this.startWaiter = { resolve, reject, conversationId };
                this.client.realtime.emit("call:start", { groupId: conversationId, callType, ...(options.mode ? { mode: options.mode } : {}) });
                setTimeout(() => {
                    if (this.startWaiter?.resolve === resolve) {
                        this.startWaiter = null;
                        reject(new SpreeWeError({ code: "ACK_TIMEOUT", message: "The call didn't start (no answer from SpreeWe)." }));
                    }
                }, 15_000);
            });
            // An active call there was resumed: take part in it like an invitee
            if (started.resumed) await this.client.realtime.request("call:accept", { callId: started.callId }).catch(() => undefined);
            await this.join(started.callId, callType, conversationId);
        } catch (e) {
            await this.fail(e);
            throw e;
        }
    }

    /** Accept a ringing call, or join an active one. */
    async accept(invite: CallInvite | string, options: { callType?: CallType } = {}): Promise<void> {
        await this.start();
        const inv = typeof invite === "string" ? this.invitesStore.value.find((i) => i.callId === invite) : invite;
        const callId = typeof invite === "string" ? invite : invite.callId;
        this.ensureIdle();
        const callType = options.callType || inv?.callType || "audio";
        this.stateStore.set({ ...initialState(), phase: "joining", callId, conversationId: inv?.conversationId ?? null, callType, mode: inv?.mode ?? null, initiatedBy: inv?.initiatedBy ?? null });
        this.invitesStore.update((list) => list.filter((i) => i.callId !== callId));
        try {
            await this.client.realtime.request("call:accept", { callId });
            await this.join(callId, callType, inv?.conversationId ?? null);
        } catch (e) {
            await this.fail(e);
            throw e;
        }
    }

    /** Decline a ringing call */
    reject(invite: CallInvite | string): void {
        const callId = typeof invite === "string" ? invite : invite.callId;
        this.invitesStore.update((list) => list.filter((i) => i.callId !== callId));
        if (this.client.realtime.connected) this.client.realtime.emit("call:reject", { callId });
    }

    /** Hide an active-call invite without declining */
    dismiss(callId: string): void {
        this.invitesStore.update((list) => list.filter((i) => i.callId !== callId));
    }

    private ensureIdle(): void {
        const p = this.stateStore.value.phase;
        if (p !== "idle" && p !== "ended") throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Already in a call. Leave it first." });
    }

    private async join(callId: string, callType: CallType, conversationId: string | null): Promise<void> {
        this.joining = true;
        this.patch({ phase: "joining", callId, callType, conversationId, error: null });
        try {
            if (!this.stateStore.value.local.stream) await this.captureLocal(callType);
            const device = await this.loadDevice();
            for (;;) {
                const res = await this.client.realtime.request<{ success?: boolean; lobby?: boolean; producers?: RemoteProducer[]; error?: string; code?: string }>(
                    "mediasoup:joinCall",
                    { callId, callType },
                    { raw: true, timeoutMs: 15_000 },
                );
                if (res?.code === "IN_CALL_ELSEWHERE") {
                    this.patch({ phase: "elsewhere" });
                    return;
                }
                if (res?.error) throw new SpreeWeError({ code: "SOCKET_REFUSED", message: res.error, details: res });
                if (res?.lobby) {
                    this.patch({ phase: "lobby" });
                    await new Promise<void>((resolve) => (this.admittedWaiter = resolve));
                    if (this.stateStore.value.phase !== "lobby") return;
                    this.patch({ phase: "joining" });
                    continue;
                }
                await this.createTransports(device);
                await this.produceLocal();
                this.patch({ phase: "connected" });
                for (const p of res?.producers || []) void this.consume(p);
                this.startSync(callId);
                void this.refreshState();
                return;
            }
        } finally {
            this.joining = false;
        }
    }

    /** Leave the call (others stay) */
    async leave(): Promise<void> {
        const s = this.stateStore.value;
        if (s.callId && this.client.realtime.connected) this.client.realtime.emit("call:leave", { callId: s.callId });
        await this.teardown("left");
    }

    /** End the call for everyone (group calls: hosts only; 1:1: either side) */
    async end(): Promise<void> {
        const s = this.stateStore.value;
        if (!s.callId) return;
        await this.client.realtime.request("call:end", { callId: s.callId });
        await this.teardown("ended");
    }

    /** In the call on another device: move it here (the other device leaves the call). */
    async takeOver(): Promise<void> {
        const s = this.stateStore.value;
        if (!s.callId) return;
        await this.client.realtime.request("call:takeover", { callId: s.callId });
        await this.join(s.callId, s.callType, s.conversationId);
    }

    /** After the "ended" screen: back to idle */
    reset(): void {
        if (this.stateStore.value.phase === "ended") this.stateStore.set(initialState());
    }

    /** Whether the user is live in a call on another device (calls:read) */
    session(): Promise<{ elsewhere: boolean; callId?: string }> {
        return this.client.realtime.request("call:session", {}, { raw: true });
    }

    /** The call running in a conversation, if any */
    async activeCall(conversationId: string): Promise<{ callId: string; callType: CallType; mode: CallMode; initiatedBy: string } | null> {
        await this.start();
        const res = await this.client.realtime.request<{ call: any }>("call:getActive", { groupId: conversationId });
        return res?.call ? { callId: String(res.call.callId), callType: res.call.callType, mode: res.call.mode, initiatedBy: String(res.call.initiatedBy) } : null;
    }

    private async rejoin(): Promise<void> {
        const s = this.stateStore.value;
        if (!s.callId || this.joining) return;
        this.patch({ phase: "reconnecting" });
        this.closeMedia(false);
        try {
            // A developer-app socket comes back as a new device: re-accept (no-op while still a
            // participant), take the session over from the dropped socket, then join again
            await this.client.realtime.request("call:accept", { callId: s.callId }).catch(() => undefined);
            await this.client.realtime.request("call:takeover", { callId: s.callId }).catch(() => undefined);
            await this.join(s.callId, s.callType, s.conversationId);
        } catch (e) {
            await this.fail(e);
        }
    }

    private async fail(e: unknown): Promise<void> {
        const message = e instanceof Error ? e.message : "The call failed.";
        await this.teardown("error");
        this.patch({ error: message });
    }

    private async teardown(reason: NonNullable<CallState["endReason"]>): Promise<void> {
        if (this.startWaiter) {
            this.startWaiter.reject(new SpreeWeError({ code: "ABORTED", message: "Cancelled." }));
            this.startWaiter = null;
        }
        if (this.admittedWaiter) {
            const w = this.admittedWaiter;
            this.admittedWaiter = null;
            this.patch({ phase: "ended" });
            w();
        }
        this.closeMedia(true);
        if (this.syncTimer) clearInterval(this.syncTimer);
        this.syncTimer = null;
        for (const t of this.reactionTimers.values()) clearTimeout(t);
        this.reactionTimers.clear();
        const s = this.stateStore.value;
        if (s.phase === "idle") return;
        this.stateStore.set({ ...initialState(), phase: "ended", callId: s.callId, conversationId: s.conversationId, callType: s.callType, endReason: reason, error: s.error });
    }

    private closeMedia(stopLocal: boolean): void {
        for (const p of this.producers.values()) p.close();
        this.producers.clear();
        for (const { consumer } of this.consumers.values()) consumer.close();
        this.consumers.clear();
        this.consumedProducers.clear();
        this.sendTransport?.close();
        this.recvTransport?.close();
        this.sendTransport = this.recvTransport = null;
        this.transportStates.clear();
        if (stopLocal) {
            const { stream, screen } = this.stateStore.value.local;
            stream?.getTracks().forEach((t) => t.stop());
            screen?.getTracks().forEach((t) => t.stop());
        }
        this.stateStore.update((s) => ({
            ...s,
            participants: s.participants.map((p) => ({ ...p, stream: null, screen: null, hasAudio: false, hasVideo: false })),
            local: stopLocal ? { ...s.local, stream: null, screen: null, sharing: false } : s.local,
        }));
    }

    // ------------------------------------------------------------------ media setup

    private async loadDevice(): Promise<Device> {
        if (this.device?.loaded) return this.device;
        const device = this.opts.createDevice ? await this.opts.createDevice() : new (await import("mediasoup-client")).Device();
        const { rtpCapabilities } = await this.client.realtime.request<{ rtpCapabilities: Ms.RtpCapabilities }>("mediasoup:getRouterRtpCapabilities", {});
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        this.device = device;
        return device;
    }

    private async captureLocal(callType: CallType): Promise<void> {
        const gum = this.opts.getUserMedia || ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
        const audio = this.opts.audioConstraints ?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        const video = this.opts.videoConstraints ?? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
        let stream: MediaStream | null = null;
        let error: string | null = null;
        try {
            stream = await gum({ audio, video: callType === "video" ? video : false });
        } catch (e) {
            // Camera blocked or missing: try microphone only, then join without local media
            error = e instanceof Error ? e.message : String(e);
            if (callType === "video") {
                try {
                    stream = await gum({ audio, video: false });
                } catch {
                    stream = null;
                }
            }
        }
        this.patch({
            local: { ...this.stateStore.value.local, stream, audio: !!stream?.getAudioTracks().length, video: !!stream?.getVideoTracks().length },
            error: stream ? null : error ? `Microphone / camera unavailable: ${error}` : null,
        });
    }

    private transportOptions(params: any): Ms.TransportOptions {
        return {
            id: params.id,
            iceParameters: params.iceParameters,
            iceCandidates: params.iceCandidates,
            dtlsParameters: params.dtlsParameters,
            iceServers: params.iceServers || [],
            iceTransportPolicy: params.iceTransportPolicy || "all",
        };
    }

    private async createTransports(device: Device): Promise<void> {
        const rt = this.client.realtime;
        const send = device.createSendTransport(this.transportOptions(await rt.request("mediasoup:createSendTransport", {})));
        send.on("connect", ({ dtlsParameters }, callback, errback) => {
            rt.request("mediasoup:connectTransport", { transportId: send.id, dtlsParameters }).then(() => callback(), errback);
        });
        send.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
            rt.request<{ id: string }>("mediasoup:produce", { transportId: send.id, kind, rtpParameters, appData }).then((r) => callback({ id: r.id }), errback);
        });
        this.watchTransport(send);
        const recv = device.createRecvTransport(this.transportOptions(await rt.request("mediasoup:createRecvTransport", {})));
        recv.on("connect", ({ dtlsParameters }, callback, errback) => {
            rt.request("mediasoup:connectTransport", { transportId: recv.id, dtlsParameters }).then(() => callback(), errback);
        });
        this.watchTransport(recv);
        this.sendTransport = send;
        this.recvTransport = recv;
    }

    private watchTransport(t: Ms.Transport): void {
        this.transportStates.set(t.id, "new");
        let restartTimer: ReturnType<typeof setTimeout> | null = null;
        t.on("connectionstatechange", (state) => {
            this.transportStates.set(t.id, state);
            const order = ["failed", "disconnected", "connecting", "new", "connected"] as const;
            const states = [...this.transportStates.values()];
            this.patch({ connection: order.find((o) => states.includes(o)) || "new" });
            if (restartTimer) clearTimeout(restartTimer);
            // Network change: ICE restart (disconnected often recovers by itself, so wait a moment)
            if (state === "failed") void this.restartIce(t);
            else if (state === "disconnected") restartTimer = setTimeout(() => t.connectionState === "disconnected" && void this.restartIce(t), 2500);
        });
    }

    private async restartIce(t: Ms.Transport): Promise<void> {
        if (t.closed) return;
        try {
            const res = await this.client.realtime.request<{ iceParameters: Ms.IceParameters; iceServers?: RTCIceServer[] }>("mediasoup:restartIce", { transportId: t.id });
            if (res.iceServers) await t.updateIceServers({ iceServers: res.iceServers });
            await t.restartIce({ iceParameters: res.iceParameters });
        } catch {
            // next state change retries
        }
    }

    private async produceLocal(): Promise<void> {
        const stream = this.stateStore.value.local.stream;
        const audio = stream?.getAudioTracks()[0];
        const video = stream?.getVideoTracks()[0];
        if (audio) await this.produce("audio", audio);
        if (video) await this.produce("video", video);
        this.announceMedia();
    }

    private async produce(slot: "audio" | "video" | "screen", track: MediaStreamTrack): Promise<void> {
        if (!this.sendTransport) return;
        const existing = this.producers.get(slot);
        if (existing && !existing.closed) {
            await existing.replaceTrack({ track });
            return;
        }
        const options: Ms.ProducerOptions = { track, appData: { source: slot === "screen" ? "screen" : "camera" } };
        if (slot === "video") {
            const encodings = this.opts.cameraEncodings ?? [
                { rid: "r0", scaleResolutionDownBy: 4, maxBitrate: 150_000 },
                { rid: "r1", scaleResolutionDownBy: 2, maxBitrate: 500_000 },
                { rid: "r2", scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
            ];
            if (encodings.length) options.encodings = encodings;
        }
        if (slot === "audio") options.codecOptions = { opusStereo: false, opusDtx: true };
        const producer = await this.sendTransport.produce(options);
        producer.on("trackended", () => {
            if (slot === "screen") void this.stopScreenShare();
        });
        this.producers.set(slot, producer);
    }

    private async closeProducer(slot: "audio" | "video" | "screen"): Promise<void> {
        const p = this.producers.get(slot);
        if (!p) return;
        this.producers.delete(slot);
        p.close();
        await this.client.realtime.request("mediasoup:closeProducer", { producerId: p.id }, { timeoutMs: 3000 }).catch(() => undefined);
    }

    private consume(p: RemoteProducer): Promise<void> {
        if (!p?.producerId || String(p.userId) === this.me || this.consumedProducers.has(p.producerId)) return this.consumeChain;
        this.consumedProducers.add(p.producerId);
        // One at a time: parallel consumes on one transport race in some browsers
        this.consumeChain = this.consumeChain.then(async () => {
            try {
                if (!this.recvTransport || !this.device) throw new Error("not connected");
                const res = await this.client.realtime.request<any>("mediasoup:consume", { producerId: p.producerId, rtpCapabilities: this.device.rtpCapabilities });
                const consumer = await this.recvTransport.consume({ id: res.id, producerId: res.producerId, kind: res.kind, rtpParameters: res.rtpParameters, streamId: `${p.userId}-${res.kind === "audio" ? "mic" : res.source || "camera"}` });
                const source = res.source || p.source || "camera";
                this.consumers.set(consumer.id, { consumer, userId: String(p.userId), source });
                this.attachTrack(String(p.userId), consumer.track, source);
                await this.client.realtime.request("mediasoup:resumeConsumer", { consumerId: consumer.id });
            } catch {
                this.consumedProducers.delete(p.producerId);
            }
        });
        return this.consumeChain;
    }

    private attachTrack(userId: string, track: MediaStreamTrack, source: string): void {
        const current = this.stateStore.value.participants.find((x) => x.userId === userId);
        if (source === "screen") {
            this.patchParticipant(userId, { screen: new MediaStream([track]) });
            return;
        }
        const tracks = (current?.stream?.getTracks() || []).filter((t) => t.kind !== track.kind || t.readyState === "live");
        const stream = new MediaStream([...tracks.filter((t) => t.kind !== track.kind), track]);
        this.patchParticipant(userId, { stream, hasAudio: !!stream.getAudioTracks().length, hasVideo: !!stream.getVideoTracks().length });
    }

    private closeConsumerFor(producerId: string): void {
        this.consumedProducers.delete(producerId);
        for (const [id, c] of this.consumers) {
            if (c.consumer.producerId !== producerId) continue;
            c.consumer.close();
            this.consumers.delete(id);
            const part = this.stateStore.value.participants.find((x) => x.userId === c.userId);
            if (!part) continue;
            if (c.source === "screen") this.patchParticipant(c.userId, { screen: null });
            else {
                const left = (part.stream?.getTracks() || []).filter((t) => t !== c.consumer.track);
                const stream = left.length ? new MediaStream(left) : null;
                this.patchParticipant(c.userId, { stream, hasAudio: !!stream?.getAudioTracks().length, hasVideo: !!stream?.getVideoTracks().length });
            }
        }
    }

    private dropUserMedia(userId: string): void {
        for (const [id, c] of this.consumers) {
            if (c.userId !== userId) continue;
            c.consumer.close();
            this.consumers.delete(id);
            this.consumedProducers.delete(c.consumer.producerId);
        }
    }

    private startSync(callId: string): void {
        if (this.syncTimer) clearInterval(this.syncTimer);
        const run = async () => {
            if (this.stateStore.value.phase !== "connected") return;
            const res = await this.client.realtime.request<{ producers?: RemoteProducer[] }>("mediasoup:syncProducers", { callId }, { raw: true }).catch(() => null);
            for (const p of res?.producers || []) void this.consume(p);
        };
        void run();
        this.syncTimer = setInterval(() => void run(), this.opts.syncIntervalMs ?? 10_000);
    }

    /** Roles, settings, participants, recording and screen-share state (call:getState) */
    async refreshState(): Promise<void> {
        const callId = this.stateStore.value.callId;
        if (!callId) return;
        try {
            const s = await this.client.realtime.request<any>("call:getState", { callId });
            const ids: string[] = (s.participants || []).map((p: any) => String(p?.userId ?? p?._id ?? p)).filter((id: string) => id && id !== this.me);
            for (const id of ids) this.patchParticipant(id, {});
            this.patch({
                role: s.myRole ?? null,
                hostIds: (s.hostIds || []).map(String),
                cohostIds: (s.cohostIds || []).map(String),
                settings: s.settings || {},
                lobby: Array.isArray(s.lobby) ? s.lobby.map((w: any) => ({ userId: String(w?.userId ?? w?._id ?? w) })) : [],
                screenSharerUserId: s.screenSharerUserId ? String(s.screenSharerUserId) : null,
                recording: s.recording?.active ? { active: true, startedAt: s.recording.startedAt, byName: s.recording.byName } : null,
                startedAt: s.startedAt ? Date.parse(s.startedAt) : typeof s.elapsedMs === "number" ? Date.now() - s.elapsedMs : this.stateStore.value.startedAt,
                callType: s.callType === "video" ? "video" : this.stateStore.value.callType,
                mode: s.mode ?? this.stateStore.value.mode,
                conversationId: s.groupId ? String(s.groupId) : this.stateStore.value.conversationId,
            });
        } catch {
            // State is informative; media keeps working without it
        }
    }

    // ------------------------------------------------------------------ local controls

    private announceMedia(): void {
        const s = this.stateStore.value;
        if (s.callId && this.client.realtime.connected) this.client.realtime.emit("call:media-state", { callId: s.callId, audio: s.local.audio, video: s.local.video });
    }

    async setMicrophone(on: boolean): Promise<void> {
        const s = this.stateStore.value;
        let track = s.local.stream?.getAudioTracks()[0];
        if (on && !track) {
            const gum = this.opts.getUserMedia || ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
            const media = await gum({ audio: this.opts.audioConstraints ?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
            track = media.getAudioTracks()[0];
            const stream = new MediaStream([...(s.local.stream?.getTracks() || []), track]);
            this.patch({ local: { ...this.stateStore.value.local, stream } });
            await this.produce("audio", track);
        }
        if (track) track.enabled = on;
        const p = this.producers.get("audio");
        if (p) on ? p.resume() : p.pause();
        this.patch({ local: { ...this.stateStore.value.local, audio: on && !!track } });
        this.announceMedia();
    }

    async setCamera(on: boolean): Promise<void> {
        const s = this.stateStore.value;
        if (!on) {
            s.local.stream?.getVideoTracks().forEach((t) => {
                t.stop();
                s.local.stream?.removeTrack(t);
            });
            await this.closeProducer("video");
            this.patch({ local: { ...this.stateStore.value.local, video: false, stream: s.local.stream ? new MediaStream(s.local.stream.getTracks()) : null } });
            this.announceMedia();
            return;
        }
        if (s.callType === "audio" && s.callId) {
            await this.client.realtime.request("call:upgrade", { callId: s.callId, callType: "video" });
            this.patch({ callType: "video" });
        }
        const gum = this.opts.getUserMedia || ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
        const media = await gum({ video: this.opts.videoConstraints ?? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
        const track = media.getVideoTracks()[0];
        const stream = new MediaStream([...(this.stateStore.value.local.stream?.getAudioTracks() || []), track]);
        this.patch({ local: { ...this.stateStore.value.local, stream, video: true } });
        await this.produce("video", track);
        this.announceMedia();
    }

    /** Share the screen (one sharer per call; the host may disallow it). */
    async startScreenShare(): Promise<void> {
        const s = this.stateStore.value;
        if (!s.callId || s.local.sharing) return;
        await this.client.realtime.request("screen:join", { callId: s.callId }).catch(() => undefined);
        await this.client.realtime.request("screen:start", { callId: s.callId });
        try {
            const gdm = this.opts.getDisplayMedia || ((c: DisplayMediaStreamOptions) => navigator.mediaDevices.getDisplayMedia(c));
            const screen = await gdm({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
            const track = screen.getVideoTracks()[0];
            track.contentHint = "detail";
            await this.produce("screen", track);
            this.patch({ local: { ...this.stateStore.value.local, screen, sharing: true }, screenSharerUserId: this.me });
        } catch (e) {
            await this.client.realtime.request("screen:stop", { callId: s.callId }).catch(() => undefined);
            throw e;
        }
    }

    async stopScreenShare(): Promise<void> {
        const s = this.stateStore.value;
        if (!s.local.sharing && !this.producers.has("screen")) return;
        s.local.screen?.getTracks().forEach((t) => t.stop());
        await this.closeProducer("screen");
        if (s.callId) await this.client.realtime.request("screen:stop", { callId: s.callId }).catch(() => undefined);
        this.patch({ local: { ...this.stateStore.value.local, screen: null, sharing: false }, screenSharerUserId: this.stateStore.value.screenSharerUserId === this.me ? null : this.stateStore.value.screenSharerUserId });
    }

    raiseHand(raised: boolean): void {
        const s = this.stateStore.value;
        if (!s.callId) return;
        this.client.realtime.emit("call:hand", { callId: s.callId, raised });
        this.patch({ local: { ...s.local, handRaised: raised } });
    }

    /** Send a reaction (the server accepts a fixed set of emoji) */
    react(emoji: string): void {
        const s = this.stateStore.value;
        if (s.callId) this.client.realtime.emit("call:reaction", { callId: s.callId, emoji });
    }

    // ------------------------------------------------------------------ host controls (calls:manage)

    private host<T = any>(event: string, payload: Record<string, unknown> = {}): Promise<T> {
        const callId = this.stateStore.value.callId;
        if (!callId) return Promise.reject(new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Not in a call." }));
        return this.client.realtime.request<T>(event, { callId, ...payload });
    }

    muteParticipant(userId: string) {
        return this.host("call:mute-participant", { userId });
    }
    muteAll() {
        return this.host("call:mute-all");
    }
    removeParticipant(userId: string) {
        return this.host("call:remove-participant", { userId });
    }
    admit(userId: string | "all") {
        return this.host("call:admit", userId === "all" ? { all: true } : { userId });
    }
    deny(userId: string) {
        return this.host("call:deny", { userId });
    }
    setCohost(userId: string, cohost = true) {
        return this.host("call:set-cohost", { userId, cohost });
    }
    async updateSettings(settings: { lobby?: boolean; allowUnmute?: boolean; allowShare?: boolean }) {
        const res = await this.host<{ settings: CallSettings }>("call:settings", settings);
        if (res?.settings) this.patch({ settings: res.settings });
        return res;
    }
    /** recordings:write; the server decides who may record */
    startRecording() {
        return this.host("call:record-start");
    }
    stopRecording() {
        return this.host("call:record-stop");
    }

    get isModerator(): boolean {
        const s = this.stateStore.value;
        return s.role === "host" || s.role === "cohost" || s.hostIds.includes(this.me) || s.cohostIds.includes(this.me);
    }

    destroy(): void {
        void this.teardown("left");
        this.offs.splice(0).forEach((off) => off());
    }
}

function normalizeLevel(v: number | undefined): number {
    if (v === undefined || !Number.isFinite(v)) return 0;
    // mediasoup reports dBov (-127..0); some payloads already use 0..1
    if (v < 0) return Math.max(0, Math.min(1, (v + 70) / 70));
    return Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
}

export function isCallPhaseActive(phase: CallPhase): boolean {
    return phase === "starting" || phase === "joining" || phase === "lobby" || phase === "connected" || phase === "reconnecting" || phase === "elsewhere";
}

