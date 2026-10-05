import * as mediasoup from 'mediasoup';
import { MediasoupPeer } from '../types/mediasoup.types';
import { describeMediaConfig, mediaConfig } from '../utils/network';

// VP8 first: best simulcast support across Chrome/Edge/Firefox/Safari.
// H264 kept for Safari/iOS hardware encoders.
const mediaCodecs = [
    {
        kind: 'audio' as const,
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: 'video' as const,
        mimeType: 'video/VP8',
        clockRate: 90000,
    },
    {
        kind: 'video' as const,
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
        },
    },
];

class MediasoupService {
    private worker!: mediasoup.types.Worker;
    private router!: mediasoup.types.Router;
    private webRtcServer!: mediasoup.types.WebRtcServer;

    /** One audio-level observer per call (shared router) → speaking indicators / active speaker */
    private audioObservers = new Map<string, Promise<mediasoup.types.AudioLevelObserver>>();
    private audioProducerOwner = new Map<string, string>();

    /** Keyed by userId so brief socket reconnects keep media alive */
    private peersByUserId = new Map<string, MediasoupPeer>();
    private socketToUserId = new Map<string, string>();

    async init(): Promise<void> {
        console.log(`Starting mediasoup worker (${describeMediaConfig()})`);

        this.worker = await mediasoup.createWorker({
            logLevel: mediaConfig.logLevel,
        });

        this.worker.on('died', () => {
            console.error('mediasoup worker died');

            setTimeout(() => {
                process.exit(1);
            }, 2000);
        });

        console.log(`mediasoup worker created: ${this.worker.pid}`);

        this.router = await this.worker.createRouter({
            mediaCodecs,
        });

        console.log('mediasoup router created');

        // One port for all transports (UDP + ICE-TCP) → one firewall rule per protocol.
        // Only the announced (public) address is advertised; internal IPs are never exposed.
        const listenInfos: mediasoup.types.TransportListenInfo[] = [];
        if (mediaConfig.enableUdp) {
            listenInfos.push({
                protocol: 'udp',
                ip: mediaConfig.listenIp,
                announcedAddress: mediaConfig.announcedAddress,
                port: mediaConfig.rtcPort,
                exposeInternalIp: false,
            });
        }
        if (mediaConfig.enableTcp) {
            listenInfos.push({
                protocol: 'tcp',
                ip: mediaConfig.listenIp,
                announcedAddress: mediaConfig.announcedAddress,
                port: mediaConfig.rtcPort,
                exposeInternalIp: false,
            });
        }

        this.webRtcServer = await this.worker.createWebRtcServer({ listenInfos });
        console.log(
            `mediasoup WebRtcServer ready: ${mediaConfig.announcedAddress}:${mediaConfig.rtcPort} ` +
            `(${listenInfos.map((l) => l.protocol).join('+')})`
        );
    }

    getRouter(): mediasoup.types.Router {
        if (!this.router) {
            throw new Error('mediasoup router is not initialized');
        }

        return this.router;
    }

