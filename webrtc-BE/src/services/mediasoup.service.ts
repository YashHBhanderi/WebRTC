import * as mediasoup from 'mediasoup';
import { MediasoupPeer } from '../types/mediasoup.types';
import {
    getAnnouncedAddresses,
    getAnnouncedIp,
    getPublicMediaHost,
    getPublicMediaPort,
} from '../utils/network';

// Single shared WebRtcServer port (easy to tunnel with playit / one firewall rule)
const RTC_PORT = Number(process.env.MEDIA_RTC_PORT || process.env.RTC_MIN_PORT || 40000);
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || RTC_PORT);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || RTC_PORT);

class MediasoupService {
    private worker!: mediasoup.types.Worker;
    private router!: mediasoup.types.Router;
    private webRtcServer!: mediasoup.types.WebRtcServer;
    private announcedAddresses: string[] = [];

    /** Keyed by userId so brief socket reconnects keep media alive */
    private peersByUserId = new Map<string, MediasoupPeer>();
    private socketToUserId = new Map<string, string>();

    async init(): Promise<void> {
        console.log('Starting mediasoup worker...');
        this.announcedAddresses = getAnnouncedAddresses();
        console.log(`mediasoup announced IPs: ${this.announcedAddresses.join(', ') || getAnnouncedIp()}`);
        console.log(`mediasoup WebRtcServer port: ${RTC_PORT} (UDP+TCP)`);

        this.worker = await mediasoup.createWorker({
            logLevel: 'warn',
            rtcMinPort: RTC_MIN_PORT,
            rtcMaxPort: Math.max(RTC_MAX_PORT, RTC_PORT),
        });

        this.worker.on('died', () => {
            console.error('mediasoup worker died');

            setTimeout(() => {
                process.exit(1);
            }, 2000);
        });

        console.log(`mediasoup worker created: ${this.worker.pid}`);

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

        this.router = await this.worker.createRouter({
            mediaCodecs,
        });

        console.log('mediasoup router created');

        const primary = this.announcedAddresses[0] || getAnnouncedIp();
        const listenInfos: mediasoup.types.TransportListenInfo[] = [
            {
                protocol: 'udp',
                ip: '0.0.0.0',
                announcedAddress: primary,
                port: RTC_PORT,
                exposeInternalIp: false,
            },
        ];

        this.webRtcServer = await this.worker.createWebRtcServer({ listenInfos });
        console.log(
            `mediasoup WebRtcServer ready on :${RTC_PORT} (tunnel host=${getPublicMediaHost() || primary} port=${getPublicMediaPort() ?? RTC_PORT})`
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

        const preferUdp = process.env.MEDIA_PREFER_UDP !== 'false';
        // Always allow TCP on the WebRTC transport so off-mesh / ngrok clients can connect.
        // UDP mesh/LAN still wins via preferUdp + ICE priorities. Bore tunnel is separate.
        const transport = await router.createWebRtcTransport({
            webRtcServer: this.webRtcServer,
            enableUdp: true,
            enableTcp: false,
            preferUdp: true,
            preferTcp: false,
            initialAvailableOutgoingBitrate: 1_500_000,
        });

        try {
            await transport.setMaxIncomingBitrate(2_500_000);
        } catch {
            // ignore
        }

        transport.on('iceselectedtuplechange', (tuple) => {
            console.log('🔥 SELECTED ICE TUPLE', {
                transportId: transport.id,

                // Add these from your context
                userId,
                direction, // 'send' | 'recv'

                localIp: tuple.localIp,
                localPort: tuple.localPort,
                remoteIp: tuple.remoteIp,
                remotePort: tuple.remotePort,
                protocol: tuple.protocol,
            });
        });

        const statsInterval = setInterval(async () => {
            try {
                if (transport.closed) {
                    clearInterval(statsInterval);
                    return;
                }

                const stats = await transport.getStats();

                const s = stats[0];

                console.log('📊 TRANSPORT', {
                    id: transport.id,
                    user: userId,
                    dir: direction,

                    // Network
                    rtt_ms:
                        s?.iceSelectedTuple?.localIp &&
                            s?.iceSelectedTuple?.remoteIp
                            ? undefined
                            : undefined,

                    protocol: s?.iceSelectedTuple?.protocol,
                    remoteIp: s?.iceSelectedTuple?.remoteIp,

                    // RTP flow
                    recvKbps: s?.rtpRecvBitrate
                        ? Math.round(s.rtpRecvBitrate / 1000)
                        : 0,

                    sendKbps: s?.rtpSendBitrate
                        ? Math.round(s.rtpSendBitrate / 1000)
                        : 0,

                    rtpBytesReceived: s?.rtpBytesReceived ?? 0,
                    rtpBytesSent: s?.rtpBytesSent ?? 0,

                    iceState: s?.iceState,
                    dtlsState: s?.dtlsState,
                });
            } catch {
                // ignore debug errors
            }
        }, 2000);

        transport.on('@close', () => {
            clearInterval(statsInterval);
        });

        transport.on('icestatechange', (iceState) => {
            console.log(`mediasoup ICE state: ${iceState} (${transport.id})`);
        });

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'failed' || dtlsState === 'closed') {
                console.warn(`mediasoup DTLS ${dtlsState} (${transport.id})`);
            }
        });

        return transport;
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

        peer.callId = undefined;
        peer.callType = undefined;
    }

    getPeersByCallId(callId: string): MediasoupPeer[] {
        const key = String(callId);
        return Array.from(this.peersByUserId.values())
            .filter((peer) => peer.callId != null && String(peer.callId) === key);
    }
}

export default new MediasoupService();
