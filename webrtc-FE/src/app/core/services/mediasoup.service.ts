import { Injectable } from '@angular/core';
import { Device } from 'mediasoup-client';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { Subject } from 'rxjs';
import { getCallMedia } from '../utils/media-devices.util';

interface JoinCallResponse {
  success: boolean;
  producers: {
    producerId: string;
    userId: string;
    kind: 'audio' | 'video';
    source?: string;
  }[];
}

type RemoteProducerInfo = JoinCallResponse['producers'][number];

interface RemoteVideoConsumer {
  consumer: any;
  userId: string;
  source: string;
  applied?: string;
}

/** TS 5.1 DOM lib predates `scalabilityMode` (supported by Chrome/Edge/Safari). */
type CameraEncoding = RTCRtpEncodingParameters & { scalabilityMode?: string };

const isMobileUa = (): boolean =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/**
 * Camera simulcast layers (VP8). L1T3 adds temporal layers so the SFU can drop
 * frame rate before resolution on a weak downlink.
 * Chrome caps layer count by capture size (720p → 3, 360p → 2), so mobile uses 2.
 *
 * Desktop caps match libwebrtc's own VP8 simulcast defaults (200k / 700k / 2.5M).
 * Lower caps starved the encoder: with camera-like content the 720p layer sat pinned
 * at its cap at QP≈41 while ~4 Mbps was available. These are ceilings only —
 * congestion control still lowers the rate, so no buffering or latency is added.
 */
function cameraEncodings(): CameraEncoding[] {
  if (isMobileUa()) {
    return [
      { scaleResolutionDownBy: 2, maxBitrate: 150_000, maxFramerate: 15, scalabilityMode: 'L1T3' },
      { scaleResolutionDownBy: 1, maxBitrate: 700_000, maxFramerate: 30, scalabilityMode: 'L1T3' },
    ];
  }
  return [
    { scaleResolutionDownBy: 4, maxBitrate: 200_000, maxFramerate: 15, scalabilityMode: 'L1T3' },
    { scaleResolutionDownBy: 2, maxBitrate: 700_000, maxFramerate: 30, scalabilityMode: 'L1T3' },
    { scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: 30, scalabilityMode: 'L1T3' },
  ];
}

@Injectable({
  providedIn: 'root'
})
export class MediasoupService {
  private device!: Device;
  private sendTransport: any;
  private recvTransport: any;
  private localStream!: MediaStream;
  private audioProducer: any;
  private videoProducer: any;
  private screenProducer: any;
  private screenStream: MediaStream | null = null;
  private remoteStreams = new Map<string, MediaStream>();
  private remoteScreenStreams = new Map<string, MediaStream>();
  private remoteVideoConsumers = new Map<string, RemoteVideoConsumer>();
  private focusedUserId: string | null = null;
  private layerTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastIceRestart = new Map<string, number>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private activeCallId: string | null = null;
  private remoteStreamSubject = new Subject<{ userId: string; stream: MediaStream; source?: string }>();
  remoteStream$ = this.remoteStreamSubject.asObservable();
  private screenClosedSubject = new Subject<string>();
  screenClosed$ = this.screenClosedSubject.asObservable();
  private localScreenEndedSubject = new Subject<void>();
  localScreenEnded$ = this.localScreenEndedSubject.asObservable();
  private localStreamSubject = new Subject<MediaStream>();
  localStream$ = this.localStreamSubject.asObservable();
  private initialized = false;

  hasAudioDevice = false;
  hasVideoDevice = false;

