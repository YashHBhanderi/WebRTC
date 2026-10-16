import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import {
  CalendarSettings, CalendarSettingsService, DEFAULT_DURATIONS, TIME_SCALES, TimeScale, WorkLocation, WorkPeriod,
} from 'src/app/core/services/calendar-settings.service';

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
  templateUrl: './calendar-settings.component.html',
  styleUrls: ['./calendar-settings.component.scss'],
})
export class CalendarSettingsComponent implements OnInit {
  readonly dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  readonly shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly scales = TIME_SCALES;
  readonly durations = DEFAULT_DURATIONS;
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
    this.rows = [...this.rows, { start: toTime(start), end: toTime(Math.min(start + 120, 24 * 60 - 1)), location: this.draft.defaultLocation }];
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
    this.store.update({
      ...this.draft,
      timeScale: Number(this.draft.timeScale) as TimeScale,
      defaultDuration: Number(this.draft.defaultDuration),
      workPeriods: sorted,
    });
    this.modal.close();
  }
}
