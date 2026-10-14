import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { normalizeError } from 'src/app/core/errors/app-error';
import { CallManagerService } from 'src/app/core/services/call-manager.service';
import { MeetingApiService, MeetingPreview } from 'src/app/core/services/meeting.service';

/** /meet/:code — a meeting link or ID: preview, password when needed, then the pre-join screen. */
@Component({
  selector: 'app-meet-join',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./section-pages.scss'],
  styles: [`
    .join { max-width: 440px; margin: 48px auto; padding: 24px; background: var(--app-surface); border: 1px solid var(--app-border); border-radius: 14px; }
    .join h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 4px; }
    .join__meta { color: var(--app-muted); font-size: 0.875rem; margin: 0 0 16px; }
    .join__code { display: flex; gap: 8px; }
  `],
  template: `
    <section class="page">
      <div class="join">
        <ng-container *ngIf="!code">
          <h1>Join a meeting</h1>
          <p class="join__meta">Enter the meeting ID from your invitation.</p>
          <form class="join__code" (ngSubmit)="goToCode()">
            <input class="form-control" name="code" [(ngModel)]="codeInput" placeholder="e.g. k7p-q2xm-4tz" aria-label="Meeting ID" autocomplete="off" />
            <button type="submit" class="btn btn-primary" [disabled]="!codeInput.trim()">Next</button>
          </form>
        </ng-container>

        <ng-container *ngIf="code">
          <p *ngIf="loading" role="status"><span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading meeting…</p>
          <ng-container *ngIf="preview as p">
            <h1>{{ p.title }}</h1>
            <p class="join__meta">
              {{ p.startAt | date: 'EEE, MMM d, h:mm a' }} · organised by {{ p.organizerName }}<ng-container *ngIf="p.recurrence"> · {{ p.recurrence }}</ng-container>
            </p>
            <p class="text-danger" *ngIf="p.cancelled">This meeting was cancelled.</p>
            <form *ngIf="!p.cancelled" (ngSubmit)="join()">
              <div class="mb-3" *ngIf="p.needsPassword">
                <label for="meet-pw" class="form-label">Meeting password</label>
                <input id="meet-pw" type="password" class="form-control" name="password" [(ngModel)]="password" autocomplete="off" required />
              </div>
              <button type="submit" class="btn btn-primary w-100" [disabled]="joining || (p.needsPassword && !password)">
                <span *ngIf="joining" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Join meeting
              </button>
            </form>
          </ng-container>
          <p class="text-danger mt-3 mb-0" *ngIf="error" role="alert">{{ error }}</p>
        </ng-container>
      </div>
    </section>
  `,
})
export class MeetJoinComponent implements OnInit {
  code = '';
  codeInput = '';
  preview: MeetingPreview | null = null;
  password = '';
  loading = false;
  joining = false;
  error = '';

  constructor(
    private api: MeetingApiService,
    private calls: CallManagerService,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.route.paramMap.subscribe((params) => {
      this.code = (params.get('code') || '').trim().toLowerCase();
      this.preview = null;
      this.error = '';
      if (this.code) {
        void this.load();
      }
      this.cdr.markForCheck();
    });
  }

  goToCode(): void {
    const code = this.codeInput.trim().toLowerCase().replace(/\s+/g, '');
    if (code) {
      void this.router.navigate(['/meet', code]);
    }
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.cdr.markForCheck();
    try {
      this.preview = await this.api.preview(this.code);
    } catch (error) {
      this.error = normalizeError(error, "We couldn't find that meeting. Check the link or ID.").message;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  async join(): Promise<void> {
    this.joining = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const res = await this.api.join(this.code, this.password || undefined);
      // The pre-join screen (camera / mic / devices) opens on top; lobby rules apply on entry
      this.calls.startCall(res.conversationId, 'video', 'meetNow');
      void this.router.navigate(['/calendar']);
    } catch (error) {
      this.error = normalizeError(error, "We couldn't join the meeting. Please try again.").message;
    } finally {
      this.joining = false;
      this.cdr.markForCheck();
    }
  }
}
