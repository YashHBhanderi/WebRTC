import type { Socket } from 'socket.io-client';

/**
 * Browser call media over the SpreeWe mediasoup SFU. Same signaling and order as the web app's
 * mediasoup.service.ts: load device → mediasoup:joinCall (admission, lobby) → transports (only after
 * admission, SEC-005) → produce local mic / camera → consume everyone else's producers.
 *
 * Prototype scope: mic + camera, mute / camera toggle, remote streams per user. No screen share,
 * simulcast layers, ICE-restart handling or device switching (the web app has those).
 */
export interface CallMediaOptions {
  /** Called when a remote user's stream changes (tracks added / removed) */
  onRemoteStream?: (userId: string, stream: MediaStream) => void;
  onRemoteLeft?: (userId: string) => void;
  /** Waiting in the lobby until a host admits you */
  onLobby?: () => void;
}

interface RemoteProducer { producerId: string; userId: string; kind: 'audio' | 'video'; source?: string }

export class CallMedia {
  callId = '';
  localStream: MediaStream | null = null;
  readonly remoteStreams = new Map<string, MediaStream>();
  private device: any = null;
  private sendTransport: any = null;
  private recvTransport: any = null;
  private producers = new Map<'audio' | 'video', any>();
  private consumers = new Map<string, { consumer: any; userId: string }>();
  private offs: (() => void)[] = [];

  constructor(private socket: Socket, private myUserId: string, private opts: CallMediaOptions = {}) {}

  private request<T = any>(event: string, data: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, data, (r: any) => (r?.error ? reject(Object.assign(new Error(String(r.error)), { code: r.code })) : resolve(r)));
    });
  }

  /** Join after call accept / start. Resolves once local media is being sent (or after admission from the lobby). */
  async join(callId: string, callType: 'audio' | 'video'): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined' || !navigator?.mediaDevices) throw new Error('Calls need a browser with WebRTC');
    this.callId = callId;
    const { Device } = await import('mediasoup-client');
    this.device = new Device();
    const { rtpCapabilities } = await this.request('mediasoup:getRouterRtpCapabilities', {});
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });

    let joined = await this.request('mediasoup:joinCall', { callId, callType });
    while (joined?.lobby) {
      this.opts.onLobby?.();
      await new Promise<void>((resolve) => {
        const ok = (p: any) => { if (String(p?.callId) === callId) { this.socket.off('call:admitted', ok); resolve(); } };
        this.socket.on('call:admitted', ok);
      });
      joined = await this.request('mediasoup:joinCall', { callId, callType });
    }

    // Admitted: only now may the server allocate transports
    await this.createTransports();
    this.listen();
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
    for (const track of this.localStream.getTracks()) {
      const producer = await this.sendTransport.produce({ track, appData: { source: track.kind === 'video' ? 'camera' : 'mic' } });
      this.producers.set(track.kind as 'audio' | 'video', producer);
    }
    for (const p of (joined?.producers || []) as RemoteProducer[]) await this.consume(p);
  }

  setMicEnabled(enabled: boolean): void {
    const p = this.producers.get('audio');
    if (p) enabled ? p.resume() : p.pause();
  }

  setCameraEnabled(enabled: boolean): void {
    const p = this.producers.get('video');
    if (p) enabled ? p.resume() : p.pause();
  }

  /** Release media locally (call `client.calls.leave(callId)` to leave the call on the server). */
  close(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.producers.forEach((p) => p.close());
    this.consumers.forEach(({ consumer }) => consumer.close());
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.producers.clear();
    this.consumers.clear();
    this.remoteStreams.clear();
  }

  private async createTransports(): Promise<void> {
    const send = await this.request('mediasoup:createSendTransport', {});
    this.sendTransport = this.device.createSendTransport(this.options(send));
    this.sendTransport.on('connect', ({ dtlsParameters }: any, cb: () => void, eb: (e: Error) => void) =>
      this.request('mediasoup:connectTransport', { transportId: this.sendTransport.id, dtlsParameters }).then(cb, eb));
    this.sendTransport.on('produce', ({ kind, rtpParameters, appData }: any, cb: (r: { id: string }) => void, eb: (e: Error) => void) =>
      this.request('mediasoup:produce', { transportId: this.sendTransport.id, kind, rtpParameters, appData }).then((r) => cb({ id: r.id }), eb));

    const recv = await this.request('mediasoup:createRecvTransport', {});
    this.recvTransport = this.device.createRecvTransport(this.options(recv));
    this.recvTransport.on('connect', ({ dtlsParameters }: any, cb: () => void, eb: (e: Error) => void) =>
      this.request('mediasoup:connectTransport', { transportId: this.recvTransport.id, dtlsParameters }).then(cb, eb));
  }

  private options(p: any) {
    return {
      id: p.id,
      iceParameters: p.iceParameters,
      iceCandidates: p.iceCandidates,
      dtlsParameters: p.dtlsParameters,
      iceServers: p.iceServers || [],
      iceTransportPolicy: p.iceTransportPolicy || 'all',
    };
  }

  private listen(): void {
    const onNew = (p: RemoteProducer) => void this.consume(p);
    const onClosed = ({ producerId }: { producerId: string }) => this.dropConsumer(producerId);
    const onLeft = (p: { callId: string; userId: string }) => {
      if (String(p.callId) !== this.callId) return;
      this.remoteStreams.delete(String(p.userId));
      this.opts.onRemoteLeft?.(String(p.userId));
    };
    this.socket.on('mediasoup:newProducer', onNew);
    this.socket.on('mediasoup:producerClosed', onClosed);
    this.socket.on('call:participant-left', onLeft);
    this.offs.push(() => this.socket.off('mediasoup:newProducer', onNew), () => this.socket.off('mediasoup:producerClosed', onClosed), () => this.socket.off('call:participant-left', onLeft));
  }

  private async consume(p: RemoteProducer): Promise<void> {
    if (!p?.producerId || String(p.userId) === this.myUserId || [...this.consumers.values()].some((c) => c.consumer.producerId === p.producerId)) return;
    const r = await this.request('mediasoup:consume', { producerId: p.producerId, rtpCapabilities: this.device.rtpCapabilities });
    const consumer = await this.recvTransport.consume({ id: r.id, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters });
    this.consumers.set(consumer.id, { consumer, userId: String(p.userId) });
    await this.request('mediasoup:resumeConsumer', { consumerId: consumer.id });
    const stream = this.remoteStreams.get(String(p.userId)) || new MediaStream();
    stream.addTrack(consumer.track);
    this.remoteStreams.set(String(p.userId), stream);
    this.opts.onRemoteStream?.(String(p.userId), stream);
  }

  private dropConsumer(producerId: string): void {
    for (const [id, c] of this.consumers) {
      if (c.consumer.producerId !== producerId) continue;
      this.remoteStreams.get(c.userId)?.removeTrack(c.consumer.track);
      c.consumer.close();
      this.consumers.delete(id);
      const stream = this.remoteStreams.get(c.userId);
      if (stream) this.opts.onRemoteStream?.(c.userId, stream);
    }
  }
}
