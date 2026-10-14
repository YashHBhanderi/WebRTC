import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type TimeScale = 60 | 30 | 15 | 10 | 6 | 5;
export type WorkLocation = 'office' | 'remote';
export type CalendarView = 'day' | 'work week' | 'week' | 'month';

export interface WorkPeriod {
  /** Minutes from midnight */
  start: number;
  end: number;
  location: WorkLocation;
}

export interface CalendarSettings {
  /** 0 = Sunday … 6 = Saturday */
  firstDayOfWeek: number;
  timeScale: TimeScale;
  timeZone: string;
  /** 0 = Sunday … 6 = Saturday */
  workDays: number[];
  workPeriods: WorkPeriod[];
  showWorkLocation: boolean;
}

export const TIME_SCALES: { value: TimeScale; label: string }[] = [
  { value: 60, label: '60 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 6, label: '6 minutes' },
  { value: 5, label: '5 minutes - Most space for details' },
];

const KEY = 'calendar.settings.v1';

const DEFAULTS: CalendarSettings = {
  firstDayOfWeek: 0,
  timeScale: 5,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  workDays: [1, 2, 3, 4, 5],
  workPeriods: [{ start: 9 * 60, end: 17 * 60, location: 'office' }],
  showWorkLocation: true,
};

/** Calendar preferences (appearance, work hours and location), saved on this device. */
@Injectable({ providedIn: 'root' })
export class CalendarSettingsService {
  readonly settings$ = new BehaviorSubject<CalendarSettings>(this.read());

  get value(): CalendarSettings {
    return this.settings$.value;
  }

  update(patch: Partial<CalendarSettings>): void {
    const next = this.sanitize({ ...this.value, ...patch });
    this.settings$.next(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // not persisted; still applied for this session
    }
  }

  private read(): CalendarSettings {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        return this.sanitize({ ...DEFAULTS, ...JSON.parse(raw) });
      }
    } catch {
      // fall through to defaults
    }
    return { ...DEFAULTS, workPeriods: DEFAULTS.workPeriods.map((p) => ({ ...p })) };
  }

  private sanitize(s: CalendarSettings): CalendarSettings {
    const scale = TIME_SCALES.some((t) => t.value === s.timeScale) ? s.timeScale : DEFAULTS.timeScale;
    const periods = (s.workPeriods || [])
      .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start)
      .map((p) => ({ start: p.start, end: p.end, location: (p.location === 'remote' ? 'remote' : 'office') as WorkLocation }))
      .sort((a, b) => a.start - b.start);
    return {
      firstDayOfWeek: Math.min(6, Math.max(0, Math.floor(s.firstDayOfWeek) || 0)),
      timeScale: scale,
      timeZone: s.timeZone || DEFAULTS.timeZone,
      workDays: [...new Set((s.workDays || []).filter((d) => d >= 0 && d <= 6))].sort(),
      workPeriods: periods.length ? periods : DEFAULTS.workPeriods.map((p) => ({ ...p })),
      showWorkLocation: !!s.showWorkLocation,
    };
  }
}
