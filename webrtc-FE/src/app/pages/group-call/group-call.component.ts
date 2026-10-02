import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { SocketService } from '../../core/services/socket.service';
import { MediasoupService } from '../../core/services/mediasoup.service';
import { UserService } from '../../core/services/user.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ScreenShareOverlayService } from '../../core/services/screen-share-overlay.service';

interface CallParticipant {
  userId: string;
  username?: string;
  stream: MediaStream;
  hasVideo: boolean;
  /** Stable MediaStreams for <video>/<audio> — avoid recreating every bind (causes stuck tiles) */
  displayVideo?: MediaStream;
  displayAudio?: MediaStream;
}

@Component({
  selector: 'app-group-call',
  templateUrl: './group-call.component.html',
  styleUrls: ['./group-call.component.scss']
})
export class GroupCallComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('localVideoPip') localVideoPip!: ElementRef<HTMLVideoElement>;
  @ViewChild('screenVideo') screenVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('focusVideo') focusVideo!: ElementRef<HTMLVideoElement>;
  @ViewChildren('remoteVideo') remoteVideos!: QueryList<ElementRef<HTMLVideoElement>>;
  @ViewChildren('remoteAudio') remoteAudios!: QueryList<ElementRef<HTMLAudioElement>>;

  participants: CallParticipant[] = [];
  groupId!: string;
  callId!: string;
  callType: 'audio' | 'video' = 'video';
  myUserId = '';
  focusedUserId: string | null = null;

  isMuted = false;
  isVideoEnabled = true;
  isScreenSharing = false;
  isJoining = true;
  hasAudioDevice = false;
  hasVideoDevice = false;

  activeScreenUserId: string | null = null;
  activeScreenUsername = '';
  activeScreenStream: MediaStream | null = null;

  private remoteStreamSub?: Subscription;
  private callEndedSub?: Subscription;
  private participantLeftSub?: Subscription;
  private screenStartedSub?: Subscription;
  private screenStoppedSub?: Subscription;
  private screenClosedSub?: Subscription;
  private localScreenEndedSub?: Subscription;
  private mediaUpdatedSub?: Subscription;
  private remoteVideosSub?: Subscription;
  private remoteAudiosSub?: Subscription;
  private leftCall = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    private socketService: SocketService,
    private mediasoupService: MediasoupService,
    private userService: UserService,
    private alertService: AlertService,
    private screenOverlay: ScreenShareOverlayService,
    private cdr: ChangeDetectorRef
  ) { }

  get canStartScreenShare(): boolean {
    return !this.isScreenSharing && !this.activeScreenUserId;
  }

  /** Self + remotes; sidebar when more than 5 people total. */
  get totalCount(): number {
    return this.participants.length + 1;
  }

  get useSidebarLayout(): boolean {
    return this.totalCount > 5;
  }

  get displayCount(): number {
    return Math.max(1, this.totalCount);
  }

  get focusedParticipant(): CallParticipant | null {
    if (!this.focusedUserId) {
      return null;
    }
    return this.participants.find((p) => p.userId === this.focusedUserId) || null;
  }

  trackByUserId(_: number, p: CallParticipant): string {
    return p.userId;
  }

  hasVideoTrack(participant: CallParticipant): boolean {
    if (typeof participant.hasVideo === 'boolean') {
      return participant.hasVideo;
    }
    return !!participant.stream?.getVideoTracks?.().some((t) => t.readyState !== 'ended');
  }

  private refreshParticipantFlags(participant: CallParticipant): void {
    participant.hasVideo = !!participant.stream
      ?.getVideoTracks?.()
      .some((t) => t.readyState !== 'ended');
  }

  /** Keep element.srcObject identity stable so browsers keep decoding */
  private syncDisplayStreams(participant: CallParticipant): void {
    if (!participant.displayVideo) {
      participant.displayVideo = new MediaStream();
    }
    if (!participant.displayAudio) {
      participant.displayAudio = new MediaStream();
    }

    const wantVideo = new Set(
      participant.stream.getVideoTracks().filter((t) => t.readyState !== 'ended')
    );
    participant.displayVideo.getVideoTracks().forEach((t) => {
      if (!wantVideo.has(t)) {
        participant.displayVideo!.removeTrack(t);
      }
    });
    wantVideo.forEach((t) => {
      if (!participant.displayVideo!.getVideoTracks().includes(t)) {
        participant.displayVideo!.addTrack(t);
      }
    });

    const wantAudio = new Set(
      participant.stream.getAudioTracks().filter((t) => t.readyState !== 'ended')
    );
    participant.displayAudio.getAudioTracks().forEach((t) => {
      if (!wantAudio.has(t)) {
        participant.displayAudio!.removeTrack(t);
      }
    });
    wantAudio.forEach((t) => {
      if (!participant.displayAudio!.getAudioTracks().includes(t)) {
        participant.displayAudio!.addTrack(t);
      }
    });
  }

  selectParticipant(userId: string | null): void {
    this.focusedUserId = userId;
    this.syncLayerFocus();
    this.cdr.detectChanges();
    setTimeout(() => this.bindFocusAndLocal(), 40);
  }

  /** Sidebar: focused tile gets the top simulcast layer, thumbnails the lowest. */
  private syncLayerFocus(): void {
    this.mediasoupService.setFocusedUser(this.useSidebarLayout ? this.focusedUserId : null);
  }

  ngAfterViewInit(): void {
    this.remoteVideosSub = this.remoteVideos?.changes.subscribe(() => this.bindRemoteMedia());
    this.remoteAudiosSub = this.remoteAudios?.changes.subscribe(() => this.bindRemoteMedia());
  }

  async ngOnInit(): Promise<void> {
    this.groupId = this.route.snapshot.params['groupId'];
    this.callId = this.route.snapshot.queryParams['callId'];
    this.callType = this.route.snapshot.queryParams['callType'] || 'video';
    this.isVideoEnabled = this.callType === 'video';
    this.myUserId = this.authService.getLoggedInUser()?._id;

    if (!this.callId) {
      this.alertService.error('Missing call id');
      this.router.navigate(['/chat'], { replaceUrl: true });
      return;
    }

    void this.unlockAudioPlayback();

    this.remoteStreamSub = this.mediasoupService.remoteStream$.subscribe((data) => {
      if (data.source === 'screen') {
        this.activeScreenUserId = data.userId;
        this.activeScreenStream = data.stream;
        this.fetchScreenUsername(data.userId);
        this.cdr.detectChanges();
        this.bindScreenVideo();
        return;
      }

      const existing = this.participants.find((p) => p.userId === data.userId);
      if (existing) {
        existing.stream = data.stream;
        this.refreshParticipantFlags(existing);
      } else {
        const participant: CallParticipant = {
          userId: data.userId,
          stream: data.stream,
          hasVideo: false,
        };
        this.refreshParticipantFlags(participant);
        this.participants = [...this.participants, participant];
        this.fetchUsername(data.userId);
        if (this.useSidebarLayout && !this.focusedUserId) {
          this.focusedUserId = data.userId;
        }
      }
      this.syncLayerFocus();
      this.cdr.detectChanges();
      this.bindRemoteMedia();
      this.bindFocusAndLocal();
    });

    this.screenClosedSub = this.mediasoupService.screenClosed$.subscribe((userId) => {
      if (this.activeScreenUserId === userId) {
        this.clearActiveScreen();
      }
    });

    this.localScreenEndedSub = this.mediasoupService.localScreenEnded$.subscribe(() => {
      if (this.isScreenSharing) {
        void this.finishScreenShareUi();
      }
    });

    this.callEndedSub = this.socketService.onGroupCallEnded().subscribe((data: any) => {
      const endedId = data?.callId != null ? String(data.callId) : '';
      if (endedId && endedId === String(this.callId)) {
        this.alertService.info('Meeting ended');
        this.exitCall(false);
      }
    });

    this.participantLeftSub = this.socketService.onGroupCallParticipantLeft().subscribe((data: any) => {
      if (data?.callId != null && String(data.callId) !== String(this.callId)) {
        return;
      }
      if (data?.userId) {
        this.participants = this.participants.filter((p) => p.userId !== data.userId);
        if (this.focusedUserId === data.userId) {
          this.focusedUserId = this.participants[0]?.userId || null;
        }
        this.syncLayerFocus();
        if (this.activeScreenUserId === data.userId) {
          this.clearActiveScreen();
        }
        this.cdr.detectChanges();
      }
    });

    this.mediaUpdatedSub = this.socketService.onCallMediaUpdated().subscribe((data: any) => {
      if (data?.callId === this.callId && data?.callType) {
        this.callType = data.callType;
      }
    });

    this.screenStartedSub = this.socketService.onScreenStarted().subscribe((data: any) => {
      if (data?.callId !== this.callId) {
        return;
      }
      this.activeScreenUserId = data.userId;
      this.fetchScreenUsername(data.userId);
      if (data.userId !== this.myUserId) {
        this.alertService.info('Someone started screen sharing');
      }
    });

    this.screenStoppedSub = this.socketService.onScreenStopped().subscribe((data: any) => {
      if (data?.callId !== this.callId) {
        return;
      }
      if (this.isScreenSharing && data.userId === this.myUserId) {
        return;
      }
      this.clearActiveScreen();
    });

    try {
      const acceptResult = await this.socketService.acceptGroupCall(this.callId);
      if (acceptResult?.error) {
        throw new Error(acceptResult.error);
      }

      await this.mediasoupService.initialize();
      const response = await this.mediasoupService.joinCall(this.callId, this.callType);

      // Enter the room UI immediately — don't block on remote consumes / ICE
      let localStream: MediaStream;
      try {
        localStream = await this.mediasoupService.startLocalMedia(this.callType);
      } catch (mediaErr: any) {
        if (mediaErr?.name === 'NotAllowedError') {
          localStream = new MediaStream();
          this.hasAudioDevice = false;
          this.hasVideoDevice = false;
          this.isMuted = true;
          this.isVideoEnabled = false;
          this.alertService.warning('Media permission denied. You joined without mic/camera.');
        } else {
          throw mediaErr;
        }
      }

      this.hasAudioDevice = this.mediasoupService.hasAudioDevice;
      this.hasVideoDevice = this.mediasoupService.hasVideoDevice;
      this.isMuted = !this.hasAudioDevice;
      this.isVideoEnabled = this.hasVideoDevice && this.callType === 'video';
      this.setLocalVideo(localStream);
      this.isJoining = false;
      this.cdr.detectChanges();

      // Consume existing + future producers in the background
      void this.consumeExistingProducers(response.producers || []);

      void this.socketService.getScreenShareState(this.callId).then((state) => {
        if (state.sharerUserId) {
          this.activeScreenUserId = state.sharerUserId;
          this.fetchScreenUsername(state.sharerUserId);
          const existing = this.mediasoupService.getRemoteScreenStream(state.sharerUserId);
          if (existing) {
            this.activeScreenStream = existing;
            this.bindScreenVideo();
          }
        }
      });
    } catch (error: any) {
      console.error('Failed to join group call:', error);
      this.isJoining = false;
      const insecure =
        typeof window !== 'undefined' &&
        !window.isSecureContext &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1';

      if (insecure) {
        this.alertService.error(
          'Camera/mic need HTTPS. Run npm run dev and open the https URL.'
        );
        this.exitCall(false);
      } else {
        this.alertService.error(`Failed to join group call: ${error?.message || error}`);
        this.exitCall(false);
      }
    }
  }

  private async consumeExistingProducers(
    producers: { producerId: string; userId: string; kind: 'audio' | 'video'; source?: string }[]
  ): Promise<void> {
    for (const producer of producers) {
      try {
        await Promise.race([
          this.mediasoupService.consumeProducer(
            producer.producerId,
            producer.userId,
            producer.kind,
            producer.source || 'camera'
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('consume timeout')), 12000)
          ),
        ]);
      } catch (err) {
        console.warn('Failed to consume producer', producer.producerId, err);
      }
    }
    this.bindRemoteMedia();
  }

  ngOnDestroy(): void {
    this.remoteStreamSub?.unsubscribe();
    this.participantLeftSub?.unsubscribe();
    this.callEndedSub?.unsubscribe();
    this.screenStartedSub?.unsubscribe();
    this.screenStoppedSub?.unsubscribe();
    this.screenClosedSub?.unsubscribe();
    this.localScreenEndedSub?.unsubscribe();
    this.mediaUpdatedSub?.unsubscribe();
    this.remoteVideosSub?.unsubscribe();
    this.remoteAudiosSub?.unsubscribe();
    void this.screenOverlay.hide();
    if (!this.leftCall && this.callId) {
      this.leftCall = true;
      this.socketService.leaveGroupCall(this.callId);
      void this.mediasoupService.close();
    }
  }

  toggleMute(): void {
    if (!this.hasAudioDevice) {
      this.alertService.warning('No microphone available');
      return;
    }
    this.isMuted = !this.isMuted;
    this.mediasoupService.setAudioEnabled(!this.isMuted);
    this.screenOverlay.refresh();
  }

  async toggleVideo(): Promise<void> {
    if (this.isScreenSharing) {
      return;
    }

    // Audio call → switch to video
    if (this.callType === 'audio' || (!this.isVideoEnabled && !this.mediasoupService.hasVideoDevice)) {
      try {
        const stream = await this.mediasoupService.enableCamera();
        this.hasVideoDevice = true;
        this.isVideoEnabled = true;
        this.callType = 'video';
        this.setLocalVideo(stream);
        await this.socketService.upgradeGroupCall(this.callId, 'video');
      } catch (error: any) {
        this.alertService.warning(error?.message || 'Could not enable camera');
      }
      return;
    }

    if (!this.hasVideoDevice) {
      this.alertService.warning('No camera available');
      return;
    }
    this.isVideoEnabled = !this.isVideoEnabled;
    this.mediasoupService.setVideoEnabled(this.isVideoEnabled);
  }

  async toggleScreenShare(): Promise<void> {
    if (this.isScreenSharing) {
      await this.stopLocalScreenShare();
      return;
    }

    if (this.activeScreenUserId && this.activeScreenUserId !== this.myUserId) {
      this.alertService.warning('Only one person can share at a time. Wait until they stop.');
      return;
    }

    try {
      const lock = await this.socketService.requestScreenShare(this.callId);
      if (lock.error) {
        this.alertService.warning(lock.error);
        return;
      }

      const screenStream = await this.mediasoupService.startScreenShare();
      this.isScreenSharing = true;
      this.activeScreenUserId = this.myUserId;
      this.activeScreenUsername = 'You';
      this.activeScreenStream = screenStream;
      this.setLocalVideo(screenStream);
      this.bindScreenVideo();
      await this.openShareOverlay();
    } catch (error: any) {
      console.error('Screen share failed:', error);
      await this.socketService.stopScreenShareLock(this.callId);
      this.alertService.error(`Screen share failed: ${error?.message || error}`);
      this.isScreenSharing = false;
    }
  }

  leaveCall(): void {
    this.exitCall(true);
  }

  private async unlockAudioPlayback(): Promise<void> {
    try {
      const silent = new Audio(
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
      );
      silent.volume = 0.01;
      await silent.play();
      silent.pause();
    } catch {
      // ignore
    }

    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        await ctx.close();
      }
    } catch {
      // ignore
    }
  }

  private async stopLocalScreenShare(): Promise<void> {
    await this.mediasoupService.stopScreenShare();
    await this.finishScreenShareUi();
  }

  private async finishScreenShareUi(): Promise<void> {
    this.isScreenSharing = false;
    await this.socketService.stopScreenShareLock(this.callId);
    await this.screenOverlay.hide();
    this.clearActiveScreen();
    if (this.mediasoupService.getLocalStream()) {
      this.setLocalVideo(this.mediasoupService.getLocalStream()!);
    }
  }

  private async openShareOverlay(): Promise<void> {
    await this.screenOverlay.show({
      onToggleMute: () => this.toggleMute(),
      onStopShare: () => {
        void this.stopLocalScreenShare();
      },
      onLeave: () => this.leaveCall(),
      isMuted: () => this.isMuted,
      hasAudio: () => this.hasAudioDevice,
    });
  }

  private clearActiveScreen(): void {
    this.activeScreenUserId = null;
    this.activeScreenUsername = '';
    this.activeScreenStream = null;
  }

  private async exitCall(notifyServer: boolean): Promise<void> {
    if (this.leftCall) {
      return;
    }
    this.leftCall = true;
    if (this.isScreenSharing) {
      await this.mediasoupService.stopScreenShare();
      await this.socketService.stopScreenShareLock(this.callId);
      await this.screenOverlay.hide();
    }
    if (notifyServer && this.callId) {
      this.socketService.leaveGroupCall(this.callId);
    }
    await this.mediasoupService.close();
    this.router.navigate(['/chat'], { replaceUrl: true });
  }

  private setLocalVideo(stream: MediaStream): void {
    const apply = (el?: ElementRef<HTMLVideoElement>) => {
      if (!el?.nativeElement) {
        return;
      }
      const video = el.nativeElement;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      void video.play().catch(() => undefined);
    };

    if (!this.localVideo?.nativeElement && !this.localVideoPip?.nativeElement) {
      setTimeout(() => this.setLocalVideo(stream), 50);
      return;
    }
    apply(this.localVideo);
    apply(this.localVideoPip);
  }

  private bindFocusAndLocal(): void {
    const local = this.mediasoupService.getLocalStream();
    if (local) {
      this.setLocalVideo(local);
    }
    const focus = this.focusedParticipant;
    if (focus && this.focusVideo?.nativeElement) {
      this.syncDisplayStreams(focus);
      const el = this.focusVideo.nativeElement;
      const next = focus.displayVideo || focus.stream;
      if (el.srcObject !== next) {
        el.srcObject = next;
      }
      el.muted = true;
      el.playsInline = true;
      void el.play().catch(() => undefined);
    }
  }

  private bindScreenVideo(): void {
    setTimeout(() => {
      if (this.screenVideo?.nativeElement && this.activeScreenStream) {
        const el = this.screenVideo.nativeElement;
        el.srcObject = this.activeScreenStream;
        el.playsInline = true;
        void el.play().catch(() => undefined);
      }
    });
  }

  private bindRemoteMedia(): void {
    setTimeout(() => {
      this.participants.forEach((p) => {
        this.refreshParticipantFlags(p);
        this.syncDisplayStreams(p);
      });

      this.remoteAudios?.forEach((audioRef, index) => {
        const participant = this.participants[index];
        if (!participant?.displayAudio?.getAudioTracks().length) {
          return;
        }
        const audioEl = audioRef.nativeElement;
        if (audioEl.srcObject !== participant.displayAudio) {
          audioEl.srcObject = participant.displayAudio;
        }
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioEl.volume = 1;
        void audioEl.play().catch((err) => {
          console.warn('Remote audio play blocked:', err);
        });
      });

      this.remoteVideos?.forEach((video, index) => {
        const participant = this.participants[index];
        if (!participant) {
          return;
        }
        const el = video.nativeElement;
        if (!participant.displayVideo?.getVideoTracks().length) {
          if (el.srcObject) {
            el.srcObject = null;
          }
          return;
        }
        if (el.srcObject !== participant.displayVideo) {
          el.srcObject = participant.displayVideo;
        }
        el.playsInline = true;
        el.muted = true;
        el.autoplay = true;
        void el.play().catch(() => undefined);
      });

      this.cdr.detectChanges();
      this.bindFocusAndLocal();
    }, 30);
  }

  private fetchUsername(userId: string): void {
    this.userService.getUserById(userId).subscribe({
      next: (res) => {
        const participant = this.participants.find((p) => p.userId === userId);
        if (participant) {
          participant.username = res.data.username;
        }
      }
    });
  }

  private fetchScreenUsername(userId: string): void {
    if (userId === this.myUserId) {
      this.activeScreenUsername = 'You';
      return;
    }
    this.userService.getUserById(userId).subscribe({
      next: (res) => {
        this.activeScreenUsername = res.data.username || 'User';
      }
    });
  }
}