  private readonly onVisibilityChange = () => this.scheduleLayerUpdate(0);

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
  ) { }

  private myUserId(): string {
    return this.authService.getLoggedInUser()?._id || '';
  }

  private debugEnabled(): boolean {
    try {
      return localStorage.getItem('mediasoup:debug') === '1';
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (!this.device) {
      this.device = new Device();
      const routerRtpCapabilities = await this.getRouterRtpCapabilities();
      await this.device.load({ routerRtpCapabilities });
      this.listenForNewProducers();
    }

    await this.createSendTransport();
    await this.createRecvTransport();

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.initialized = true;
  }

  private getRouterRtpCapabilities(): Promise<any> {
    return this.request('mediasoup:getRouterRtpCapabilities', {}).then((r) => r.rtpCapabilities);
  }

  /** emitWithAck as a promise; rejects on `{ error }` responses. */
  private request(event: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(event, data, (response: any) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  /** Server params → mediasoup-client options (TURN creds are short-lived, issued per user). */
  private toTransportOptions(params: any): any {
    return {
      id: params.id,
      iceParameters: params.iceParameters,
      iceCandidates: params.iceCandidates,
      dtlsParameters: params.dtlsParameters,
      iceServers: params.iceServers || [],
      iceTransportPolicy: params.iceTransportPolicy || 'all',
    };
  }

  private async createSendTransport(): Promise<void> {
    // Recreate if previous transport was closed (reconnect / rejoin)
    if (this.sendTransport && !this.sendTransport.closed) {
      return;
    }
    const params = await this.createTransport('mediasoup:createSendTransport');
    this.sendTransport = this.device.createSendTransport(this.toTransportOptions(params));

    this.sendTransport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await this.connectTransport(this.sendTransport.id, dtlsParameters);
        callback();
      } catch (error) {
        errback(error);
      }
    });

    this.watchTransportConnection(this.sendTransport);

    this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }: any, callback: any, errback: any) => {
      try {
        this.socketService.emitWithAck(
          'mediasoup:produce',
          {
            transportId: this.sendTransport.id,
            kind,
            rtpParameters,
            appData
          },
          (response: any) => {
            if (response?.error) {
              errback(new Error(response.error));
              return;
            }
            callback({ id: response.id });
          }
        );
      } catch (error) {
        errback(error);
      }
    });
  }

  private async createRecvTransport(): Promise<void> {
    if (this.recvTransport && !this.recvTransport.closed) {
      return;
    }
    const params = await this.createTransport('mediasoup:createRecvTransport');
    this.recvTransport = this.device.createRecvTransport(this.toTransportOptions(params));

    this.recvTransport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await this.connectTransport(this.recvTransport.id, dtlsParameters);
        callback();
      } catch (error) {
        errback(error);
      }
    });

    this.watchTransportConnection(this.recvTransport);
  }

  /**
   * Recover from network changes (Wi-Fi ↔ cellular, sleep/wake) with an ICE restart.
   * 'disconnected' often self-heals, so wait briefly; 'failed' restarts immediately.
   */
  private watchTransportConnection(transport: any): void {
    transport.on('connectionstatechange', (state: string) => {
      console.log(`mediasoup ${transport.direction} transport:`, state);

      const pending = this.iceRestartTimers.get(transport.id);
      if (pending) {
        clearTimeout(pending);
        this.iceRestartTimers.delete(transport.id);
      }

      if (state === 'failed') {
        void this.restartIce(transport);
      } else if (state === 'disconnected') {
        this.iceRestartTimers.set(
          transport.id,
          setTimeout(() => {
            this.iceRestartTimers.delete(transport.id);
            if (transport.connectionState === 'disconnected') {
              void this.restartIce(transport);
            }
          }, 2500)
        );
      }
    });
  }

  private async restartIce(transport: any): Promise<void> {
    if (!transport || transport.closed) {
      return;
    }
    const last = this.lastIceRestart.get(transport.id) || 0;
    if (Date.now() - last < 5000) {
      return;
    }
    this.lastIceRestart.set(transport.id, Date.now());

    try {
      const response = await this.request('mediasoup:restartIce', { transportId: transport.id });
      if (response.iceServers) {
        // Fresh TURN credentials in case the old ones expired during a long call
        await transport.updateIceServers({ iceServers: response.iceServers });
      }
      await transport.restartIce({ iceParameters: response.iceParameters });
      console.log(`mediasoup ${transport.direction} transport: ICE restarted`);
    } catch (error) {
      console.warn('mediasoup ICE restart failed:', error);
    }
  }

  private createTransport(event: string): Promise<any> {
    return this.request(event, {});
  }

  private connectTransport(transportId: string, dtlsParameters: any): Promise<void> {
    return this.request('mediasoup:connectTransport', { transportId, dtlsParameters }).then(() => undefined);
  }

  async startLocalMedia(callType: 'audio' | 'video'): Promise<MediaStream> {
    const media = await getCallMedia(callType === 'video');
    this.localStream = media.stream;
    this.hasAudioDevice = media.hasAudio;
    this.hasVideoDevice = media.hasVideo;

    this.localStreamSubject.next(this.localStream);

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      try {
        audioTrack.contentHint = 'speech';
      } catch {
        // ignore
      }
      this.audioProducer = await this.sendTransport.produce({
        track: audioTrack,
        disableTrackOnPause: false,
        zeroRtpOnPause: false,
        codecOptions: {
          opusStereo: false,
          opusDtx: true,
          // In-band FEC rides in the next packet: no added delay, recovers single losses
          opusFec: true,
          opusNack: true,
          // 20 ms is Opus/NetEq's sweet spot; 10 ms doubles packet rate and overhead
          opusPtime: 20,
          opusMaxPlaybackRate: 48000,
          opusMaxAverageBitrate: 32000,
        },
      });
      await this.boostSenderPriority(this.audioProducer);
    }

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      this.videoProducer = await this.produceCamera(videoTrack);
    }

    // Other peers may have missed the produce event under load — nudge a resync locally too
    if (this.activeCallId) {
      setTimeout(() => void this.syncProducers(this.activeCallId!), 500);
      setTimeout(() => void this.syncProducers(this.activeCallId!), 2000);
    }

    return this.localStream;
  }

  /** Simulcast camera producer; falls back to one layer where simulcast/SVC modes are unsupported. */
  private async produceCamera(videoTrack: MediaStreamTrack): Promise<any> {
    try {
      videoTrack.contentHint = 'motion';
    } catch {
      // ignore
    }

    const codecOptions = { videoGoogleStartBitrate: 1000 };
    const attempts: CameraEncoding[][] = [
      cameraEncodings(),
      cameraEncodings().map(({ scalabilityMode, ...rest }) => rest),
      [{ maxBitrate: isMobileUa() ? 500_000 : 2_500_000, maxFramerate: 30 }],
    ];

    let lastError: unknown;
    for (const encodings of attempts) {
      try {
        const producer = await this.sendTransport.produce({ track: videoTrack, encodings, codecOptions });
        // Let Chrome trade frame rate and resolution together under CPU/bandwidth pressure
        await this.setDegradationPreference(producer, 'balanced');
        if (this.debugEnabled()) {
          console.log(`[mediasoup] camera producing with ${encodings.length} encoding(s)`);
        }
        return producer;
      } catch (error) {
        lastError = error;
        console.warn('[mediasoup] camera produce attempt failed, retrying with simpler encodings', error);
      }
    }
    throw lastError;
  }

  private async boostSenderPriority(producer: any): Promise<void> {
    try {
      const sender: RTCRtpSender | undefined = producer?.rtpSender;
      const params = sender?.getParameters?.();
      if (!sender || !params?.encodings?.length) {
        return;
      }
      params.encodings = params.encodings.map((encoding: RTCRtpEncodingParameters) => ({
        ...encoding,
        priority: 'high',
        networkPriority: 'high',
      }));
      await sender.setParameters(params);
    } catch {
      // ignore unsupported browsers
    }
  }

  private async setDegradationPreference(
    producer: any,
    preference: 'balanced' | 'maintain-framerate' | 'maintain-resolution'
  ): Promise<void> {
    try {
      const sender: RTCRtpSender | undefined = producer?.rtpSender;
      const params: any = sender?.getParameters?.();
      if (!sender || !params) {
        return;
      }
      params.degradationPreference = preference;
      await sender.setParameters(params);
    } catch {
      // ignore unsupported browsers
    }
  }

  private listenersBound = false;
  private consumedProducerIds = new Set<string>();
  private consumeChain: Promise<void> = Promise.resolve();

  listenForNewProducers(): void {
    if (this.listenersBound) {
      return;
    }
    this.listenersBound = true;

    this.socketService.on('mediasoup:newProducer', (data: any) => {
      if (!data?.producerId) {
        return;
      }
      if (data.userId && data.userId === this.myUserId()) {
        return;
      }
      void this.consumeProducer(
        data.producerId,
        data.userId,
        data.kind,
        data.source || 'camera'
      );
    });

    this.socketService.on('mediasoup:producerClosed', (data: any) => {
      if (data?.producerId) {
        this.consumedProducerIds.delete(data.producerId);
      }
      if (data?.consumerId && this.remoteVideoConsumers.delete(data.consumerId)) {
        this.scheduleLayerUpdate();
      }
      if (data?.userId) {
        if (data?.source === 'screen') {
          this.remoteScreenStreams.delete(data.userId);
          this.screenClosedSubject.next(data.userId);
        } else {
          // Drop stale tracks so a later re-produce can bind cleanly
          this.remoteStreams.delete(data.userId);
        }
      }
      // Producer was replaced — pull fresh list
      if (this.activeCallId) {
        void this.syncProducers(this.activeCallId);
      }
    });
  }

  async consumeProducer(
    producerId: string,
    userId: string,
    kind: 'audio' | 'video',
    source: string = 'camera'
  ): Promise<void> {
    // Serialize consumes — parallel recvTransport.consume races freeze other tiles.
    // Always advance the chain even on timeout so one hang cannot freeze the room.
    this.consumeChain = this.consumeChain.then(async () => {
      try {
        await this.withTimeout(
          this.consumeProducerNow(producerId, userId, kind, source),
          10000,
          `consume ${producerId}`
        );
      } catch (err) {
        this.consumedProducerIds.delete(producerId);
        console.warn('consumeProducer failed:', err);
      }
    });
    return this.consumeChain;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private async consumeProducerNow(
    producerId: string,
    userId: string,
    kind: 'audio' | 'video',
    source: string
  ): Promise<void> {
    if (!producerId || this.consumedProducerIds.has(producerId)) {
      return;
    }
    if (userId && userId === this.myUserId()) {
      return;
    }
    if (!this.recvTransport || this.recvTransport.closed) {
      await this.createRecvTransport();
    }

    this.consumedProducerIds.add(producerId);

    try {
      const response = await this.withTimeout(
        this.requestConsumer(producerId),
        8000,
        `requestConsumer ${producerId}`
      );
      const consumer = await this.recvTransport.consume({
        id: response.id,
        producerId: response.producerId,
        kind: response.kind,
        rtpParameters: response.rtpParameters,
        // Separate sync groups for mic vs camera: Chrome otherwise delays audio to
        // lip-sync with video, so a jittery/freezing video drags audio latency up.
        streamId: `${userId}-${response.kind === 'audio' ? 'mic' : source}`,
      });

      if (consumer.kind === 'audio' && consumer.rtpReceiver && this.debugEnabled()) {
        this.startAudioStatsMonitoring(consumer.rtpReceiver);
      }

      try {
        consumer.track.contentHint = consumer.kind === 'audio' ? 'speech' : 'motion';
      } catch {
        // ignore
      }

      const isScreen = source === 'screen' && kind === 'video';
      let stream = isScreen
        ? this.remoteScreenStreams.get(userId)
        : this.remoteStreams.get(userId);

      if (!stream) {
        stream = new MediaStream();
        if (isScreen) {
          this.remoteScreenStreams.set(userId, stream);
        } else {
          this.remoteStreams.set(userId, stream);
        }
      }

      if (!stream.getTracks().includes(consumer.track)) {
        stream.addTrack(consumer.track);
      }
      try {
        consumer.track.enabled = true;
      } catch {
        // ignore
      }

      await this.withTimeout(this.resumeConsumer(consumer.id), 8000, `resume ${consumer.id}`);

      if (consumer.kind === 'video') {
        this.remoteVideoConsumers.set(consumer.id, { consumer, userId, source });
        consumer.observer?.on?.('close', () => {
          if (this.remoteVideoConsumers.delete(consumer.id)) {
            this.scheduleLayerUpdate();
          }
        });
        this.scheduleLayerUpdate();
      }

      const emit = () => this.remoteStreamSubject.next({ userId, stream: stream!, source });
      emit();
      // First packet often arrives after unmute — re-emit so UI binds a live frame
      if (consumer.track.muted) {
        consumer.track.addEventListener('unmute', () => emit(), { once: true });
      }
      // Re-emit shortly after so Angular video elements pick up the live track
      setTimeout(emit, 300);
      setTimeout(emit, 1000);
    } catch (error) {
      this.consumedProducerIds.delete(producerId);
      throw error;
    }
  }

  /**
   * Which layer each remote camera should receive. This is a cap — mediasoup's
   * bandwidth estimation still steps down (and back up) within it.
   *  - tab hidden: lowest layer, lowest frame rate
   *  - sidebar layout: focused tile full quality, thumbnails lowest layer
   *  - grid: quality drops as tiles get smaller
   */
  setFocusedUser(userId: string | null): void {
    if (this.focusedUserId === userId) {
      return;
    }
    this.focusedUserId = userId;
    this.scheduleLayerUpdate(0);
  }

  private scheduleLayerUpdate(delayMs = 300): void {
    if (this.layerTimer) {
      clearTimeout(this.layerTimer);
    }
    this.layerTimer = setTimeout(() => {
      this.layerTimer = null;
      this.applyLayerPolicy();
    }, delayMs);
  }

  private applyLayerPolicy(): void {
    const cameras = [...this.remoteVideoConsumers.values()].filter(
      (v) => v.source !== 'screen' && !v.consumer.closed
    );
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

    for (const entry of cameras) {
      let spatialLayer: number;
      if (hidden) {
        spatialLayer = 0;
      } else if (this.focusedUserId) {
        spatialLayer = entry.userId === this.focusedUserId ? 2 : 0;
      } else {
        spatialLayer = cameras.length <= 2 ? 2 : cameras.length <= 6 ? 1 : 0;
      }
      const temporalLayer = hidden ? 0 : 2;
      const key = `${spatialLayer}:${temporalLayer}`;
      if (entry.applied === key) {
        continue;
      }
      entry.applied = key;
      this.socketService.emitWithAck(
        'mediasoup:setPreferredLayers',
        { consumerId: entry.consumer.id, spatialLayer, temporalLayer },
        (response: any) => {
          if (response?.error) {
            entry.applied = undefined;
          }
        }
      );
    }
  }

  private requestConsumer(producerId: string): Promise<any> {
    return this.request('mediasoup:consume', {
      producerId,
      rtpCapabilities: this.device.rtpCapabilities
    });
  }

  private resumeConsumer(consumerId: string): Promise<void> {
    return this.request('mediasoup:resumeConsumer', { consumerId }).then(() => undefined);
  }

  joinCall(callId: string, callType: 'audio' | 'video'): Promise<JoinCallResponse> {
    this.activeCallId = callId;
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(
        'mediasoup:joinCall',
        { callId, callType },
        (response: JoinCallResponse & { error?: string }) => {
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          this.startProducerSyncLoop(callId);
          // Catch producers that raced during join
          void this.syncProducers(callId);
          resolve(response);
        }
      );
    });
  }

  /** Pull any producers we missed (reconnect / late join / missed socket event). */
  async syncProducers(callId?: string): Promise<void> {
    const id = callId || this.activeCallId;
    if (!id) {
      return;
    }

    const producers = await new Promise<RemoteProducerInfo[]>((resolve) => {
      this.socketService.emitWithAck(
        'mediasoup:syncProducers',
        { callId: id },
        (response: { producers?: RemoteProducerInfo[]; error?: string }) => {
          if (response?.error) {
            console.warn('syncProducers:', response.error);
            resolve([]);
            return;
          }
          resolve(response?.producers || []);
        }
      );
    });

    for (const producer of producers) {
      if (this.consumedProducerIds.has(producer.producerId)) {
        continue;
      }
      if (producer.userId === this.myUserId()) {
        continue;
      }
      void this.consumeProducer(
        producer.producerId,
        producer.userId,
        producer.kind,
        producer.source || 'camera'
      );
    }
  }

  private startProducerSyncLoop(callId: string): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    // Resync a few times early in the call — covers missed newProducer under load
    let ticks = 0;
    this.syncTimer = setInterval(() => {
      ticks += 1;
      void this.syncProducers(callId);
      if (ticks >= 8 && this.syncTimer) {
        clearInterval(this.syncTimer);
        // Keep a slow heartbeat while still in call
        this.syncTimer = setInterval(() => void this.syncProducers(callId), 8000);
      }
    }, 1500);
  }

  setAudioEnabled(enabled: boolean): void {
    if (!this.hasAudioDevice) {
      return;
    }
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    if (this.audioProducer) {
      if (enabled) {
        this.audioProducer.resume();
      } else {
        this.audioProducer.pause();
      }
    }
  }

  setVideoEnabled(enabled: boolean): void {
    if (!this.hasVideoDevice || this.screenStream) {
      return;
    }
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
    if (this.videoProducer) {
      if (enabled) {
        this.videoProducer.resume();
      } else {
        this.videoProducer.pause();
      }
    }
  }

  /** Audio call → turn on camera mid-call (produce video if needed). */
  async enableCamera(): Promise<MediaStream> {
    if (this.videoProducer && this.hasVideoDevice) {
      this.setVideoEnabled(true);
      return this.localStream!;
    }

    const media = await getCallMedia(true);
    const videoTrack = media.stream.getVideoTracks()[0];
    if (!videoTrack) {
      this.hasVideoDevice = false;
      throw new Error('No camera available');
    }

    this.hasVideoDevice = true;
    if (!this.localStream) {
      this.localStream = media.stream;
    } else {
      // Keep existing mic; attach new video track
      this.localStream.getVideoTracks().forEach((t) => {
        this.localStream!.removeTrack(t);
        t.stop();
      });
      this.localStream.addTrack(videoTrack);
      // Stop unused audio from the fresh getUserMedia if we already have mic
      media.stream.getAudioTracks().forEach((t) => t.stop());
    }

    this.videoProducer = await this.produceCamera(videoTrack);
    this.localStreamSubject.next(this.localStream);
    return this.localStream;
  }

  async startScreenShare(): Promise<MediaStream> {
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 15,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      } as MediaTrackConstraints,
      audio: false,
    });

    const screenTrack = this.screenStream.getVideoTracks()[0];
    if (!screenTrack) {
      throw new Error('No screen track');
    }
    try {
      // Text/UI content: encoder keeps sharpness and drops frames instead
      screenTrack.contentHint = 'detail';
    } catch {
      // ignore
    }

    // Keep camera producer, publish screen as its own producer
    if (this.videoProducer) {
      try {
        await this.videoProducer.pause();
      } catch {
        // ignore
      }
    }

    this.screenProducer = await this.sendTransport.produce({
      track: screenTrack,
      appData: { source: 'screen' },
      encodings: [{ maxBitrate: 1_500_000, maxFramerate: 15 }],
      codecOptions: { videoGoogleStartBitrate: 1000 },
    });
    await this.setDegradationPreference(this.screenProducer, 'maintain-resolution');

    screenTrack.onended = () => {
      void this.stopScreenShare().then(() => {
        this.localScreenEndedSubject.next();
      });
    };

    return this.screenStream;
  }

  async stopScreenShare(): Promise<MediaStream | null> {
    if (!this.screenStream && !this.screenProducer) {
      return this.localStream || null;
    }

    try {
      this.screenProducer?.close();
    } catch {
      // ignore
    }
    this.screenProducer = null;

    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;

    if (this.videoProducer && this.hasVideoDevice) {
      try {
        await this.videoProducer.resume();
      } catch {
        // ignore
      }
    }

    return this.localStream || null;
  }

  isScreenSharing(): boolean {
    return !!this.screenStream || !!this.screenProducer;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream || null;
  }

  getRemoteScreenStream(userId: string): MediaStream | undefined {
    return this.remoteScreenStreams.get(userId);
  }

  async close(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.layerTimer) {
      clearTimeout(this.layerTimer);
      this.layerTimer = null;
    }
    if (this.audioStatsInterval) {
      clearInterval(this.audioStatsInterval);
      this.audioStatsInterval = null;
    }
    this.iceRestartTimers.forEach((t) => clearTimeout(t));
    this.iceRestartTimers.clear();
    this.lastIceRestart.clear();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.activeCallId = null;
    this.remoteVideoConsumers.clear();
    this.focusedUserId = null;

    try {
      this.screenStream?.getTracks().forEach((track) => track.stop());
      this.screenProducer?.close();
      this.audioProducer?.close();
      this.videoProducer?.close();
      this.sendTransport?.close();
      this.recvTransport?.close();
    } catch {
      // ignore close errors during teardown
    }

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.remoteStreams.clear();
    this.remoteScreenStreams.clear();
    this.consumedProducerIds.clear();
    this.consumeChain = Promise.resolve();
    this.audioProducer = null;
    this.videoProducer = null;
    this.screenProducer = null;
    this.screenStream = null;
    this.hasAudioDevice = false;
    this.hasVideoDevice = false;
    this.sendTransport = null;
    this.recvTransport = null;
    this.localStream = null!;
    this.initialized = false;
  }

  getDevice(): Device {
    if (!this.device) {
      throw new Error('mediasoup Device is not initialized');
    }
    return this.device;
  }

  private previousAudioStats: any = null;

  private audioStatsInterval:
    ReturnType<typeof setInterval> | null = null;

  /**
   * Debug only: enable with localStorage.setItem('mediasoup:debug', '1').
   * Logs per-interval jitter-buffer delay (the number that matters for audio latency).
   */
  private startAudioStatsMonitoring(
    receiver: RTCRtpReceiver
  ): void {
    if (this.audioStatsInterval) {
      clearInterval(this.audioStatsInterval);
    }

    this.previousAudioStats = null;

    this.audioStatsInterval = setInterval(async () => {
      try {
        const stats = await receiver.getStats();

        let inboundAudio: any = null;
        let pair: any = null;
        stats.forEach((stat: any) => {
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
            inboundAudio = stat;
          }
          if (stat.type === 'candidate-pair' && stat.nominated) {
            pair = stat;
          }
        });

        if (!inboundAudio) {
          return;
        }

        const previous = this.previousAudioStats;
        const delta = (key: string) =>
          previous ? (inboundAudio[key] || 0) - (previous[key] || 0) : 0;

        const deltaEmitted = delta('jitterBufferEmittedCount');
        const intervalJitterBufferDelay =
          deltaEmitted > 0 ? (delta('jitterBufferDelay') / deltaEmitted) * 1000 : 0;
        const intervalTargetDelay =
          deltaEmitted > 0 ? (delta('jitterBufferTargetDelay') / deltaEmitted) * 1000 : 0;

        console.table({
          rtt_ms: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : undefined,
          jitter_ms: (inboundAudio.jitter || 0) * 1000,
          packetsReceived: inboundAudio.packetsReceived,
          packetsLost: inboundAudio.packetsLost,
          deltaPacketsLost: delta('packetsLost'),
          intervalJitterBufferDelay_ms: intervalJitterBufferDelay,
          intervalTargetDelay_ms: intervalTargetDelay,
          deltaConcealedSamples: delta('concealedSamples'),
          fecPacketsReceived: inboundAudio.fecPacketsReceived,
        });

        this.previousAudioStats = inboundAudio;
      } catch (error) {
        console.error(
          '❌ Failed to get audio WebRTC stats:',
          error
        );
      }
    }, 2000);
  }
}
