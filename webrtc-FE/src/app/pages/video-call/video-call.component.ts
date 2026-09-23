import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { SocketService } from '../../core/services/socket.service';
import { ActivatedRoute, Router } from '@angular/router';
import { UserService } from '../../core/services/user.service';
import { takeUntil } from 'rxjs/operators';
import { Subject } from 'rxjs';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { getCallMedia } from '../../core/utils/media-devices.util';
import { ScreenShareOverlayService } from '../../core/services/screen-share-overlay.service';
import { CallHandoffService } from '../../core/services/call-handoff.service';

@Component({
  selector: 'app-video-call',
  templateUrl: './video-call.component.html',
  styleUrls: ['./video-call.component.scss']
})
export class VideoCallComponent implements OnInit, OnDestroy {

  @ViewChild("myVideo") myVideo!: ElementRef;
  @ViewChild("userVideo") userVideo!: ElementRef;

  isScreenSharing: boolean = false;
  isVideoEnabled: boolean = true;
  callInProgress: boolean = false;
  isMuted: boolean = false;
  isRecording: boolean = false;
  isCallInitiator: boolean = false;
  localVideoActive: boolean = false;
  remoteVideoActive: boolean = false;
  hasAudioDevice = false;
  hasVideoDevice = false;
  remoteIsSharing = false;
  p2pCallId = '';

  receiverId!: string;
  recordedVideoUrl: string | null = null;
  localUserAvatar!: string;
  remoteUserAvatar!: string;
  remoteUserName!: string;

  callType: 'audio' | 'video' = 'video';

  private myStream!: MediaStream;
  private peerConnection!: RTCPeerConnection;
  private previousStreams: MediaStream[] = [];
  private screenStream: MediaStream | null = null;
  private mediaRecorder!: MediaRecorder;
  private recordedChunks: Blob[] = [];

