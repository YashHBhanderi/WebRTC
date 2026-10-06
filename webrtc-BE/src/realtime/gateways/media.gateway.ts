import * as mediasoup from "mediasoup";
import mediasoupService from "../../services/mediasoup.service";
import callService from "../../services/call.service";
import { emitToCall } from "../../services/call-session.service";
import { getClientIceConfig, mediaConfig, withTestTunnelCandidate } from "../../utils/network";
import { AuthedSocket, io } from "../io";

interface ProducerInfo {
    producerId: string;
    userId: string;
    kind: "audio" | "video";
    source?: string;
}

/** Transport params for mediasoup-client, including short-lived TURN credentials. */
async function transportParams(transport: mediasoup.types.WebRtcTransport, userId: string, reused = false) {
    return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        // No-op unless the dev-only MEDIA_TEST_TCP_TUNNEL_* vars are set
        iceCandidates: await withTestTunnelCandidate(transport.iceCandidates),
        dtlsParameters: transport.dtlsParameters,
        ...getClientIceConfig(userId),
        ...(reused ? { reused: true } : {}),
    };
}

/** Producers of everyone else in the call (join + resync). */
function otherProducers(callId: string, selfUserId?: string): ProducerInfo[] {
    const producers: ProducerInfo[] = [];
    mediasoupService.getPeersByCallId(callId).forEach((existingPeer) => {
        if (selfUserId && existingPeer.userId === selfUserId) {
            return;
        }
        existingPeer.producers.forEach((producer) => {
            producers.push({
                producerId: producer.id,
                userId: existingPeer.userId,
                kind: producer.kind as "audio" | "video",
                source: (producer.appData as any)?.source || "camera",
            });
        });
    });
    return producers;
}