    async createWebRtcTransport(userId: string, direction: 'send' | 'recv'): Promise<mediasoup.types.WebRtcTransport> {
        const router = this.getRouter();

        const transport = await router.createWebRtcTransport({
            webRtcServer: this.webRtcServer,
            enableUdp: mediaConfig.enableUdp,
            enableTcp: mediaConfig.enableTcp,
            // UDP candidates get higher ICE priority; ICE-TCP only wins when UDP is blocked
            preferUdp: true,
            initialAvailableOutgoingBitrate: mediaConfig.initialAvailableOutgoingBitrate,
            appData: { userId, direction },
        });

        try {
            if (direction === 'send' && mediaConfig.maxIncomingBitrate > 0) {
                await transport.setMaxIncomingBitrate(mediaConfig.maxIncomingBitrate);
            }
            if (direction === 'recv' && mediaConfig.maxOutgoingBitrate > 0) {
                await transport.setMaxOutgoingBitrate(mediaConfig.maxOutgoingBitrate);
            }
        } catch (error) {
            console.warn(`mediasoup bitrate cap failed (${transport.id}):`, error);
        }

        transport.on('iceselectedtuplechange', (tuple) => {
            // protocol tells you immediately whether the client is on UDP or fell back to TCP
            console.log(
                `mediasoup ICE tuple user=${userId} dir=${direction} ${tuple.protocol} ` +
                `${tuple.remoteIp}:${tuple.remotePort} → :${tuple.localPort}`
            );
        });

        transport.on('icestatechange', (iceState) => {
            if (iceState === 'disconnected' || mediaConfig.debugStats) {
                console.log(`mediasoup ICE state: ${iceState} user=${userId} dir=${direction} (${transport.id})`);
            }
        });

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'failed' || dtlsState === 'closed') {
                console.warn(`mediasoup DTLS ${dtlsState} user=${userId} dir=${direction} (${transport.id})`);
            }
        });

        if (mediaConfig.debugStats) {
            this.startTransportStats(transport, userId, direction);
            if (direction === 'recv') {
                // SFU → client bandwidth estimate: explains which simulcast layer a viewer gets
                let lastLog = 0;
                await transport.enableTraceEvent(['bwe']);
                transport.on('trace', (trace) => {
                    if (trace.type !== 'bwe' || Date.now() - lastLog < 2000) {
                        return;
                    }
                    lastLog = Date.now();
                    const i = trace.info as any;
                    console.log(
                        `📶 BWE user=${userId} ${i.bweType} available=${Math.round(i.availableBitrate / 1000)}kbps ` +
                        `desired=${Math.round(i.desiredBitrate / 1000)}kbps effectiveDesired=${Math.round(i.effectiveDesiredBitrate / 1000)}kbps`
                    );
                });
            }
        }

        return transport;
    }

    private startTransportStats(
        transport: mediasoup.types.WebRtcTransport,
        userId: string,
        direction: 'send' | 'recv'
    ): void {
        const timer = setInterval(async () => {
            try {
                if (transport.closed) {
                    clearInterval(timer);
                    return;
                }
                const s = (await transport.getStats())[0];
                console.log('📊 TRANSPORT', {
                    user: userId,
                    dir: direction,
                    protocol: s?.iceSelectedTuple?.protocol,
                    recvKbps: Math.round((s?.recvBitrate ?? 0) / 1000),
                    sendKbps: Math.round((s?.sendBitrate ?? 0) / 1000),
                    availableOutgoingKbps: s?.availableOutgoingBitrate
                        ? Math.round(s.availableOutgoingBitrate / 1000)
                        : undefined,
                    iceState: s?.iceState,
                    dtlsState: s?.dtlsState,
                });
            } catch {
                // ignore debug errors
            }
        }, 5000);
        transport.observer.once('close', () => clearInterval(timer));
    }

    /** Debug-only producer stats (packet loss / jitter / RTT seen by the SFU). */
    watchProducer(producer: mediasoup.types.Producer, userId: string): void {
        if (!mediaConfig.debugStats) {
            return;
        }
        const timer = setInterval(async () => {
            try {
                if (producer.closed) {
                    clearInterval(timer);
                    return;
                }
                const stats = await producer.getStats();
                for (const s of stats) {
                    console.log(`🎤 PRODUCER ${producer.kind}`, {
                        user: userId,
                        rid: (s as any).rid,
                        bitrateKbps: Math.round((s.bitrate ?? 0) / 1000),
                        lost: s.packetsLost ?? 0,
                        jitter: s.jitter ?? 0,
                        rtt_ms: s.roundTripTime != null ? Math.round(s.roundTripTime) : undefined,
                        score: s.score,
                    });
                }
            } catch {
                // ignore debug errors
            }
        }, 5000);
        producer.observer.once('close', () => clearInterval(timer));
    }

    /** Debug-only consumer layer/score logging. */
    watchConsumer(consumer: mediasoup.types.Consumer, userId: string): void {
        if (!mediaConfig.debugStats) {
            return;
        }
        consumer.on('layerschange', (layers) => {
            console.log(
                `🔀 CONSUMER layers user=${userId} consumer=${consumer.id} → ` +
                (layers ? `S${layers.spatialLayer}T${layers.temporalLayer ?? '-'}` : 'none (paused by BWE)')
            );
        });
        consumer.on('score', (score) => {
            if (score.score < 7) {
                console.log(`⚠️ CONSUMER score user=${userId} consumer=${consumer.id}`, score);
            }
        });
    }

    getTransport(peer: MediasoupPeer, transportId: string): mediasoup.types.WebRtcTransport | undefined {
        if (peer.sendTransport?.id === transportId) {
            return peer.sendTransport;
        }
        if (peer.recvTransport?.id === transportId) {
            return peer.recvTransport;
        }
        return undefined;
    }

    /** Producer lookup restricted to one call, so a peer cannot consume media from other calls. */
    findProducerInCall(
        callId: string | undefined,
        producerId: string
    ): { producer: mediasoup.types.Producer; ownerUserId: string } | undefined {
        if (!callId) {
            return undefined;
        }
        for (const p of this.getPeersByCallId(callId)) {
            const producer = p.producers.get(producerId);
            if (producer) {
                return { producer, ownerUserId: p.userId };
            }
        }
        return undefined;
    }

    /**
     * Attach or reattach a peer for this user. Socket reconnects update socketId
     * without closing existing transports/producers.
     */
    createPeer(userId: string, socketId: string): MediasoupPeer {
        const existing = this.peersByUserId.get(userId);
        if (existing) {
            if (existing.socketId !== socketId) {
                this.socketToUserId.delete(existing.socketId);
                existing.socketId = socketId;
                this.socketToUserId.set(socketId, userId);
                console.log(`mediasoup peer rebound user=${userId} → socket=${socketId}`);
            }
            return existing;
        }

        const peer: MediasoupPeer = {
            userId,
            socketId,
            producers: new Map(),
            consumers: new Map(),
        };

        this.peersByUserId.set(userId, peer);
        this.socketToUserId.set(socketId, userId);
        return peer;
    }

    getPeer(socketId: string): MediasoupPeer | undefined {
        const userId = this.socketToUserId.get(socketId);
        if (!userId) {
            return undefined;
        }
        return this.peersByUserId.get(userId);
    }

    getPeerByUserId(userId: string): MediasoupPeer | undefined {
        return this.peersByUserId.get(userId);
    }

    removePeer(socketId: string): void {
        const userId = this.socketToUserId.get(socketId);
        if (!userId) {
            return;
        }
        const peer = this.peersByUserId.get(userId);
        if (!peer || peer.socketId !== socketId) {
            // Stale disconnect for an old socket — user already rebound
            this.socketToUserId.delete(socketId);
            return;
        }

        peer.producers.forEach((producer) => {
            producer.close();
        });

        peer.consumers.forEach((consumer) => {
            consumer.close();
        });

        peer.sendTransport?.close();
        peer.recvTransport?.close();

        this.peersByUserId.delete(userId);
        this.socketToUserId.delete(socketId);
        this.releaseCallObservers(peer.callId);
    }

    joinCall(
        socketId: string,
        callId: string,
        callType: 'audio' | 'video'
    ): MediasoupPeer {
        const peer = this.getPeer(socketId);

        if (!peer) {
            throw new Error('Peer not found');
        }

        peer.callId = String(callId);
        peer.callType = callType;

        return peer;
    }

    leaveCall(socketId: string): void {
        const peer = this.getPeer(socketId);

        if (!peer) {
            return;
        }

        peer.producers.forEach((producer) => {
            producer.close();
        });
        peer.producers.clear();

        peer.consumers.forEach((consumer) => {
            consumer.close();
        });
        peer.consumers.clear();

        peer.sendTransport?.close();
        peer.recvTransport?.close();
        peer.sendTransport = undefined;
        peer.recvTransport = undefined;

        const callId = peer.callId;
        peer.callId = undefined;
        peer.callType = undefined;
        this.releaseCallObservers(callId);
    }

    /**
     * Feed an audio producer into its call's level observer. `onLevels` gets the
     * loudest speakers (dBov, -127..0) roughly every 500 ms; an empty list means silence.
     * Closed producers are dropped by mediasoup automatically.
     * The first caller's `onLevels` serves the observer's lifetime, so it must depend on callId only.
     */
    async observeAudio(
        callId: string,
        producer: mediasoup.types.Producer,
        ownerUserId: string,
        onLevels: (levels: { userId: string; volume: number }[]) => void
    ): Promise<void> {
        const key = String(callId);
        let pending = this.audioObservers.get(key);
        if (!pending) {
            pending = this.getRouter()
                .createAudioLevelObserver({ maxEntries: 4, threshold: -65, interval: 500 })
                .then((observer) => {
                    observer.on('volumes', (volumes) => {
                        onLevels(
                            volumes
                                .map((v) => ({
                                    userId: this.audioProducerOwner.get(v.producer.id) || '',
                                    volume: Math.round(v.volume),
                                }))
                                .filter((v) => v.userId)
                        );
                    });
                    observer.on('silence', () => onLevels([]));
                    return observer;
                });
            this.audioObservers.set(key, pending);
        }

        try {
            const observer = await pending;
            if (observer.closed || producer.closed) {
                return;
            }
            this.audioProducerOwner.set(producer.id, ownerUserId);
            producer.observer.once('close', () => this.audioProducerOwner.delete(producer.id));
            await observer.addProducer({ producerId: producer.id });
        } catch (error) {
            // Speaking indicators are best-effort; never fail the produce over them
            console.warn(`audio level observer failed for call ${key}:`, error);
        }
    }

    /** Release per-call observers once nobody in the call has media. */
    private releaseCallObservers(callId: string | undefined): void {
        if (!callId || this.getPeersByCallId(callId).length > 0) {
            return;
        }
        const pending = this.audioObservers.get(String(callId));
        if (!pending) {
            return;
        }
        this.audioObservers.delete(String(callId));
        pending.then((observer) => observer.close()).catch(() => undefined);
    }

    getPeersByCallId(callId: string): MediasoupPeer[] {
        const key = String(callId);
        return Array.from(this.peersByUserId.values())
            .filter((peer) => peer.callId != null && String(peer.callId) === key);
    }
}

export default new MediasoupService();
