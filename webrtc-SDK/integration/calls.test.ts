import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Device, FakeHandler, testFakeParameters } from "mediasoup-client";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";
import mediasoupService from "../../webrtc-BE/src/services/mediasoup.service";
import { SCOPES, type SpreeWeClient } from "@spreewe/core";
import { getCalls, type CallService } from "@spreewe/calls";
import { appClient, eventually, grant, makeUser, registerApp, startSocketServer, type Session, type TestApp } from "./support";

/**
 * @spreewe/calls against the real backend and its real mediasoup worker: call:start / incoming /
 * accept / reject / leave / end, admission (mediasoup:joinCall), transports, produce, consume,
 * resume and host controls.
 *
 * What this does NOT cover: real ICE / DTLS / RTP. Node has no WebRTC, so the mediasoup-client side
 * uses its FakeHandler, and MediaStream is shimmed below (browser API, not a SpreeWe API). Run a
 * browser test (examples/calls-only) for actual audio and video.
 */
class MediaStreamShim {
    private tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) {
        this.tracks = [...tracks];
    }
    getTracks() {
        return [...this.tracks];
    }
    getAudioTracks() {
        return this.tracks.filter((t) => t.kind === "audio");
    }
    getVideoTracks() {
        return this.tracks.filter((t) => t.kind === "video");
    }
    addTrack(t: MediaStreamTrack) {
        this.tracks.push(t);
    }
    removeTrack(t: MediaStreamTrack) {
        this.tracks = this.tracks.filter((x) => x !== t);
    }
}
(globalThis as any).MediaStream ??= MediaStreamShim;

const fakeMedia = async (c: MediaStreamConstraints) =>
    new MediaStreamShim([
        ...(c.audio ? [new FakeMediaStreamTrack({ kind: "audio" }) as unknown as MediaStreamTrack] : []),
        ...(c.video ? [new FakeMediaStreamTrack({ kind: "video" }) as unknown as MediaStreamTrack] : []),
    ]) as unknown as MediaStream;

const fakeDevice = () => new Device({ handlerFactory: FakeHandler.createFactory(testFakeParameters) });

let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, owner: Session;
let app: TestApp;
let conversationId: string;
const clients: SpreeWeClient[] = [];

function callsFor(user: Session): CallService {
    const c = appClient(base, app, String(user.user._id));
    clients.push(c);
    // Fake media + fake WebRTC handler (see the note above); everything else is the real flow
    return getCalls(c, { createDevice: fakeDevice, getUserMedia: fakeMedia, cameraEncodings: [] });
}

beforeAll(async () => {
    await mediasoupService.init();
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    [alice, bob, owner] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
    app = await registerApp(owner, [...SCOPES], { environment: "production", callbackUrls: ["https://app.example.com/oauth/callback"], quotas: { rateLimitPerMinute: 6000 } });
    await grant(alice, app, [...SCOPES]);
    await grant(bob, app, [...SCOPES]);
    const c = appClient(base, app, String(alice.user._id));
    clients.push(c);
    conversationId = String((await c.http.post<{ conversationId: string }>("/conversations", { receiverId: String(bob.user._id) })).conversationId);
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server?.close();
});

describe("1:1 audio call between two app sockets", () => {
    let a: CallService, b: CallService;

    beforeAll(async () => {
        a = callsFor(alice);
        b = callsFor(bob);
        await Promise.all([a.start(), b.start()]);
    });

    it("rings, is accepted, both sides join the SFU, and each consumes the other's audio", async () => {
        await a.startCall(conversationId, "audio", { mode: "ring" });
        expect(a.state.value.phase).toBe("connected");
        expect(a.state.value.local.audio).toBe(true);

        const invite = await eventually(() => {
            const inv = b.invites.value.find((i) => i.conversationId === conversationId);
            expect(inv?.kind).toBe("ring");
            return inv!;
        });
        expect(invite.initiatedBy).toBe(String(alice.user._id));

        await b.accept(invite);
        expect(b.state.value.phase).toBe("connected");
        expect(b.invites.value).toHaveLength(0);

        // Each side consumed the other's microphone producer through the real server
        await eventually(() => expect(b.state.value.participants.find((p) => p.userId === String(alice.user._id))?.hasAudio).toBe(true));
        await eventually(() => expect(a.state.value.participants.find((p) => p.userId === String(bob.user._id))?.hasAudio).toBe(true));
        expect(a.state.value.callId).toBe(b.state.value.callId);
    });

    it("mutes and unmutes the microphone", async () => {
        await a.setMicrophone(false);
        expect(a.state.value.local.audio).toBe(false);
        expect(a.state.value.local.stream?.getAudioTracks()[0].enabled).toBe(false);
        await a.setMicrophone(true);
        expect(a.state.value.local.audio).toBe(true);
    });

    it("turning the camera on upgrades the call to video and the other side receives the video", async () => {
        await a.setCamera(true);
        expect(a.state.value.callType).toBe("video");
        await eventually(() => expect(b.state.value.participants.find((p) => p.userId === String(alice.user._id))?.hasVideo).toBe(true));
        await a.setCamera(false);
        await eventually(() => expect(b.state.value.participants.find((p) => p.userId === String(alice.user._id))?.hasVideo).toBe(false));
    });

    it("refreshes call state (role, participants)", async () => {
        await a.refreshState();
        expect(a.state.value.participants.some((p) => p.userId === String(bob.user._id))).toBe(true);
    });

    it("leaving tells the other side; the call ends when the last person leaves", async () => {
        await b.leave();
        expect(b.state.value.phase).toBe("ended");
        expect(b.state.value.endReason).toBe("left");
        // The server keeps the call until the last person leaves (same as the SpreeWe apps)
        await eventually(() => expect(a.state.value.participants.some((p) => p.userId === String(bob.user._id))).toBe(false));
        expect(a.state.value.phase).toBe("connected");
        const callId = a.state.value.callId!;
        await a.leave();
        expect(a.state.value.phase).toBe("ended");
        expect(await a.activeCall(conversationId)).toBeNull();
        void callId;
        a.reset();
        b.reset();
        expect(a.state.value.phase).toBe("idle");
    });
});

describe("declining", () => {
    it("a rejected ring ends the call for the caller", async () => {
        const a = callsFor(alice);
        const b = callsFor(bob);
        await Promise.all([a.start(), b.start()]);
        await a.startCall(conversationId, "audio", { mode: "ring" });
        const invite = await eventually(() => {
            const inv = b.invites.value.find((i) => i.conversationId === conversationId);
            expect(inv).toBeTruthy();
            return inv!;
        });
        b.reject(invite);
        await eventually(() => expect(a.state.value.phase).toBe("ended"));
        expect(b.invites.value).toHaveLength(0);
    });
});
