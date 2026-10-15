import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { CalendarSettings, CalendarSettingsService, TIME_SCALES, TimeScale, WorkLocation, WorkPeriod } from 'src/app/core/services/calendar-settings.service';

const pad = (n: number) => String(n).padStart(2, '0');
const toTime = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fromTime = (t: string) => {
  const [h, m] = (t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

interface PeriodRow {
  start: string;
  end: string;
  location: WorkLocation;
}

/** Calendar settings (Teams-style): appearance, work hours and location. Applied on Save. */
@Component({
  selector: 'app-calendar-settings',
  changeDetection: ChangeDetectionStrategy.Default,
  styles: [`
    .cs h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--app-muted); margin: 18px 0 10px; }
    .cs h3:first-child { margin-top: 0; }
    .cs__days { display: flex; flex-wrap: wrap; gap: 6px; }
    .cs__day { min-width: 46px; padding: 4px 8px; border: 1px solid var(--app-border); border-radius: 16px; background: transparent; color: var(--app-text); font-size: 0.8rem; }
    .cs__day--on { background: var(--app-brand); border-color: var(--app-brand); color: var(--app-on-brand); }
    .cs__period { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .cs__period input[type=time] { width: 120px; }
    .cs__period select { width: 120px; }
  `],
  template: `
    <div class="modal-header">
      <h2 class="modal-title h5" id="cal-settings-title">Calendar settings</h2>
      <button type="button" class="btn-close" aria-label="Close" (click)="modal.dismiss()"></button>
    </div>
    <div class="modal-body cs" aria-labelledby="cal-settings-title">
      <h3>Calendar appearance</h3>
      <div class="mb-3">
        <label for="cs-first" class="form-label">First day of week</label>
        <select id="cs-first" class="form-select" [(ngModel)]="draft.firstDayOfWeek">
          <option *ngFor="let d of dayNames; let i = index" [ngValue]="i">{{ d }}</option>
        </select>
      </div>
      <div class="mb-3">
        <label for="cs-scale" class="form-label">Time scale</label>
        <select id="cs-scale" class="form-select" [(ngModel)]="draft.timeScale">
          <option *ngFor="let t of scales" [ngValue]="t.value">{{ t.label }}</option>
        </select>
        <div class="form-text">Applies to Day, Work week and Week views.</div>
      </div>

      <h3>Work hours and location</h3>
      <div class="mb-3">
        <span class="form-label d-block">Working days</span>
        <div class="cs__days" role="group" aria-label="Working days">
          <button type="button" class="cs__day" *ngFor="let d of shortDays; let i = index" [class.cs__day--on]="isWorkDay(i)" [attr.aria-pressed]="isWorkDay(i)" (click)="toggleDay(i)">{{ d }}</button>
        </div>
      </div>
      <div class="mb-2">
        <span class="form-label d-block">Work hours</span>
        <div class="cs__period" *ngFor="let p of rows; let i = index">
          <input type="time" class="form-control" [(ngModel)]="p.start" [attr.aria-label]="'Start of period ' + (i + 1)" />
          <span>to</span>
          <input type="time" class="form-control" [(ngModel)]="p.end" [attr.aria-label]="'End of period ' + (i + 1)" />
          <select class="form-select" [(ngModel)]="p.location" [attr.aria-label]="'Location of period ' + (i + 1)">
            <option value="office">Office</option>
            <option value="remote">Remote</option>
          </select>
          <button type="button" class="btn btn-sm btn-light" (click)="remove(i)" [disabled]="rows.length === 1" [attr.aria-label]="'Remove period ' + (i + 1)"><i class="ti ti-trash"></i></button>
        </div>
        <button type="button" class="btn btn-sm btn-light" (click)="add()"><i class="ti ti-plus me-1"></i>Add work hours</button>
      </div>
      <div class="form-check form-switch mt-3">
        <input id="cs-loc" class="form-check-input" type="checkbox" role="switch" [(ngModel)]="draft.showWorkLocation" />
        <label for="cs-loc" class="form-check-label">Show work location on calendar</label>
      </div>
      <p class="text-danger small mt-2 mb-0" *ngIf="error" role="alert">{{ error }}</p>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-light" (click)="modal.dismiss()">Cancel</button>
      <button type="button" class="btn btn-primary" (click)="save()">Save</button>
    </div>
  `,
})
export class CalendarSettingsComponent implements OnInit {
  readonly dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  readonly shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly scales = TIME_SCALES;
  draft!: CalendarSettings;
  rows: PeriodRow[] = [];
  error = '';

  constructor(public modal: NgbActiveModal, private store: CalendarSettingsService) {}

  ngOnInit(): void {
    const current = this.store.value;
    this.draft = { ...current, workDays: [...current.workDays] };
    this.rows = current.workPeriods.map((p) => ({ start: toTime(p.start), end: toTime(p.end), location: p.location }));
  }

  isWorkDay(d: number): boolean {
    return this.draft.workDays.includes(d);
  }

  toggleDay(d: number): void {
    this.draft.workDays = this.isWorkDay(d) ? this.draft.workDays.filter((x) => x !== d) : [...this.draft.workDays, d];
  }

  add(): void {
    const last = this.rows[this.rows.length - 1];
    const start = last ? Math.min(fromTime(last.end) + 60, 22 * 60) : 9 * 60;
    this.rows = [...this.rows, { start: toTime(start), end: toTime(Math.min(start + 120, 24 * 60 - 1)), location: 'office' }];
  }

  remove(i: number): void {
    this.rows = this.rows.filter((_, idx) => idx !== i);
  }

  save(): void {
    const periods: WorkPeriod[] = this.rows.map((r) => ({ start: fromTime(r.start), end: fromTime(r.end), location: r.location }));
    if (periods.some((p) => p.end <= p.start)) {
      this.error = 'Each work period must end after it starts.';
      return;
    }
    const sorted = [...periods].sort((a, b) => a.start - b.start);
    if (sorted.some((p, i) => i > 0 && p.start < sorted[i - 1].end)) {
      this.error = 'Work periods cannot overlap.';
      return;
    }
    this.store.update({ ...this.draft, timeScale: Number(this.draft.timeScale) as TimeScale, workPeriods: sorted });
    this.modal.close();
  }
}
