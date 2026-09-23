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
  private activeConsumers = new Set<any>();
  private jitterClampTimer: ReturnType<typeof setInterval> | null = null;
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

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
  ) { }

  private myUserId(): string {
    return this.authService.getLoggedInUser()?._id || '';
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

    this.initialized = true;
  }

  private getRouterRtpCapabilities(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(
        'mediasoup:getRouterRtpCapabilities',
        {},
        (response: any) => {
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response.rtpCapabilities);
        }
      );
    });
  }

  private async createSendTransport(): Promise<void> {
    // Recreate if previous transport was closed (reconnect / rejoin)
    if (this.sendTransport && !this.sendTransport.closed) {
      return;
    }
    const params = await this.createTransport('mediasoup:createSendTransport');
    this.sendTransport = this.device.createSendTransport(params);

    this.sendTransport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await this.connectTransport(this.sendTransport.id, dtlsParameters);
        callback();
      } catch (error) {
        errback(error);
      }
    });

    this.sendTransport.on('connectionstatechange', (state: string) => {
      console.log('mediasoup send transport:', state);
    });

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
    this.recvTransport = this.device.createRecvTransport(params);

    this.recvTransport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await this.connectTransport(this.recvTransport.id, dtlsParameters);
        callback();
      } catch (error) {
        errback(error);
      }
    });

    this.recvTransport.on('connectionstatechange', (state: string) => {
      console.log('mediasoup recv transport:', state);
    });
  }

  private createTransport(event: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(event, {}, (response: any) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  private connectTransport(transportId: string, dtlsParameters: any): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(
        'mediasoup:connectTransport',
        { transportId, dtlsParameters },
        (response: any) => {
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve();
        }
      );
    });
  }

  /**
   * Returns true when ICE selected a mesh/LAN UDP path (normal-call latency).
   * Returns false when still connecting, failed, or only a slow relay remains.
   */
  async hasLowLatencyMediaPath(timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.inspectIcePath();
      if (ok === true) {
        return true;
      }
      if (ok === false) {
        // connected but not low-latency
        return false;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /** null = not ready yet, true = low latency, false = high latency / failed */
  private async inspectIcePath(): Promise<boolean | null> {
    const transports = [this.sendTransport, this.recvTransport].filter(Boolean);
    if (!transports.length) {
      return null;
    }

    let sawConnected = false;
    for (const transport of transports) {
      try {
        const stats: Map<string, any> = await transport.getStats();
        let selectedRemoteIp = '';
        let selectedProtocol = '';

        stats.forEach((report) => {
          if (
            report.type === 'candidate-pair' &&
            (report.nominated || report.selected || report.state === 'succeeded')
          ) {
            sawConnected = true;
            const remote = stats.get(report.remoteCandidateId);
            if (remote) {
              selectedRemoteIp = remote.ip || remote.address || '';
              selectedProtocol = remote.protocol || '';
            }
          }
        });

        if (selectedRemoteIp) {
          const low =
            selectedRemoteIp.startsWith('100.') ||
            selectedRemoteIp.startsWith('192.168.') ||
            selectedRemoteIp.startsWith('10.') ||
            selectedRemoteIp.startsWith('172.');
          const udp = String(selectedProtocol).toLowerCase() !== 'tcp';
          console.log(
            `[mediasoup] ICE path ${selectedRemoteIp}/${selectedProtocol} lowLatency=${low && udp}`
          );
          return low; // LAN/mesh TCP is still much better than bore; accept it
        }
      } catch {
        // ignore
      }
    }

    return sawConnected ? false : null;
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
          // FEC helps lossy links but adds delay — keep light FEC off for lowest latency
          opusFec: false,
          opusNack: true,
          opusPtime: 10,
          opusMaxPlaybackRate: 48000,
          opusMaxAverageBitrate: 24000,
        },
      });
      await this.boostSenderPriority(this.audioProducer);
    }

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        videoTrack.contentHint = 'motion';
      } catch {
        // ignore
      }
      const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      this.videoProducer = await this.sendTransport.produce({
        track: videoTrack,
        // Single layer — multi-encoding can stall other consumers on weak links
        encodings: [
          {
            maxBitrate: mobile ? 250_000 : 450_000,
            maxFramerate: 24,
            priority: 'high',
            networkPriority: 'high',
          } as RTCRtpEncodingParameters,
        ],
        codecOptions: {
          videoGoogleStartBitrate: mobile ? 150 : 250,
          videoGoogleMaxBitrate: mobile ? 400 : 600,
          videoGoogleMinBitrate: 80,
        },
      });
      await this.boostSenderPriority(this.videoProducer);
    }

    // Other peers may have missed the produce event under load — nudge a resync locally too
    if (this.activeCallId) {
      setTimeout(() => void this.syncProducers(this.activeCallId!), 500);
      setTimeout(() => void this.syncProducers(this.activeCallId!), 2000);
    }

    return this.localStream;
  }

  private async boostSenderPriority(producer: any): Promise<void> {
    try {
      const sender: RTCRtpSender | undefined = producer?.rtpSender;
      const params = sender?.getParameters?.();
      if (!sender || !params?.encodings?.length) {
        return;
      }
      params.degradationPreference = 'maintain-framerate';
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
        rtpParameters: response.rtpParameters
      });

      const receiver = consumer.rtpReceiver;

      if (receiver) {
        this.startAudioStatsMonitoring(consumer.rtpReceiver);
      }

      this.applyLowLatencyReceiver(consumer);
      this.activeConsumers.add(consumer);
      this.startJitterClampLoop();

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
      this.applyLowLatencyReceiver(consumer);

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

  /** Minimize Chrome/Edge/Safari jitter buffer & playout delay. */
  private applyLowLatencyReceiver(consumer: any): void {
    try {
      const receiver: RTCRtpReceiver | undefined = consumer?.rtpReceiver;
      if (!receiver) {
        return;
      }
      (receiver as any).playoutDelayHint = 0;

      if ('jitterBufferTarget' in receiver) {
        // 0 = lowest latency (may glitch on lossy links)
        (receiver as any).jitterBufferTarget = 0;
      }
    } catch {
      // ignore unsupported browsers
    }

    try {
      if (consumer.track) {
        consumer.track.contentHint = consumer.kind === 'audio' ? 'speech' : 'motion';
        consumer.track.enabled = true;
      }
    } catch {
      // ignore
    }
  }

  /** Chrome raises jitterBufferTarget under packet jitter — re-clamp while in call. */
  private startJitterClampLoop(): void {
    if (this.jitterClampTimer) {
      return;
    }
    this.jitterClampTimer = setInterval(() => {
      this.activeConsumers.forEach((consumer) => {
        if (consumer?.closed) {
          this.activeConsumers.delete(consumer);
          return;
        }
        this.applyLowLatencyReceiver(consumer);
      });
      if (!this.activeConsumers.size && this.jitterClampTimer) {
        clearInterval(this.jitterClampTimer);
        this.jitterClampTimer = null;
      }
    }, 250);
  }

  private requestConsumer(producerId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(
        'mediasoup:consume',
        {
          producerId,
          rtpCapabilities: this.device.rtpCapabilities
        },
        (response: any) => {
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        }
      );
    });
  }

  private resumeConsumer(consumerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socketService.emitWithAck(
        'mediasoup:resumeConsumer',
        { consumerId },
        (response: any) => {
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve();
        }
      );
    });
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

    try {
      videoTrack.contentHint = 'motion';
    } catch {
      // ignore
    }

    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    this.videoProducer = await this.sendTransport.produce({
      track: videoTrack,
      encodings: [
        {
          maxBitrate: mobile ? 350_000 : 700_000,
          maxFramerate: 30,
          priority: 'high',
          networkPriority: 'high',
        } as RTCRtpEncodingParameters,
      ],
      codecOptions: {
        videoGoogleStartBitrate: mobile ? 300 : 500,
        videoGoogleMaxBitrate: mobile ? 500 : 900,
        videoGoogleMinBitrate: 100,
      },
    });
    await this.boostSenderPriority(this.videoProducer);
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
    });

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
    if (this.jitterClampTimer) {
      clearInterval(this.jitterClampTimer);
      this.jitterClampTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.activeCallId = null;
    this.activeConsumers.clear();

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
  private previousPlayoutStats: any = null;

  private audioStatsInterval:
    ReturnType<typeof setInterval> | null = null;

  private startAudioStatsMonitoring(
    receiver: RTCRtpReceiver
  ): void {
    if (this.audioStatsInterval) {
      clearInterval(this.audioStatsInterval);
    }

    this.previousAudioStats = null;
    this.previousPlayoutStats = null;

    this.audioStatsInterval = setInterval(async () => {
      try {
        const stats = await receiver.getStats();

        let inboundAudio: any = null;
        let playoutAudio: any = null;

        stats.forEach((stat: any) => {
          if (
            stat.type === 'inbound-rtp' &&
            stat.kind === 'audio'
          ) {
            inboundAudio = stat;
          }

          if (
            stat.type === 'media-playout' &&
            stat.kind === 'audio'
          ) {
            playoutAudio = stat;
          }
        });

        if (!inboundAudio) {
          console.warn('No inbound audio stats found');
          return;
        }

        const emittedCount =
          inboundAudio.jitterBufferEmittedCount || 0;

        const jitterBufferDelay =
          inboundAudio.jitterBufferDelay || 0;

        const targetDelay =
          inboundAudio.jitterBufferTargetDelay || 0;

        const minimumDelay =
          inboundAudio.jitterBufferMinimumDelay || 0;

        const avgJitterBufferDelay =
          emittedCount > 0
            ? (jitterBufferDelay / emittedCount) * 1000
            : 0;

        const avgTargetDelay =
          emittedCount > 0
            ? (targetDelay / emittedCount) * 1000
            : 0;

        const avgMinimumDelay =
          emittedCount > 0
            ? (minimumDelay / emittedCount) * 1000
            : 0;

        /*
         * Delta values
         */
        const previous = this.previousAudioStats;

        const deltaPacketsReceived =
          previous
            ? (inboundAudio.packetsReceived || 0) -
            (previous.packetsReceived || 0)
            : 0;

        const deltaPacketsLost =
          previous
            ? (inboundAudio.packetsLost || 0) -
            (previous.packetsLost || 0)
            : 0;

        const deltaPacketsDiscarded =
          previous
            ? (inboundAudio.packetsDiscarded || 0) -
            (previous.packetsDiscarded || 0)
            : 0;

        const deltaConcealedSamples =
          previous
            ? (inboundAudio.concealedSamples || 0) -
            (previous.concealedSamples || 0)
            : 0;

        const deltaInsertedSamples =
          previous
            ? (inboundAudio.insertedSamplesForDeceleration || 0) -
            (previous.insertedSamplesForDeceleration || 0)
            : 0;

        const deltaRemovedSamples =
          previous
            ? (inboundAudio.removedSamplesForAcceleration || 0) -
            (previous.removedSamplesForAcceleration || 0)
            : 0;

        const deltaJitterBufferDelay =
          previous
            ? (inboundAudio.jitterBufferDelay || 0) -
            (previous.jitterBufferDelay || 0)
            : 0;

        const deltaJitterBufferEmittedCount =
          previous
            ? (inboundAudio.jitterBufferEmittedCount || 0) -
            (previous.jitterBufferEmittedCount || 0)
            : 0;

        const intervalJitterBufferDelay =
          deltaJitterBufferEmittedCount > 0
            ? (
              deltaJitterBufferDelay /
              deltaJitterBufferEmittedCount
            ) * 1000
            : 0;

        /*
         * --------------------------------------------------
         * AUDIO PLAYOUT STATS
         * --------------------------------------------------
         */

        let avgPlayoutDelay = 0;
        let intervalPlayoutDelay = 0;

        if (playoutAudio) {
          const totalSamplesCount =
            playoutAudio.totalSamplesCount || 0;

          const totalPlayoutDelay =
            playoutAudio.totalPlayoutDelay || 0;

          /*
           * Cumulative average playout delay.
           *
           * totalPlayoutDelay = seconds
           * totalSamplesCount = number of samples
           */
          avgPlayoutDelay =
            totalSamplesCount > 0
              ? (
                totalPlayoutDelay /
                totalSamplesCount
              ) * 1000
              : 0;

          /*
           * Interval playout delay
           */
          if (this.previousPlayoutStats) {
            const deltaPlayoutDelay =
              totalPlayoutDelay -
              (
                this.previousPlayoutStats
                  .totalPlayoutDelay || 0
              );

            const deltaSamplesCount =
              totalSamplesCount -
              (
                this.previousPlayoutStats
                  .totalSamplesCount || 0
              );

            intervalPlayoutDelay =
              deltaSamplesCount > 0
                ? (
                  deltaPlayoutDelay /
                  deltaSamplesCount
                ) * 1000
                : 0;
          }
        }

        /*
         * --------------------------------------------------
         * LOG
         * --------------------------------------------------
         */

        console.log(
          '================ AUDIO WEBRTC STATS ================'
        );

        console.table({
          timestamp: inboundAudio.timestamp,

          /*
           * Network
           */
          packetsReceived:
            inboundAudio.packetsReceived,

          packetsLost:
            inboundAudio.packetsLost,

          packetsDiscarded:
            inboundAudio.packetsDiscarded,

          deltaPacketsReceived,

          deltaPacketsLost,

          deltaPacketsDiscarded,

          jitter_ms:
            (inboundAudio.jitter || 0) * 1000,

          /*
           * Jitter buffer
           */
          avgJitterBufferDelay_ms:
            avgJitterBufferDelay,

          avgTargetDelay_ms:
            avgTargetDelay,

          avgMinimumDelay_ms:
            avgMinimumDelay,

          intervalJitterBufferDelay_ms:
            intervalJitterBufferDelay,

          /*
           * Audio recovery
           */
          concealedSamples:
            inboundAudio.concealedSamples,

          deltaConcealedSamples,

          concealmentEvents:
            inboundAudio.concealmentEvents,

          insertedSamplesForDeceleration:
            inboundAudio.insertedSamplesForDeceleration,

          deltaInsertedSamples,

          removedSamplesForAcceleration:
            inboundAudio.removedSamplesForAcceleration,

          deltaRemovedSamples,

          /*
           * Playout
           */
          avgPlayoutDelay_ms:
            avgPlayoutDelay,

          intervalPlayoutDelay_ms:
            intervalPlayoutDelay,

          /*
           * Other
           */
          totalSamplesReceived:
            inboundAudio.totalSamplesReceived,

          totalSamplesDuration:
            inboundAudio.totalSamplesDuration,

          lastPacketReceivedTimestamp:
            inboundAudio.lastPacketReceivedTimestamp,

          estimatedPlayoutTimestamp:
            inboundAudio.estimatedPlayoutTimestamp,

          playoutId:
            inboundAudio.playoutId
        });

        /*
         * Keep previous values.
         */
        this.previousAudioStats = inboundAudio;

        if (playoutAudio) {
          this.previousPlayoutStats = playoutAudio;
        }

      } catch (error) {
        console.error(
          '❌ Failed to get audio WebRTC stats:',
          error
        );
      }
    }, 1000);
  }
}
