import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { Subscription, firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { SocketService } from 'src/app/core/services/socket.service';
import { environment } from 'src/environments/environment';

interface RecordingInfo {
  _id: string;
  title: string;
  startedAt: string;
  duration: number;
  size: number;
  status: 'recording' | 'processing' | 'completed' | 'failed';
  transcriptStatus: 'none' | 'pending' | 'processing' | 'completed' | 'failed';
  transcriptAvailable?: boolean;
  expired: boolean;
  expiresAt?: string;
  downloadUrl: string | null;
  playbackUrl?: string | null;
}

const BAR_COUNT = 40;
const SPEEDS = [1, 1.5, 2];

/**
 * Recording card shown in the chat once a meeting recording is saved: status, inline player and
 * transcript / download actions. State is read live from the API and refreshed when it changes.
 */
@Component({
  selector: 'app-recording-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./recording-card.component.scss'],
  template: `
    <div class="rc" [class.rc--off]="state === 'expired' || state === 'failed' || state === 'missing'">
      <div class="rc__top">
        <span class="rc__icon" aria-hidden="true"><i class="ti ti-microphone ti-fill"></i></span>
        <div class="rc__body">
          <div class="rc__title-row">
            <strong class="rc__title" [title]="info?.title || fallbackTitle || 'Meeting recording'">{{ info?.title || fallbackTitle || 'Meeting recording' }}</strong>
            <span class="rc__badge rc__badge--{{ state }}" [ngSwitch]="state">
              <ng-container *ngSwitchCase="'ready'">Completed</ng-container>
              <ng-container *ngSwitchCase="'recording'"><span class="rc__dot" aria-hidden="true"></span>Recording</ng-container>
              <ng-container *ngSwitchCase="'processing'">Processing</ng-container>
              <ng-container *ngSwitchCase="'failed'">Failed</ng-container>
              <ng-container *ngSwitchCase="'expired'">Expired</ng-container>
              <ng-container *ngSwitchCase="'missing'">Unavailable</ng-container>
              <ng-container *ngSwitchDefault>Loading</ng-container>
            </span>
          </div>
          <span class="rc__meta" *ngIf="info">
            {{ info.startedAt | date: 'MMM d' }}<ng-container *ngIf="info.duration"> · {{ duration(info.duration) }}</ng-container><ng-container *ngIf="info.size"> · {{ info.size | fileSize }}</ng-container> · Meeting recording
          </span>
        </div>
        <div class="rc__menu" ngbDropdown container="body" placement="bottom-end" *ngIf="state === 'ready' && info as r">
          <button type="button" class="rc__kebab" ngbDropdownToggle aria-label="Recording options"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>
          <div ngbDropdownMenu>
            <a ngbDropdownItem [routerLink]="['/recordings', r._id]"><i class="ti ti-external-link me-2" aria-hidden="true"></i>Open recording</a>
            <a ngbDropdownItem *ngIf="r.downloadUrl" [href]="r.downloadUrl" download rel="noopener"><i class="ti ti-download me-2" aria-hidden="true"></i>Download</a>
          </div>
        </div>
      </div>

      <div class="rc__player" *ngIf="state === 'ready' && info?.playbackUrl">
        <button type="button" class="rc__play" (click)="toggle()" [attr.aria-label]="playing ? 'Pause' : 'Play'">
          <i class="ti ti-fill" [class.ti-player-pause]="playing" [class.ti-player-play]="!playing" aria-hidden="true"></i>
        </button>
        <div class="rc__wave" role="slider" tabindex="0" aria-label="Seek"
             [attr.aria-valuemin]="0" [attr.aria-valuemax]="total" [attr.aria-valuenow]="current"
             (click)="seek($event)" (keydown.arrowright)="skip(5)" (keydown.arrowleft)="skip(-5)">
          <span *ngFor="let h of bars; let i = index" class="rc__bar" [class.rc__bar--done]="i < playedBars" [style.height.%]="h"></span>
        </div>
        <span class="rc__time">{{ clock(current) }} / {{ clock(total) }}</span>
        <button type="button" class="rc__speed" (click)="cycleSpeed()" aria-label="Playback speed">{{ speed }}x</button>
        <audio #audio class="d-none" preload="none" [src]="info?.playbackUrl"
               (timeupdate)="onTime()" (loadedmetadata)="onTime()" (play)="setPlaying(true)" (pause)="setPlaying(false)"
               (ended)="setPlaying(false)" (error)="onAudioError()"></audio>
      </div>

      <span class="rc__status" *ngIf="state !== 'ready'" [ngSwitch]="state" role="status">
        <ng-container *ngSwitchCase="'loading'">Loading…</ng-container>
        <ng-container *ngSwitchCase="'recording'">Recording in progress</ng-container>
        <ng-container *ngSwitchCase="'processing'"><span class="rc__spin" aria-hidden="true"></span>Recording processing</ng-container>
        <ng-container *ngSwitchCase="'failed'"><i class="ti ti-alert-triangle" aria-hidden="true"></i>This recording couldn't be processed</ng-container>
        <ng-container *ngSwitchCase="'expired'"><i class="ti ti-clock" aria-hidden="true"></i>Expired — recordings are deleted after 30 days</ng-container>
        <ng-container *ngSwitchCase="'missing'">This recording is no longer available</ng-container>
      </span>

      <div class="rc__foot" *ngIf="state === 'ready' && info as r">
        <span class="rc__trans" [ngSwitch]="r.transcriptStatus" role="status">
          <ng-container *ngSwitchCase="'completed'">
            <i class="ti ti-shield-check" aria-hidden="true"></i>{{ r.transcriptAvailable === false ? 'No speech transcribed' : 'Transcribed' }}
          </ng-container>
          <ng-container *ngSwitchCase="'pending'"><span class="rc__spin" aria-hidden="true"></span>Transcribing…</ng-container>
          <ng-container *ngSwitchCase="'processing'"><span class="rc__spin" aria-hidden="true"></span>Transcribing…</ng-container>
          <ng-container *ngSwitchCase="'failed'"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Transcript unavailable</ng-container>
          <ng-container *ngSwitchDefault><i class="ti ti-file-off" aria-hidden="true"></i>No transcript</ng-container>
        </span>
        <div class="rc__actions">
          <a class="rc__btn" *ngIf="r.transcriptStatus === 'completed' && r.transcriptAvailable !== false" [routerLink]="['/recordings', r._id]">
            <i class="ti ti-file-text" aria-hidden="true"></i>Transcript
          </a>
          <a class="rc__btn" *ngIf="!r.playbackUrl" [routerLink]="['/recordings', r._id]">
            <i class="ti ti-player-play" aria-hidden="true"></i>Play
          </a>
          <a class="rc__btn rc__btn--primary" *ngIf="r.downloadUrl" [href]="r.downloadUrl" download rel="noopener">
            <i class="ti ti-download" aria-hidden="true"></i>Download
          </a>
        </div>
      </div>
    </div>
  `,
})
export class RecordingCardComponent implements OnChanges, OnDestroy {
  @Input() recordingId = '';
  @Input() fallbackTitle = '';
  @ViewChild('audio') audioRef?: ElementRef<HTMLAudioElement>;

