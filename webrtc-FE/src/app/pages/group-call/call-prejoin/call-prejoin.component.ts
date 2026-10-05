import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';
import { SocketService } from 'src/app/core/services/socket.service';
import { MediasoupService } from 'src/app/core/services/mediasoup.service';
import {
  getCallMedia,
  getSingleTrack,
  listMediaDevices,
  supportsAudioOutputSelection,
} from 'src/app/core/utils/media-devices.util';
import { CallMember, PrejoinResult } from '../call.models';

/** Camera/mic check before entering a group meeting (Teams-style lobby). */
@Component({
  selector: 'app-call-prejoin',
  templateUrl: './call-prejoin.component.html',
  styleUrls: ['./call-prejoin.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallPrejoinComponent implements OnInit, OnDestroy {
  @Input() title = '';
  @Input() callId = '';
  @Input() callType: 'audio' | 'video' = 'video';
  @Input() members: CallMember[] = [];
  @Input() myUserId = '';
  @Output() join = new EventEmitter<PrejoinResult>();
  @Output() cancel = new EventEmitter<void>();

  @ViewChild('levelBar') levelBar?: ElementRef<HTMLElement>;

  stream: MediaStream | null = null;
  micOn = true;
  camOn = true;
  hasMic = false;
  hasCam = false;
  loading = true;
  permissionError = '';
  streamKick = 0;

  microphones: MediaDeviceInfo[] = [];
  cameras: MediaDeviceInfo[] = [];
  speakers: MediaDeviceInfo[] = [];
  selectedMic = '';
  selectedCam = '';
  selectedSpeaker = '';
  readonly canPickSpeaker = supportsAudioOutputSelection();

  inCallNames: string[] = [];
  inCallCount = 0;
  stateLoaded = false;

  private audioCtx: AudioContext | null = null;
  private rafId: number | null = null;
  private handedOff = false;
  private destroyed = false;

  constructor(
    private socketService: SocketService,
    private mediasoupService: MediasoupService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {}

  async ngOnInit(): Promise<void> {
    this.camOn = this.callType === 'video';
    this.selectedSpeaker = this.mediasoupService.getAudioOutputId();
    void this.loadParticipants();

    const media = await getCallMedia(this.camOn);
    if (this.destroyed) {
      media.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = media.stream;
    this.hasMic = media.hasAudio;
    this.hasCam = media.hasVideo;
    this.micOn = media.hasAudio;
    this.camOn = this.camOn && media.hasVideo;
    if (!media.hasAudio && !media.hasVideo) {
      this.permissionError = 'Camera and microphone are unavailable or blocked. You can still join and listen.';
    } else if (!media.hasAudio) {
      this.permissionError = 'Microphone is unavailable or blocked.';
    }
    this.loading = false;
    await this.refreshDevices();
    this.startLevelMeter();
    this.render();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopLevelMeter();
    if (!this.handedOff) {
      this.stream?.getTracks().forEach((t) => t.stop());
    }
  }

  get participantSummary(): string {
    if (!this.stateLoaded) {
      return 'Checking who is here…';
    }
    if (!this.inCallCount) {
      return 'No one else is here yet';
    }
    const shown = this.inCallNames.slice(0, 2).join(', ');
    const rest = this.inCallCount - Math.min(2, this.inCallNames.length);
    return rest > 0 ? `${shown} and ${rest} other${rest > 1 ? 's' : ''} are in this call` : `${shown} ${this.inCallCount > 1 ? 'are' : 'is'} in this call`;
  }

  toggleMic(): void {
    if (!this.hasMic) {
      return;
    }
    this.micOn = !this.micOn;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = this.micOn));
    this.render();
  }

  async toggleCam(): Promise<void> {
    if (this.camOn) {
      // Release the camera entirely (light off) rather than just disabling the track
      this.stream?.getVideoTracks().forEach((t) => {
        t.stop();
        this.stream?.removeTrack(t);
      });
      this.camOn = false;
      this.render();
      return;
    }
    try {
      const track = await getSingleTrack('video', this.selectedCam || null);
      this.ensureStream().addTrack(track);
      this.hasCam = true;
      this.camOn = true;
      this.streamKick++;
      await this.refreshDevices();
    } catch {
      this.permissionError = 'Camera is unavailable or blocked.';
    }
    this.render();
  }

  async onMicChange(deviceId: string): Promise<void> {
    this.selectedMic = deviceId;
    try {
      const track = await getSingleTrack('audio', deviceId);
      track.enabled = this.micOn;
      const stream = this.ensureStream();
      stream.getAudioTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });
      stream.addTrack(track);
      this.hasMic = true;
      this.startLevelMeter();
    } catch {
      this.permissionError = 'Could not switch microphone.';
    }
    this.render();
  }

  async onCamChange(deviceId: string): Promise<void> {
    this.selectedCam = deviceId;
    if (!this.camOn) {
      return;
    }
    const stream = this.ensureStream();
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    try {
      stream.addTrack(await getSingleTrack('video', deviceId));
      this.streamKick++;
    } catch {
      this.camOn = false;
      this.permissionError = 'Could not switch camera.';
    }
    this.render();
  }

  onSpeakerChange(deviceId: string): void {
    this.selectedSpeaker = deviceId;
    this.mediasoupService.setAudioOutput(deviceId);
  }

  onJoin(): void {
    this.handedOff = true;
    this.stopLevelMeter();
    this.join.emit({ stream: this.stream, micOn: this.micOn, camOn: this.camOn });
  }

  onCancel(): void {
    this.cancel.emit();
  }

  private ensureStream(): MediaStream {
    if (!this.stream) {
      this.stream = new MediaStream();
    }
    return this.stream;
  }

  private async refreshDevices(): Promise<void> {
    const lists = await listMediaDevices();
    this.microphones = lists.microphones;
    this.cameras = lists.cameras;
    this.speakers = lists.speakers;
    const micTrack = this.stream?.getAudioTracks()[0];
    const camTrack = this.stream?.getVideoTracks()[0];
    this.selectedMic = micTrack?.getSettings?.().deviceId || this.selectedMic;
    this.selectedCam = camTrack?.getSettings?.().deviceId || this.selectedCam;
  }

  private async loadParticipants(): Promise<void> {
    const state = this.callId ? await this.socketService.getCallState(this.callId) : null;
    const others = (state?.participants || []).filter((id) => id !== this.myUserId);
    this.inCallCount = others.length;
    this.inCallNames = others
      .map((id) => this.members.find((m) => m._id === id)?.username)
      .filter((name): name is string => !!name);
    this.stateLoaded = true;
    this.render();
  }

  /** Mic level bar driven by an AnalyserNode, updated outside Angular. */
  private startLevelMeter(): void {
    this.stopLevelMeter();
    const track = this.stream?.getAudioTracks()[0];
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!track || !Ctx) {
      return;
    }
    try {
      this.audioCtx = new Ctx() as AudioContext;
      const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      this.zone.runOutsideAngular(() => {
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            peak = Math.max(peak, Math.abs(data[i] - 128));
          }
          const level = this.micOn ? Math.min(1, peak / 64) : 0;
          if (this.levelBar) {
            this.levelBar.nativeElement.style.transform = `scaleX(${level.toFixed(2)})`;
          }
          this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
      });
    } catch {
      this.stopLevelMeter();
    }
  }

  private stopLevelMeter(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }

  private render(): void {
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }
}
