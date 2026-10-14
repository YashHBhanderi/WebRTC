import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, OnDestroy } from '@angular/core';
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
}

/**
 * Teams-style recording card shown in the chat once a meeting recording is saved. Its state
 * (processing / ready / expired) is read live from the API and refreshed when it changes.
 */
@Component({
  selector: 'app-recording-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./recording-card.component.scss'],
  template: `
    <div class="rc" [class.rc--off]="state === 'expired' || state === 'failed' || state === 'missing'">
      <span class="rc__icon" aria-hidden="true"><i class="fa-solid fa-circle-play"></i></span>
      <div class="rc__body">
        <strong class="rc__title">{{ info?.title || fallbackTitle || 'Meeting recording' }}</strong>
        <span class="rc__meta" *ngIf="info">
          {{ info.startedAt | date: 'MMM d, y, h:mm a' }}<ng-container *ngIf="info.duration"> · {{ duration(info.duration) }}</ng-container>
        </span>
        <span class="rc__status" [ngSwitch]="state" role="status">
          <ng-container *ngSwitchCase="'loading'">Loading…</ng-container>
          <ng-container *ngSwitchCase="'recording'"><span class="rc__dot" aria-hidden="true"></span>Recording in progress</ng-container>
          <ng-container *ngSwitchCase="'processing'"><span class="rc__spin" aria-hidden="true"></span>Recording processing</ng-container>
          <ng-container *ngSwitchCase="'ready'">
            <i class="fa-solid fa-circle-check" aria-hidden="true"></i>Ready
            <ng-container [ngSwitch]="info?.transcriptStatus">
              <ng-container *ngSwitchCase="'completed'"> · {{ info?.transcriptAvailable === false ? 'No speech in transcript' : 'Transcript available' }}</ng-container>
              <ng-container *ngSwitchCase="'pending'"> · <span class="rc__spin" aria-hidden="true"></span>Transcription processing</ng-container>
              <ng-container *ngSwitchCase="'processing'"> · <span class="rc__spin" aria-hidden="true"></span>Transcription processing</ng-container>
              <ng-container *ngSwitchCase="'failed'"> · Transcript unavailable</ng-container>
            </ng-container>
          </ng-container>
          <ng-container *ngSwitchCase="'failed'"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>This recording couldn't be processed</ng-container>
          <ng-container *ngSwitchCase="'expired'"><i class="fa-regular fa-clock" aria-hidden="true"></i>Expired — recordings are deleted after 30 days</ng-container>
          <ng-container *ngSwitchCase="'missing'">This recording is no longer available</ng-container>
        </span>
        <ul class="rc__preview" *ngIf="preview.length" aria-label="Transcript preview">
          <li *ngFor="let line of preview"><strong>{{ line.speaker }}</strong> <time>{{ stamp(line.startTime) }}</time> {{ line.text }}</li>
        </ul>
      </div>
      <div class="rc__actions" *ngIf="(state === 'ready' || preview.length) && info as r">
        <a class="btn btn-sm btn-primary" *ngIf="state === 'ready'" [routerLink]="['/recordings', r._id]"><i class="fa-solid fa-play me-1" aria-hidden="true"></i>Play</a>
        <a class="btn btn-sm btn-light" *ngIf="preview.length" [routerLink]="['/recordings', r._id]"><i class="fa-regular fa-file-lines me-1" aria-hidden="true"></i>Transcript</a>
        <a class="btn btn-sm btn-light" *ngIf="state === 'ready' && r.downloadUrl" [href]="r.downloadUrl" download rel="noopener" aria-label="Download recording"><i class="fa-solid fa-download me-1" aria-hidden="true"></i>Download</a>
      </div>
    </div>
  `,
})
export class RecordingCardComponent implements OnChanges, OnDestroy {
  @Input() recordingId = '';
  @Input() fallbackTitle = '';

  info: RecordingInfo | null = null;
  /** First transcript lines, shown on the card once the transcript is ready */
  preview: { speaker: string; startTime: number; text: string }[] = [];
  state: 'loading' | 'recording' | 'processing' | 'ready' | 'failed' | 'expired' | 'missing' = 'loading';
  private sub?: Subscription;

  constructor(private http: HttpClient, private socket: SocketService, private cdr: ChangeDetectorRef) {}

  ngOnChanges(): void {
    this.sub?.unsubscribe();
    void this.load();
    this.sub = this.socket.onRecordingUpdated().subscribe((e) => {
      if (e.recordingId === this.recordingId) void this.load();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async load(): Promise<void> {
    if (!this.recordingId) return;
    try {
      const res = await firstValueFrom(this.http.get<{ data: RecordingInfo }>(`${environment.apiUrl}/recordings/${this.recordingId}`, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
      this.info = res.data;
      this.state = res.data.expired ? 'expired'
        : res.data.status === 'completed' ? 'ready'
        : res.data.status === 'failed' ? 'failed'
        : res.data.status === 'recording' ? 'recording'
        : 'processing';
      if (res.data.transcriptStatus === 'completed' && res.data.transcriptAvailable !== false && !this.preview.length) {
        const t = await firstValueFrom(this.http.get<{ data: { segments: { speaker: string; startTime: number; text: string }[] } }>(
          `${environment.apiUrl}/recordings/${this.recordingId}/transcript`, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) },
        )).catch(() => null);
        this.preview = (t?.data.segments || []).slice(0, 2);
      } else if (res.data.transcriptStatus !== 'completed') {
        this.preview = [];
      }
    } catch {
      // 404 also covers someone who isn't (or is no longer) a member
      this.state = 'missing';
    }
    this.cdr.markForCheck();
  }

  stamp(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  }
}
