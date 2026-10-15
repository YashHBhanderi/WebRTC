import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { MeetingApiService, MeetingOccurrence } from 'src/app/core/services/meeting.service';
import { environment } from 'src/environments/environment';

interface RecordingRow {
  _id: string;
  startedAt: string;
  status: string;
  transcriptStatus: string;
}

/**
 * Meeting details popup (Teams-style). Closes with { action } and the calendar page performs it
 * (join / chat / copy / edit / cancel), so the existing flows are reused.
 */
@Component({
  selector: 'app-meeting-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./meeting-details.component.scss'],
  template: `
    <div class="md" *ngIf="meeting as m">
      <header class="md__hero" [class.md__hero--live]="status === 'live'" [class.md__hero--ended]="status === 'ended'">
        <button type="button" class="md__close" (click)="modal.dismiss()" aria-label="Close"><i class="ti ti-x"></i></button>
        <span class="md__status">
          <span class="md__dot"></span>{{ status === 'live' ? 'Live now' : status === 'ended' ? 'Ended' : 'Upcoming' }}
        </span>
        <h2 class="md__title" id="md-title">{{ m.title }}</h2>
        <p class="md__when">
          <i class="ti ti-clock" aria-hidden="true"></i>
          {{ m.occurrenceStart | date: 'EEEE, MMMM d, y' }} · {{ m.occurrenceStart | date: 'shortTime' }} – {{ m.occurrenceEnd | date: 'shortTime' }}
          <span class="md__chip">{{ duration }}</span>
        </p>
        <p class="md__when" *ngIf="m.recurrenceText"><i class="ti ti-repeat" aria-hidden="true"></i>{{ m.recurrenceText }}</p>
        <div class="md__cta">
          <button type="button" class="btn btn-light md__join" *ngIf="canJoin" (click)="act('join')"><i class="ti ti-video me-2"></i>{{ status === 'live' ? 'Join now' : 'Join' }}</button>
          <button type="button" class="btn md__ghost" (click)="act('chat')"><i class="ti ti-message me-2"></i>Chat</button>
          <button type="button" class="btn md__ghost" (click)="act('copy')"><i class="ti ti-link me-2"></i>Copy link</button>
        </div>
      </header>

      <div class="md__body">
        <section class="md__sec">
          <h3><i class="ti ti-user-star"></i>Organizer</h3>
          <div class="md__person"><app-avatar [src]="m.organizer.avatar" [name]="m.organizer.username" [size]="32"></app-avatar><span>{{ m.organizer.username }}</span><small *ngIf="m.isOrganizer">You</small></div>
        </section>

        <section class="md__sec">
          <h3><i class="ti ti-users"></i>Participants <span class="md__count">{{ m.invitees.length + 1 }}</span></h3>
          <div class="md__people">
            <div class="md__person" *ngFor="let p of m.invitees"><app-avatar [src]="p.avatar" [name]="p.username" [size]="32"></app-avatar><span>{{ p.username }}</span></div>
            <span class="md__muted" *ngIf="!m.invitees.length">No one else was invited.</span>
          </div>
        </section>

        <section class="md__sec">
          <h3><i class="ti ti-info-circle"></i>Meeting info</h3>
          <dl class="md__info">
            <dt>Link</dt><dd><a [href]="link" target="_blank" rel="noopener">{{ link }}</a></dd>
            <dt>Meeting ID</dt><dd>{{ m.code }}</dd>
            <dt>Security</dt><dd>{{ m.hasPassword ? 'Password protected' : 'No password' }}<ng-container *ngIf="m.lobby"> · Lobby on</ng-container></dd>
          </dl>
        </section>

        <section class="md__sec" *ngIf="m.description">
          <h3><i class="ti ti-align-left"></i>Details</h3>
          <p class="md__desc">{{ m.description }}</p>
        </section>

        <section class="md__sec" *ngIf="recordings.length">
          <h3><i class="ti ti-player-play"></i>Recordings</h3>
          <a class="md__rec" *ngFor="let r of recordings" [routerLink]="['/recordings', r._id]" (click)="modal.dismiss()">
            <i class="ti ti-player-play"></i>
            <span>{{ r.startedAt | date: 'MMM d, h:mm a' }}<small> · {{ recordingLabel(r) }}</small></span>
          </a>
        </section>
      </div>

      <footer class="md__foot" *ngIf="m.isOrganizer">
        <button type="button" class="btn btn-light btn-sm" (click)="act('edit')"><i class="ti ti-pencil me-1"></i>Edit</button>
        <span class="md__spacer"></span>
        <button type="button" class="btn btn-outline-danger btn-sm" *ngIf="m.recurrence" (click)="act('cancel', true)"><i class="ti ti-trash me-1"></i>Cancel this one</button>
        <button type="button" class="btn btn-outline-danger btn-sm" (click)="act('cancel', false)"><i class="ti ti-trash me-1"></i>{{ m.recurrence ? 'Cancel series' : 'Delete meeting' }}</button>
      </footer>
    </div>
  `,
})
export class MeetingDetailsComponent implements OnInit {
  @Input() meeting!: MeetingOccurrence;
  recordings: RecordingRow[] = [];

  constructor(public modal: NgbActiveModal, private api: MeetingApiService, private http: HttpClient, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    void this.loadRecordings();
  }

  get link(): string {
    return this.api.linkFor(this.meeting.code);
  }

  get status(): 'live' | 'upcoming' | 'ended' {
    if (this.meeting.activeCallId) return 'live';
    return new Date(this.meeting.occurrenceEnd).getTime() < Date.now() ? 'ended' : 'upcoming';
  }

  /** Join is offered from 15 minutes before until the end, or whenever its call is running. */
  get canJoin(): boolean {
    const now = Date.now();
    const m = this.meeting;
    return !!m.activeCallId || (new Date(m.occurrenceStart).getTime() - 15 * 60000 <= now && now <= new Date(m.occurrenceEnd).getTime());
  }

  get duration(): string {
    const min = Math.max(0, Math.round((new Date(this.meeting.occurrenceEnd).getTime() - new Date(this.meeting.occurrenceStart).getTime()) / 60000));
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h ? (m ? `${h} hr ${m} min` : `${h} hr`) : `${m} min`;
  }

  act(action: 'join' | 'chat' | 'copy' | 'edit' | 'cancel', onlyThis = false): void {
    this.modal.close({ action, onlyThis });
  }

  recordingLabel(r: RecordingRow): string {
    if (r.status === 'completed') {
      if (r.transcriptStatus === 'completed') return 'Recording · transcript';
      if (r.transcriptStatus === 'pending' || r.transcriptStatus === 'processing') return 'Recording · transcription processing';
      return 'Recording';
    }
    if (r.status === 'failed') return 'Recording failed';
    if (r.status === 'recording') return 'Recording in progress';
    return 'Recording processing';
  }

  private async loadRecordings(): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.get<{ data: RecordingRow[] }>(
        `${environment.apiUrl}/conversations/${this.meeting.conversationId}/recordings`,
        { context: new HttpContext().set(SKIP_ERROR_TOAST, true) },
      ));
      this.recordings = res.data || [];
      this.cdr.markForCheck();
    } catch {
      // the section stays hidden
    }
  }
}