/** mediasoup SFU signaling (transports, produce/consume, layers, ICE). Event names unchanged. */
export function registerMediaGateway(socket: AuthedSocket): void {
    const userId = socket.data.userId;

    const createTransportHandler = (direction: "send" | "recv") => async (_: unknown, callback: (r: any) => void) => {
        try {
            let peer = mediasoupService.getPeer(socket.id);
            if (!peer) {
                peer = mediasoupService.createPeer(socket.data.userId, socket.id);
            }
            const current = direction === "send" ? peer.sendTransport : peer.recvTransport;

            // A client only asks for a transport when it has none. Reuse is safe only for one it
            // never connected (duplicate request); a connected one belongs to a previous page
            // (refresh / quick rejoin) and connect() on it fails, so replace it. Closing it fires
            // producer 'transportclose' → other peers get mediasoup:producerClosed and resubscribe.
            // dtlsState stays 'new' until the handshake starts, so also require that connect() was never called.
            if (current && !current.closed && current.dtlsState === "new" && !current.appData.connectCalled) {
                return callback(await transportParams(current, socket.data.userId, true));
            }
            if (current && !current.closed) {
                try { current.close(); } catch { /* ignore */ }
            }

            const transport = await mediasoupService.createWebRtcTransport(socket.data.userId, direction);
            if (direction === "send") {
                peer.sendTransport = transport;
            } else {
                peer.recvTransport = transport;
            }
            callback(await transportParams(transport, socket.data.userId));
        } catch (error) {
            console.error(`Failed to create ${direction} transport:`, error);
            callback({ error: direction === "send" ? "Failed to create send transport" : "Failed to create receive transport" });
        }
    };

    socket.on("mediasoup:createSendTransport", createTransportHandler("send"));
    socket.on("mediasoup:createRecvTransport", createTransportHandler("recv"));

    socket.on("mediasoup:connectTransport", async ({ transportId, dtlsParameters } = {} as any, callback) => {
        try {
            const peer = mediasoupService.getPeer(socket.id);
            if (!peer) {
                return callback({ error: "Peer not found" });
            }
            const transport = mediasoupService.getTransport(peer, transportId);
            if (!transport) {
                return callback({ error: "Transport not found" });
            }
            // Idempotent — reconnect / reused transport may already be connected
            if (transport.dtlsState === "connected" || transport.dtlsState === "connecting" || transport.appData.connectCalled) {
                return callback({ connected: true });
            }
            transport.appData.connectCalled = true;
            await transport.connect({ dtlsParameters });
            callback({ connected: true });
        } catch (error) {
            console.error("Failed to connect transport:", error);
            callback({ error: "Failed to connect transport" });
        }
    });

    // Network change (Wi-Fi ↔ 4G, VPN toggle) → client asks for fresh ICE credentials
    socket.on("mediasoup:restartIce", async ({ transportId } = {} as any, callback) => {
        try {
            const peer = mediasoupService.getPeer(socket.id);
            const transport = peer && mediasoupService.getTransport(peer, transportId);
            if (!transport || transport.closed) {
                return callback?.({ error: "Transport not found" });
            }
            const iceParameters = await transport.restartIce();
            callback?.({ iceParameters, ...getClientIceConfig(socket.data.userId) });
        } catch (error) {
            console.error("Failed to restart ICE:", error);
            callback?.({ error: "Failed to restart ICE" });
        }
    });

    // ICE servers for the legacy 1:1 P2P call page (same TURN, short-lived creds)
    socket.on("ice:getServers", (_: unknown, callback) => {
        callback?.(getClientIceConfig(socket.data.userId));
    });

    socket.on("mediasoup:getRouterRtpCapabilities", (_: unknown, callback) => {
        try {
            callback({ rtpCapabilities: mediasoupService.getRouter().rtpCapabilities });
        } catch (error) {
            console.error("Failed to get router RTP capabilities:", error);
            callback({ error: "Failed to get router RTP capabilities" });
        }
    });

    socket.on("mediasoup:produce", async ({ transportId, kind, rtpParameters, appData } = {} as any, callback) => {
        try {
            const peer = mediasoupService.getPeer(socket.id);
            if (!peer) {
                return callback({ error: "Peer not found" });
            }
            if (!peer.sendTransport) {
                return callback({ error: "Send transport not found" });
            }
            if (peer.sendTransport.id !== transportId) {
                return callback({ error: "Invalid transport" });
            }
            if (!peer.callId) {
                return callback({ error: "Peer is not associated with a call" });
            }
            if (kind !== "audio" && kind !== "video") {
                return callback({ error: "Invalid kind" });
            }

            // Only a known source label is stored/forwarded — never arbitrary client appData
            const source: "camera" | "screen" = kind === "video" && appData?.source === "screen" ? "screen" : "camera";

            const producer = await peer.sendTransport.produce({
                kind,
                rtpParameters,
                // Coalesce PLI/FIR bursts from many consumers into one keyframe per window
                ...(kind === "video" ? { keyFrameRequestDelay: mediaConfig.keyFrameRequestDelayMs } : {}),
                appData: { source },
            });
            peer.producers.set(producer.id, producer);

            console.log(
                `Producer created: ${producer.id} (${kind}/${source}, ${producer.type}, ` +
                `${producer.rtpParameters.encodings?.length ?? 1} encoding(s))`
            );

            mediasoupService.watchProducer(producer, userId);

            if (producer.kind === "audio") {
                const levelsCallId = String(peer.callId);
                void mediasoupService.observeAudio(levelsCallId, producer, peer.userId, (levels) => {
                    emitToCall(levelsCallId, "call:audio-levels", { callId: levelsCallId, levels });
                });
            }

            const payload = { producerId: producer.id, userId: peer.userId, kind: producer.kind, source };
            const callKey = String(peer.callId);
            // Room + direct fan-out (room alone misses peers who haven't joined the socket room yet)
            socket.to(callKey).emit("mediasoup:newProducer", payload);
            mediasoupService.getPeersByCallId(callKey).forEach((other) => {
                if (other.userId !== peer.userId) {
                    io().to(other.socketId).emit("mediasoup:newProducer", payload);
                }
            });
            console.log(`Producer notified call=${callKey} peers=${mediasoupService.getPeersByCallId(callKey).length}`);

            producer.on("transportclose", () => {
                console.log(`Producer transport closed: ${producer.id}`);
                producer.close();
                peer.producers.delete(producer.id);
                io().to(callKey).emit("mediasoup:producerClosed", { producerId: producer.id, userId: peer.userId, source });
            });

            callback({ id: producer.id });
        } catch (error) {
            console.error("Failed to create producer:", error);
            callback({ error: "Failed to create producer" });
        }
    });

    socket.on("mediasoup:consume", async ({ producerId, rtpCapabilities } = {} as any, callback) => {
        try {
            const peer = mediasoupService.getPeer(socket.id);
            if (!peer) {
                return callback({ error: "Peer not found" });
            }
            if (!peer.recvTransport) {
                return callback({ error: "Receive transport not found" });
            }
            const router = mediasoupService.getRouter();
            if (!router.canConsume({ producerId, rtpCapabilities })) {
                return callback({ error: "Cannot consume this producer" });
            }

            // Only producers from the caller's own call can be consumed
            const found = mediasoupService.findProducerInCall(peer.callId, producerId);
            if (!found) {
                return callback({ error: "Producer not found in this call" });
            }
            const producerSource: string = (found.producer.appData as any)?.source || "camera";
            const producerUserId = found.ownerUserId;

            // Created paused: client resumes after its track is wired up, then mediasoup
            // sends a keyframe. Simulcast/SVC consumers start at the highest layer and
            // mediasoup's BWE steps them down/up automatically.
            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
                appData: { source: producerSource, userId: producerUserId },
            });

            // Screen share gets bandwidth before camera tiles when the link is constrained
            if (consumer.kind === "video" && producerSource === "screen") {
                await consumer.setPriority(2);
            }

            mediasoupService.watchConsumer(consumer, userId);
            peer.consumers.set(consumer.id, consumer);

            consumer.on("transportclose", () => {
                console.log(`Consumer transport closed: ${consumer.id}`);
                peer.consumers.delete(consumer.id);
            });

            consumer.on("producerclose", () => {
                console.log(`Producer closed for consumer: ${consumer.id}`);
                const source = (consumer as any).appData?.source || "camera";
                consumer.close();
                peer.consumers.delete(consumer.id);
                io().to(socket.id).emit("mediasoup:producerClosed", {
                    consumerId: consumer.id,
                    producerId,
                    userId: (consumer as any).appData?.userId,
                    source,
                });
            });

            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                source: producerSource,
            });
        } catch (error) {
            console.error("Failed to create consumer:", error);
            callback({ error: "Failed to create consumer" });
        }
    });

    socket.on("mediasoup:resumeConsumer", async ({ consumerId } = {} as any, callback) => {
        try {
            const peer = mediasoupService.getPeer(socket.id);
            if (!peer) {
                return callback({ error: "Peer not found" });
            }
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) {
                return callback({ error: "Consumer not found" });
            }
            await consumer.resume();
            // One explicit keyframe request for the first frame. Repeated PLIs made every
            // producer re-send keyframes for each joiner (bitrate spikes → loss → freezes);
            // the producer's keyFrameRequestDelay coalesces concurrent joins.
            if (consumer.kind === "video") {
                consumer.requestKeyFrame().catch(() => undefined);
            }
            callback({ success: true });
        } catch (error) {
            console.error("Failed to resume consumer:", error);
            callback({ error: "Failed to resume consumer" });
        }
    });

    // Client-driven layer cap (tile size / focus / tab visibility). BWE still adapts below it.
    socket.on("mediasoup:setPreferredLayers", async ({ consumerId, spatialLayer, temporalLayer } = {} as any, callback) => {
        try {
            const peer = mediasoupService.getPeer(socket.id);
            const consumer = peer?.consumers.get(consumerId);
            if (!consumer || consumer.closed) {
                return callback?.({ error: "Consumer not found" });
            }
            if (consumer.type !== "simulcast" && consumer.type !== "svc") {
                return callback?.({ success: true, ignored: true });
            }
            const s = Number(spatialLayer);
            const t = temporalLayer == null ? undefined : Number(temporalLayer);
            if (!Number.isInteger(s) || s < 0 || s > 3 || (t !== undefined && (!Number.isInteger(t) || t < 0 || t > 3))) {
                return callback?.({ error: "Invalid layers" });
            }
            await consumer.setPreferredLayers({ spatialLayer: s, temporalLayer: t });
            callback?.({ success: true });
        } catch (error) {
            console.error("Failed to set preferred layers:", error);
            callback?.({ error: "Failed to set preferred layers" });
        }
    });

    socket.on("mediasoup:joinCall", async ({ callId, callType } = {} as any, callback) => {
        try {
            if (!callId) {
                return callback({ error: "callId is required" });
            }
            if (callType !== "audio" && callType !== "video") {
                return callback({ error: "Invalid callType" });
            }
            if (!(await callService.isActiveParticipant(String(callId), socket.data.userId))) {
                return callback({ error: "Not a participant of this call" });
            }

            let peer = mediasoupService.getPeer(socket.id);
            if (!peer) {
                peer = mediasoupService.createPeer(socket.data.userId, socket.id);
            }
            mediasoupService.joinCall(socket.id, callId, callType);
            socket.join(callId.toString());

            callback({ success: true, producers: otherProducers(String(callId), peer.userId) });
        } catch (error) {
            console.error("Failed to join mediasoup call:", error);
            callback({ error: "Failed to join call" });
        }
    });

    socket.on("mediasoup:syncProducers", ({ callId } = {} as any, callback) => {
        try {
            if (!callId) {
                return callback?.({ producers: [] });
            }
            const peer = mediasoupService.getPeer(socket.id);
            callback?.({ producers: otherProducers(callId.toString(), peer?.userId) });
        } catch (error) {
            callback?.({ producers: [], error: error instanceof Error ? error.message : "sync failed" });
        }
    });
}