  private destroy$ = new Subject<void>();
  private endingLocally = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private servers = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Public TURN fallback for cross-network 1:1 (legacy path)
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:80?transport=tcp',
          'turn:openrelay.metered.ca:443',
          'turns:openrelay.metered.ca:443',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ]
  };

  constructor(
    public authService: AuthService,
    private socketService: SocketService,
    private alertService: AlertService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService,
    private screenOverlay: ScreenShareOverlayService,
    private callHandoff: CallHandoffService,
  ) { }


  ngOnInit(): void {
    this.receiverId = this.route.snapshot.params['receiverId'];
    this.callType = this.route.snapshot.queryParams['callType'];
    this.p2pCallId = this.buildP2pCallId(this.receiverId);
    this.socketService.joinScreenRoom(this.p2pCallId);

    this.isCallInitiator = this.route.snapshot.queryParams['initiator'] === 'true';
    if (this.isCallInitiator) {
      if (this.callType === 'video') {
        this.callVideoUser();
      } else {
        this.callAudioUser();
      }
    } else {
      const pending = this.callHandoff.take();
      if (pending?.offer && pending.from === this.receiverId) {
        void this.answerWithOffer(pending.offer, pending.callType || this.callType);
      }
    }
    this.listenForCalls();
    this.listenForScreenShareEvents();
    this.loadRemoteUserInfo(this.receiverId);
    this.localUserAvatar = this.authService.getLoggedInUser().avatar;
    this.socketService.onCallEnded()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (!this.callInProgress || this.endingLocally) {
          return;
        }
        this.alertService.info('Call ended by the other participant');
        this.cleanUpCall(false);
        this.router.navigate(['/chat'], { replaceUrl: true });
      });

  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    void this.screenOverlay.hide();
    if (this.callInProgress && !this.endingLocally) {
      this.endingLocally = true;
      if (this.receiverId) {
        this.socketService.endCall(this.receiverId);
      }
      this.cleanUpCall(false);
    }
  }

  get canStartScreenShare(): boolean {
    return !this.isScreenSharing && !this.remoteIsSharing;
  }

  private buildP2pCallId(otherUserId: string): string {
    const me = this.authService.getLoggedInUser()._id;
    return ['p2p', me, otherUserId].sort().join(':');
  }

  private listenForScreenShareEvents(): void {
    this.socketService.onScreenStarted()
      .pipe(takeUntil(this.destroy$))
      .subscribe((data: any) => {
        if (data?.callId !== this.p2pCallId) {
          return;
        }
        if (data.userId !== this.authService.getLoggedInUser()._id) {
          this.remoteIsSharing = true;
          this.alertService.info(`${this.remoteUserName || 'User'} is sharing screen`);
        }
      });

    this.socketService.onScreenStopped()
      .pipe(takeUntil(this.destroy$))
      .subscribe((data: any) => {
        if (data?.callId !== this.p2pCallId) {
          return;
        }
        this.remoteIsSharing = false;
      });
  }

  onRemoteVideoPlaying() {
    this.remoteVideoActive = true;
  }

  onLocalVideoPlaying() {
    this.localVideoActive = true;
  }

  private loadRemoteUserInfo(userId: string) {
    this.userService.getUserById(userId).subscribe({
      next: (user) => {
        this.remoteUserAvatar = user.data.avatar;
        this.remoteUserName = user.data.username;
      },
      error: (error) => {
        this.alertService.error(`Failed to load local user info: ${error || 'Unknown error'}`);
      }
    });
  }

  async callVideoUser() {
    this.callInProgress = true;
    this.isCallInitiator = true;
    this.callType = 'video';
    try {
      await this.prepareLocalMedia(true);
      this.setupVideoElements();
      this.initializePeerConnection();

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.socketService.callUser(this.receiverId, offer, this.authService.getLoggedInUser()._id, 'video');
    } catch (error) {
      console.error('Error starting video call:', error);
      this.alertService.error(`Failed to start video call: ${error || 'Unknown error'}`);
      this.callInProgress = false;
      this.router.navigate(['/chat'], { replaceUrl: true });
    }
  }

  async callAudioUser() {
    this.callInProgress = true;
    this.isCallInitiator = true;

    try {
      this.callType = 'audio';
      await this.prepareLocalMedia(false);
      this.setupAudioElements();
      this.initializePeerConnection();

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.socketService.callUser(this.receiverId, offer, this.authService.getLoggedInUser()._id, 'audio');
    } catch (error) {
      console.error('Error starting audio call:', error);
      this.alertService.error(`Failed to start audio call: ${error || 'Unknown error'}`);
      this.callInProgress = false;
    }
  }

  private async prepareLocalMedia(wantVideo: boolean): Promise<void> {
    const media = await getCallMedia(wantVideo);
    this.myStream = media.stream;
    this.hasAudioDevice = media.hasAudio;
    this.hasVideoDevice = media.hasVideo;
    this.isMuted = !media.hasAudio;
    this.isVideoEnabled = wantVideo && media.hasVideo;
    this.localVideoActive = media.hasVideo;

    if (!media.hasAudio || (wantVideo && !media.hasVideo)) {
      const missing = [
        !media.hasAudio ? 'microphone' : null,
        wantVideo && !media.hasVideo ? 'camera' : null,
      ].filter(Boolean).join(' and ');
      this.alertService.warning(
        `No ${missing} found. Call started without that media.`
      );
    }
  }

  private listenForCalls() {
    this.socketService.onIncomingCall().subscribe(async (data) => {
      if (!data.offer || this.isCallInitiator) return;
      if (this.callInProgress && this.peerConnection) return;
      await this.answerWithOffer(data.offer, data.callType);
    });

    this.socketService.onCallAccepted().subscribe(async (data) => {
      try {
        if (data.answer && this.peerConnection) {
          await this.peerConnection.setRemoteDescription(data.answer);
          await this.flushPendingIce();
        }
      } catch (error) {
        console.error('Error handling answer:', error);
      }
    });

    this.socketService.onIceCandidate().subscribe(async (data: any) => {
      const candidate = data?.candidate || data;
      if (!candidate || !this.peerConnection) {
        return;
      }
      if (!this.peerConnection.remoteDescription) {
        this.pendingIce.push(candidate);
        return;
      }
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('Failed to add ICE candidate', error);
      }
    });
  }

  private async answerWithOffer(offer: RTCSessionDescriptionInit, callType: 'audio' | 'video') {
    this.callType = callType || 'video';
    this.callInProgress = true;

    try {
      await this.prepareLocalMedia(this.callType === 'video');

      if (this.callType === 'video') {
        this.setupVideoElements();
      } else {
        this.setupAudioElements();
      }

      this.initializePeerConnection();
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      await this.flushPendingIce();
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      this.socketService.answerCall(this.receiverId, answer);
    } catch (error) {
      console.error('Error answering call:', error);
      this.alertService.error(`Error answering call: ${error || 'Unknown error'}`);
      this.callInProgress = false;
      this.cleanUpCall(false);
    }
  }

  private setupAudioElements() {
    if (this.myStream) {
      const audioElement = new Audio();
      audioElement.srcObject = this.myStream;
      audioElement.muted = true;
      audioElement.play();
    }
  }

  private setupVideoElements() {
    if (this.myVideo?.nativeElement) {
      this.myVideo.nativeElement.srcObject = this.myStream;
      this.myVideo.nativeElement.muted = true;
      this.myVideo.nativeElement.play();
    }
  }

  private pendingIce: RTCIceCandidateInit[] = [];

  private initializePeerConnection() {
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {
        // ignore
      }
    }
    this.pendingIce = [];
    this.peerConnection = new RTCPeerConnection(this.servers);

    this.myStream?.getTracks().forEach(track => {
      this.peerConnection.addTrack(track, this.myStream);
    });

    // Audio-only / no-camera: keep a video transceiver for screen share & remote video
    if (!this.myStream?.getVideoTracks()?.length) {
      this.peerConnection.addTransceiver('video', { direction: 'sendrecv' });
    }
    if (!this.myStream?.getAudioTracks()?.length) {
      this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
    }

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socketService.sendIceCandidate(this.receiverId, event.candidate);
      }
    };

    this.peerConnection.ontrack = (event) => {
      const bindRemote = () => {
        if (!this.userVideo?.nativeElement) {
          setTimeout(bindRemote, 50);
          return;
        }
        const videoEl = this.userVideo.nativeElement as HTMLVideoElement;
        let remoteStream = videoEl.srcObject as MediaStream | null;
        if (!remoteStream) {
          remoteStream = event.streams?.[0] || new MediaStream();
          videoEl.srcObject = remoteStream;
        }
        if (!remoteStream.getTracks().includes(event.track)) {
          remoteStream.addTrack(event.track);
        }
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        void videoEl.play().catch(() => undefined);

        if (event.track.kind === 'video') {
          this.remoteVideoActive = true;
          event.track.onended = () => {
            this.remoteVideoActive = remoteStream!.getVideoTracks().some((t) => t.readyState === 'live');
          };
        }
      };
      bindRemote();
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection || this.endingLocally) {
        return;
      }
      console.log('Connection state:', this.peerConnection.connectionState);
    };
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.peerConnection?.remoteDescription) {
      return;
    }
    const queued = [...this.pendingIce];
    this.pendingIce = [];
    for (const candidate of queued) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('Failed to add queued ICE candidate', error);
      }
    }
  }

  toggleMute() {
    if (!this.hasAudioDevice) {
      this.alertService.warning('No microphone available');
      return;
    }
    this.isMuted = !this.isMuted;
    this.myStream?.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });
    this.screenOverlay.refresh();
  }

  async toggleVideo() {
    if (this.isScreenSharing) {
      return;
    }

    // Audio → video upgrade
    if (this.callType === 'audio' || !this.myStream?.getVideoTracks()?.length) {
      try {
        const media = await getCallMedia(true);
        const videoTrack = media.stream.getVideoTracks()[0];
        if (!videoTrack) {
          this.alertService.warning('No camera available');
          return;
        }
        media.stream.getAudioTracks().forEach((t) => t.stop());
        this.hasVideoDevice = true;
        this.myStream?.getVideoTracks().forEach((t) => {
          this.myStream.removeTrack(t);
          t.stop();
        });
        this.myStream.addTrack(videoTrack);
        const sender = this.getVideoSender();
        if (sender) {
          await sender.replaceTrack(videoTrack);
        } else {
          this.peerConnection.addTrack(videoTrack, this.myStream);
        }
        this.callType = 'video';
        this.isVideoEnabled = true;
        this.localVideoActive = true;
        this.setupVideoElements();
      } catch (error) {
        this.alertService.warning(`Could not enable camera: ${error || 'Unknown error'}`);
      }
      return;
    }

    if (!this.hasVideoDevice) {
      this.alertService.warning('No camera available');
      return;
    }
    this.isVideoEnabled = !this.isVideoEnabled;
    this.myStream?.getVideoTracks().forEach(track => { track.enabled = this.isVideoEnabled });
    this.localVideoActive = this.isVideoEnabled;
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      return;
    }
    if (this.remoteIsSharing) {
      this.alertService.warning('Other user is sharing. Wait until they stop.');
      return;
    }
    await this.startScreenShare();
  }

  toggleRecording() {
    if (this.isRecording) {
      this.stopScreenRecording();
    } else {
      this.startScreenRecording();
    }
  }

  private getVideoSender(): RTCRtpSender | undefined {
    return (
      this.peerConnection.getSenders().find((s) => s.track?.kind === 'video') ||
      this.peerConnection.getTransceivers().find((t) =>
        t.receiver.track?.kind === 'video' || t.mid !== null && !t.sender.track && t.direction !== 'inactive'
      )?.sender ||
      this.peerConnection.getTransceivers().find((t) => !t.sender.track)?.sender
    );
  }

  async startScreenShare() {
    try {
      const lock = await this.socketService.requestScreenShare(this.p2pCallId);
      if (lock.error) {
        this.alertService.warning(lock.error);
        return;
      }

      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const screenTrack = this.screenStream.getVideoTracks()[0];
      const videoSender = this.getVideoSender();

      if (!videoSender) {
        throw new Error('No video sender available for screen share');
      }

      await videoSender.replaceTrack(screenTrack);

      if (this.myVideo?.nativeElement) {
        this.myVideo.nativeElement.srcObject = this.screenStream;
      }
      this.localVideoActive = true;
      this.isScreenSharing = true;

      screenTrack.onended = () => {
        void this.stopScreenShare();
      };

      await this.screenOverlay.show({
        onToggleMute: () => this.toggleMute(),
        onStopShare: () => { void this.stopScreenShare(); },
        onLeave: () => this.endCall(),
        isMuted: () => this.isMuted,
        hasAudio: () => this.hasAudioDevice,
      });
    } catch (error) {
      console.error('Error starting screen share:', error);
      await this.socketService.stopScreenShareLock(this.p2pCallId);
      this.alertService.error(`Failed to start screen sharing: ${error || 'Unknown error'}`);
    }
  }

  async stopScreenShare() {
    if (!this.isScreenSharing) return;

    try {
      this.screenStream?.getTracks().forEach((track) => track.stop());
      this.screenStream = null;

      const videoSender = this.getVideoSender();
      const cameraTrack = this.myStream?.getVideoTracks()[0] || null;

      if (videoSender) {
        await videoSender.replaceTrack(cameraTrack);
      }

      if (this.myVideo?.nativeElement) {
        this.myVideo.nativeElement.srcObject = this.myStream;
      }
      this.localVideoActive = !!cameraTrack && this.isVideoEnabled;
      this.isScreenSharing = false;
      await this.socketService.stopScreenShareLock(this.p2pCallId);
      await this.screenOverlay.hide();
    } catch (error) {
      console.error('Error stopping screen share:', error);
      this.alertService.error(`Error stopping screen share: ${error || 'Unknown error'}`);
    }
  }

  endCall() {
    if (this.endingLocally) {
      return;
    }
    this.endingLocally = true;
    if (this.isScreenSharing) {
      void this.stopScreenShare();
    }
    if (this.callInProgress && this.receiverId) {
      this.socketService.endCall(this.receiverId);
    }
    this.cleanUpCall(false);
    this.router.navigate(['/chat'], { replaceUrl: true });
  }

  private cleanUpCall(_notifyRemote = false) {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (!this.callInProgress && !this.peerConnection) return;

    void this.screenOverlay.hide();
    if (this.p2pCallId) {
      void this.socketService.stopScreenShareLock(this.p2pCallId);
    }
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.isScreenSharing = false;
    this.remoteIsSharing = false;

    if (this.myStream) {
      this.myStream.getTracks().forEach(track => track.stop());
      this.myStream = null!;
    }
    if (this.peerConnection) {
      try {
        this.peerConnection.getSenders().forEach(sender => {
          if (sender.track) sender.track.stop();
        });
        this.peerConnection.close();
      } catch {
        // ignore
      }
      this.peerConnection = null!;
    }

    if (this.myVideo?.nativeElement) {
      this.myVideo.nativeElement.srcObject = null;
    }
    if (this.userVideo?.nativeElement) {
      this.userVideo.nativeElement.srcObject = null;
    }

    if (this.isRecording) {
      this.stopScreenRecording();
    }

    this.callInProgress = false;
  }

  // async startScreenRecording() {
  //   try {
  //     const combinedStream = new MediaStream();

  //     if (this.userVideo?.nativeElement?.srcObject) {
  //       const remoteStream = this.userVideo.nativeElement.srcObject as MediaStream;
  //       remoteStream.getTracks().forEach(track => {
  //         combinedStream.addTrack(track.clone());
  //       });
  //     }

  //     this.myStream.getAudioTracks().forEach(track => {
  //       combinedStream.addTrack(track.clone());
  //     });

  //     if (this.isScreenSharing && this.screenStream) {
  //       this.screenStream.getVideoTracks().forEach(track => {
  //         combinedStream.addTrack(track.clone());
  //       });

  //     } else {
  //       this.myStream.getVideoTracks().forEach(track => {
  //         combinedStream.addTrack(track.clone());
  //       });
  //     }

  //     this.mediaRecorder = new MediaRecorder(combinedStream, {
  //       mimeType: 'video/webm',
  //       bitsPerSecond: 2500000
  //     });

  //     this.recordedChunks = [];
  //     this.mediaRecorder.ondataavailable = (event) => {
  //       if (event.data.size > 0) {
  //         this.recordedChunks.push(event.data);
  //       }
  //     };

  //     this.mediaRecorder.onstop = () => {
  //       const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
  //       this.recordedVideoUrl = URL.createObjectURL(blob);
  //       this.downloadRecording();
  //     };

  //     this.mediaRecorder.start(1000);
  //     this.isRecording = true;
  //     this.toastr.info('Recording started');
  //   } catch (error) {
  //     console.error('Recording failed:', error);
  //     this.toastr.error('Recording could not be started');
  //   }
  // }

  async startScreenRecording() {
    try {
      const combinedStream = new MediaStream();

      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'window',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      screenStream.getTracks().forEach(track => {
        combinedStream.addTrack(track.clone());
      });

      if (this.myStream) {
        this.myStream.getAudioTracks().forEach(track => {
          combinedStream.addTrack(track.clone());
        });
      }

      this.mediaRecorder = new MediaRecorder(combinedStream, {
        mimeType: 'video/webm',
        bitsPerSecond: 2500000
      });

      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        this.recordedVideoUrl = URL.createObjectURL(blob);
        this.downloadRecording();
      };

      this.mediaRecorder.start(1000);
      this.isRecording = true;
      this.alertService.info('Screen recording started');

    } catch (error) {
      console.error('Screen recording failed:', error);
      this.alertService.error(`Screen recording could not be started: ${error || 'Unknown error'}`);
    }
  }

  private downloadRecording() {
    if (!this.recordedVideoUrl) return;
    const a = document.createElement('a');
    a.href = this.recordedVideoUrl;
    a.download = `call-recording-${new Date().toISOString()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(this.recordedVideoUrl);
    this.recordedVideoUrl = null;
  }

  stopScreenRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      this.alertService.success('Recording saved');
    }
  }

}
