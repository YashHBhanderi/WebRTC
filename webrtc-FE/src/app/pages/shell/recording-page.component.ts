import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { normalizeError } from 'src/app/core/errors/app-error';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { SocketService } from 'src/app/core/services/socket.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

interface RecordingDetails {
  _id: string;
  title: string;
  conversationId: string;
  startedAt: string;
  duration: number;
  size: number;
  status: 'recording' | 'processing' | 'completed' | 'failed';
  error?: string | null;
  transcriptStatus: 'none' | 'pending' | 'processing' | 'completed' | 'failed';
  startedByName: string;
  playbackUrl: string | null;
  downloadUrl: string | null;
  expired?: boolean;
}

interface Segment {
  speakerId: string | null;
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
}

/** /recordings/:id — playback + transcript (search, jump to a line, follow along, export). */
@Component({
  selector: 'app-recording-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recording-page.component.html',
  styleUrls: ['./section-pages.scss', './recording-page.component.scss'],
})
export class RecordingPageComponent implements OnInit, OnDestroy {
  @ViewChild('player') player?: ElementRef<HTMLVideoElement>;
  @ViewChild('transcriptList') transcriptList?: ElementRef<HTMLElement>;

  recording: RecordingDetails | null = null;
  segments: Segment[] = [];
  transcriptError: string | null = null;
  loading = true;
  error = '';
  query = '';
  activeIndex = -1;
  follow = true;
  retrying = false;
  private id = '';
  private subs = new Subscription();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private socket: SocketService,
    private alert: AlertService,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.subs.add(this.route.paramMap.subscribe((p) => {
      this.id = p.get('id') || '';
      void this.load();
    }));
    // Processing finished / transcript ready while this page is open
    this.subs.add(this.socket.onRecordingUpdated().subscribe((d) => {
      if (d?.recordingId === this.id) {
        void this.load(true);
      }
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.setPolling(false);
  }

  /** Socket updates drive the page; a slow poll covers a missed event while work is in progress. */
  private setPolling(on: boolean): void {
    if (on && !this.pollTimer) {
      this.zone.runOutsideAngular(() => {
        this.pollTimer = setInterval(() => this.zone.run(() => void this.load(true)), 15_000);
      });
    } else if (!on && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get transcriptBusy(): boolean {
    return this.recording?.transcriptStatus === 'pending' || this.recording?.transcriptStatus === 'processing';
  }

  async retryTranscript(): Promise<void> {
    if (!this.id || this.retrying) {
      return;
    }
    this.retrying = true;
    this.cdr.markForCheck();
    try {
      await firstValueFrom(this.http.post(`${environment.apiUrl}/recordings/${this.id}/transcript/retry`, {}, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
      await this.load(true);
    } catch (error) {
      this.alert.error(normalizeError(error, "We couldn't retry the transcript. Please try again.").message);
    } finally {
      this.retrying = false;
      this.cdr.markForCheck();
    }
  }

  get visibleSegments(): { s: Segment; i: number }[] {
    const q = this.query.trim().toLowerCase();
    const all = this.segments.map((s, i) => ({ s, i }));
    return q ? all.filter(({ s }) => s.text.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q)) : all;
  }

  get statusText(): string {
    if (this.recording?.expired) return 'This recording has expired and was deleted after 30 days. Its transcript is still available.';
    switch (this.recording?.status) {
      case 'recording': return 'Recording in progress';
      case 'processing': return 'Recording processing… it will appear here when ready.';
      case 'failed': return this.recording.error || "We couldn't process this recording.";
      default: return '';
    }
  }

  async load(quiet = false): Promise<void> {
    if (!this.id) {
      return;
    }
    if (!quiet) {
      this.loading = true;
      this.cdr.markForCheck();
    }
    const opts = { context: new HttpContext().set(SKIP_ERROR_TOAST, true) };
    try {
      const res = await firstValueFrom(this.http.get<{ data: RecordingDetails }>(`${environment.apiUrl}/recordings/${this.id}`, opts));
      this.recording = res.data;
      this.error = '';
      if (res.data.transcriptStatus === 'completed' || res.data.transcriptStatus === 'failed') {
        const t = await firstValueFrom(this.http.get<{ data: { segments: Segment[]; error: string | null } }>(
          `${environment.apiUrl}/recordings/${this.id}/transcript`, opts));
        this.segments = t.data.segments || [];
        this.transcriptError = t.data.error;
      } else {
        this.segments = [];
        this.transcriptError = null;
      }
      this.setPolling(res.data.status === 'recording' || res.data.status === 'processing' || this.transcriptBusy);
    } catch (error) {
      this.error = normalizeError(error, "We couldn't load the recording. Please try again.").message;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  /** Jump playback to a transcript line. */
  seek(segment: Segment): void {
    const video = this.player?.nativeElement;
    if (!video) {
      return;
    }
    video.currentTime = Math.max(0, segment.startTime);
    void video.play().catch(() => undefined);
    this.follow = true;
  }

  /** Highlight the line being spoken (outside Angular: timeupdate fires several times a second). */
  onTimeUpdate(): void {
    const t = this.player?.nativeElement.currentTime ?? 0;
    let index = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].startTime <= t && t < Math.max(this.segments[i].endTime, this.segments[i].startTime + 0.5)) {
        index = i;
      }
      if (this.segments[i].startTime > t) {
        break;
      }
    }
    if (index !== this.activeIndex) {
      this.zone.run(() => {
        this.activeIndex = index;
        this.cdr.markForCheck();
      });
      if (index >= 0 && this.follow && !this.query) {
        document.getElementById(`seg-${index}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  /** The user scrolled the transcript themselves: stop auto-following until they pick a line. */
  onTranscriptWheel(): void {
    this.follow = false;
  }

  /** Export needs the session token, so fetch it and hand the file to the browser. */
  async export(format: 'txt' | 'srt' | 'vtt'): Promise<void> {
    try {
      const blob = await firstValueFrom(this.http.get(`${environment.apiUrl}/recordings/${this.id}/transcript/export`, {
        params: { format },
        responseType: 'blob',
      }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(this.recording?.title || 'transcript').replace(/[^\w\- ]+/g, '').trim() || 'transcript'}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // The interceptor showed why
    }
  }

  clock(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  /** Transcript timestamp, always HH:MM:SS. */
  stamp(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  trackByIndex(_: number, row: { i: number }): number {
    return row.i;
  }
}