  info: RecordingInfo | null = null;
  state: 'loading' | 'recording' | 'processing' | 'ready' | 'failed' | 'expired' | 'missing' = 'loading';
  bars: number[] = [];
  playing = false;
  current = 0;
  speed = 1;
  private sub?: Subscription;
  private retried = false;

  constructor(private http: HttpClient, private socket: SocketService, private cdr: ChangeDetectorRef) {}

  ngOnChanges(): void {
    this.sub?.unsubscribe();
    this.bars = waveform(this.recordingId);
    void this.load();
    this.sub = this.socket.onRecordingUpdated().subscribe((e) => {
      if (e.recordingId === this.recordingId) void this.load();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.audioRef?.nativeElement.pause();
  }

  get total(): number {
    const d = this.audioRef?.nativeElement.duration;
    return Number.isFinite(d) && d ? d : this.info?.duration || 0;
  }

  get playedBars(): number {
    return this.total ? Math.round((this.current / this.total) * BAR_COUNT) : 0;
  }

  toggle(): void {
    const audio = this.audioRef?.nativeElement;
    if (!audio) return;
    if (audio.paused) {
      audio.playbackRate = this.speed;
      void audio.play().catch(() => this.setPlaying(false));
    } else {
      audio.pause();
    }
  }

  seek(event: MouseEvent): void {
    const el = event.currentTarget as HTMLElement;
    const ratio = Math.min(1, Math.max(0, (event.clientX - el.getBoundingClientRect().left) / el.clientWidth));
    this.seekTo(ratio * this.total);
  }

  skip(seconds: number): void {
    this.seekTo(this.current + seconds);
  }

  cycleSpeed(): void {
    this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
    if (this.audioRef) this.audioRef.nativeElement.playbackRate = this.speed;
  }

  onTime(): void {
    this.current = this.audioRef?.nativeElement.currentTime || 0;
    this.cdr.markForCheck();
  }

  setPlaying(value: boolean): void {
    this.playing = value;
    this.cdr.markForCheck();
  }

  /** Playback links are short-lived: refresh once and resume where we were. */
  async onAudioError(): Promise<void> {
    this.setPlaying(false);
    if (this.retried) return;
    this.retried = true;
    const resumeAt = this.current;
    await this.load();
    setTimeout(() => {
      const audio = this.audioRef?.nativeElement;
      if (!audio) return;
      audio.load();
      audio.currentTime = resumeAt;
      audio.playbackRate = this.speed;
      void audio.play().catch(() => this.setPlaying(false));
    });
  }

  private seekTo(seconds: number): void {
    const audio = this.audioRef?.nativeElement;
    if (!audio || !this.total) return;
    audio.currentTime = Math.min(this.total, Math.max(0, seconds));
    this.onTime();
  }

  private async load(): Promise<void> {
    if (!this.recordingId) return;
    try {
      const res = await firstValueFrom(this.http.get<{ data: RecordingInfo }>(`${environment.apiUrl}/recordings/${this.recordingId}`, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
      // Keep the current source while playing so a status refresh doesn't restart the audio
      if (this.playing && this.info?.playbackUrl) {
        res.data.playbackUrl = this.info.playbackUrl;
      }
      this.info = res.data;
      this.state = res.data.expired ? 'expired'
        : res.data.status === 'completed' ? 'ready'
        : res.data.status === 'failed' ? 'failed'
        : res.data.status === 'recording' ? 'recording'
        : 'processing';
    } catch {
      // 404 also covers someone who isn't (or is no longer) a member
      this.state = 'missing';
    }
    this.cdr.markForCheck();
  }

  clock(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const pad = (v: number) => String(v).padStart(2, '0');
    const h = Math.floor(s / 3600);
    return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  }
}

/** Decorative bar heights (%), stable per recording. */
function waveform(seed: string): number[] {
  let h = 2166136261;
  for (const c of seed || 'recording') h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) + i;
    const wave = 0.55 + 0.45 * Math.sin(i / 3.1);
    return Math.round(22 + (((h >>> 0) % 100) / 100) * 78 * wave);
  });
}
