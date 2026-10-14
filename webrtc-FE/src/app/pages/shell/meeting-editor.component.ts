import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { firstValueFrom } from 'rxjs';
import { normalizeError } from 'src/app/core/errors/app-error';
import { CalendarSettingsService } from 'src/app/core/services/calendar-settings.service';
import { GridRange } from './time-grid.component';
import { MeetingApiService, MeetingInput, MeetingOccurrence, MeetingSummary, RecurrenceFreq } from 'src/app/core/services/meeting.service';
import { UserService } from 'src/app/core/services/user.service';

type RepeatChoice = 'none' | RecurrenceFreq;

const pad = (n: number) => String(n).padStart(2, '0');
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Schedule / edit a meeting (modal). Resolves with the saved meeting. */
@Component({
  selector: 'app-meeting-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meeting-editor.component.html',
  styleUrls: ['./meeting-editor.component.scss'],
})
export class MeetingEditorComponent implements OnInit {
  /** Editing an existing meeting (organizer); otherwise a new one */
  @Input() meeting: MeetingSummary | null = null;
  /** New meetings start here (defaults to the next half hour) */
  @Input() defaultStart: Date | null = null;
  /** End picked on the calendar grid (defaults to 30 minutes after the start) */
  @Input() defaultEnd: Date | null = null;

  readonly weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  title = '';
  description = '';
  date = '';
  startTime = '';
  endTime = '';
  repeat: RepeatChoice = 'none';
  interval = 1;
  byWeekday = new Set<number>();
  repeatUntil = '';
  lobby = false;
  usePassword = false;
  password = '';
  invitees = new Map<string, { _id: string; username: string; avatar?: string }>();

  people: { _id: string; username: string; avatar?: string }[] = [];
  peopleSearch = '';
  /** Time grid (same component as the Calendar page) */
  readonly gridViews: { value: 'day' | 'work week' | 'week'; label: string }[] = [
    { value: 'day', label: 'Day' }, { value: 'work week', label: 'Work week' }, { value: 'week', label: 'Week' },
  ];
  gridView: 'day' | 'work week' | 'week' = 'day';
  gridItems: MeetingOccurrence[] = [];
  private gridKey = '';
  private gridDaysCache: Date[] = [];
  private draftKey = '';
  private draftCache: GridRange | null = null;
  private gridSeq = 0;
  saving = false;
  error = '';

  constructor(
    public modal: NgbActiveModal,
    private api: MeetingApiService,
    private users: UserService,
    private cdr: ChangeDetectorRef,
    private calendarSettings: CalendarSettingsService,
  ) {}

  ngOnInit(): void {
    const m = this.meeting;
    let start: Date;
    let end: Date;
    if (m) {
      start = new Date(m.startAt);
      end = new Date(m.endAt);
      this.title = m.title;
      this.description = m.description;
      this.lobby = m.lobby;
      this.usePassword = m.hasPassword;
      m.invitees.forEach((p) => this.invitees.set(p._id, p));
      if (m.recurrence) {
        this.repeat = m.recurrence.freq;
        this.interval = m.recurrence.interval || 1;
        this.byWeekday = new Set(m.recurrence.byWeekday || []);
        this.repeatUntil = m.recurrence.until ? toDateInput(new Date(m.recurrence.until)) : '';
      }
    } else {
      start = this.defaultStart ? new Date(this.defaultStart) : new Date();
      if (!this.defaultStart || (start.getHours() === 0 && start.getMinutes() === 0)) {
        // Next half hour (or 9:00 when a whole day was picked)
        const now = new Date();
        if (this.defaultStart && toDateInput(start) !== toDateInput(now)) {
          start.setHours(9, 0, 0, 0);
        } else {
          start = new Date(now);
          start.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
        }
      }
      end = this.defaultEnd && this.defaultEnd.getTime() > start.getTime() ? new Date(this.defaultEnd) : new Date(start.getTime() + 30 * 60 * 1000);
      this.byWeekday = new Set([start.getDay()]);
    }
    this.date = toDateInput(start);
    this.startTime = toTimeInput(start);
    this.endTime = toTimeInput(end);

    void this.loadGrid();
    this.users.getAllUsersExceptCurrentUser().subscribe({
      next: (res) => {
        this.people = (res.data || []).map((u: any) => ({ _id: String(u._id), username: u.username, avatar: u.avatar }))
          .sort((a, b) => a.username.localeCompare(b.username));
        this.cdr.markForCheck();
      },
      error: () => undefined,
    });
  }

  get gridDays(): Date[] {
    const base = new Date();
    if (isNaN(base.getTime())) return this.gridDaysCache;
    const key = `${this.gridView}|${this.date}`;
    if (key !== this.gridKey) {
      this.gridKey = key;
      if (this.gridView === 'day') {
        this.gridDaysCache = [base];
      } else {
        const st = this.calendarSettings.value;
        const back = (base.getDay() - st.firstDayOfWeek + 7) % 7;
        const all = Array.from({ length: 7 }, (_, i) => new Date(base.getFullYear(), base.getMonth(), base.getDate() - back + i));
        const work = all.filter((d) => st.workDays.includes(d.getDay()));
        this.gridDaysCache = this.gridView === 'work week' && work.length ? work : all;
      }
    }
    return this.gridDaysCache;
  }

  /** The proposed range, drawn on the grid */
  get draft(): GridRange | null {
    const key = `${this.date}|${this.startTime}|${this.endTime}`;
    if (key !== this.draftKey) {
      this.draftKey = key;
      const start = new Date();
      let end = new Date();
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000);
      this.draftCache = isNaN(start.getTime()) || isNaN(end.getTime()) ? null : { start, end };
    }
    return this.draftCache;
  }

  /** Opens the grid an hour before the proposed start */
  get scrollMinutes(): number {
    const [h, m] = (this.startTime || '9:00').split(':').map(Number);
    return Math.max(0, (h || 0) * 60 + (m || 0) - 60);
  }

  get dayTitle(): string {
    const d = new Date(`${this.date}T00:00`);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  shiftDay(step: number): void {
    const d = new Date(`${this.date}T00:00`);
    if (isNaN(d.getTime())) return;
    d.setDate(d.getDate() + step);
    this.date = toDateInput(d);
    void this.loadGrid();
    this.cdr.markForCheck();
  }

  get draftLabel(): string {
    return this.title.trim() || 'New meeting';
  }

  setGridView(v: 'day' | 'work week' | 'week'): void {
    this.gridView = v;
    void this.loadGrid();
  }

  /** Click / drag on the grid sets date, start and end. */
  onGridRange(r: GridRange): void {
    this.date = toDateInput(r.start);
    this.startTime = toTimeInput(r.start);
    this.endTime = toTimeInput(r.end);
    void this.loadGrid();
    this.cdr.markForCheck();
  }

  /** Dragging the draft's bottom edge changes the end time only. */
  onGridResize(r: GridRange): void {
    this.endTime = toTimeInput(r.end);
    this.cdr.markForCheck();
  }

  async loadGrid(): Promise<void> {
    const days = this.gridDays;
    if (!days.length) return;
    const seq = ++this.gridSeq;
    const from = days[0];
    const to = new Date(days[days.length - 1].getTime() + 24 * 3600 * 1000);
    try {
      const items = await this.api.range(from, to);
      if (seq !== this.gridSeq) return;
      this.gridItems = items.filter((i) => i._id !== this.meeting?._id);
      this.cdr.markForCheck();
    } catch {
      // the grid just shows no other meetings
    }
  }

  get filteredPeople() {
    const q = this.peopleSearch.trim().toLowerCase();
    return this.people.filter((p) => !this.invitees.has(p._id) && (!q || p.username.toLowerCase().includes(q))).slice(0, 8);
  }

  get inviteeList() {
    return [...this.invitees.values()];
  }

  addInvitee(p: { _id: string; username: string; avatar?: string }): void {
    this.invitees.set(p._id, p);
    this.peopleSearch = '';
  }

  removeInvitee(id: string): void {
    this.invitees.delete(id);
  }

  toggleWeekday(day: number): void {
    if (this.byWeekday.has(day) && this.byWeekday.size > 1) {
      this.byWeekday.delete(day);
    } else {
      this.byWeekday.add(day);
    }
  }

  async save(): Promise<void> {
    this.error = '';
    const start = new Date(`${this.date}T${this.startTime}`);
    let end = new Date(`${this.date}T${this.endTime}`);
    if (!this.title.trim()) {
      this.error = 'Add a title.';
      return;
    }
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      this.error = 'Choose a date and times.';
      return;
    }
    if (end.getTime() <= start.getTime()) {
      // Ends after midnight
      end = new Date(end.getTime() + 24 * 3600 * 1000);
    }
    if (this.usePassword && !this.meeting?.hasPassword && this.password.trim().length < 4) {
      this.error = 'The password must be at least 4 characters.';
      return;
    }
    const input: MeetingInput = {
      title: this.title.trim(),
      description: this.description.trim(),
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      timeZone: this.timeZone,
      invitees: [...this.invitees.keys()],
      lobby: this.lobby,
      recurrence: this.repeat === 'none' ? null : {
        freq: this.repeat,
        interval: this.repeat === 'weekdays' ? 1 : Math.max(1, Math.floor(this.interval || 1)),
        byWeekday: this.repeat === 'weekly' ? [...this.byWeekday] : undefined,
        until: this.repeatUntil ? new Date(`${this.repeatUntil}T23:59:59`).toISOString() : null,
      },
    };
    if (!this.usePassword) {
      input.password = '';
    } else if (this.password.trim()) {
      input.password = this.password.trim();
    }
    this.saving = true;
    this.cdr.markForCheck();
    try {
      const saved = this.meeting ? await this.api.update(this.meeting._id, input) : await this.api.create(input);
      this.modal.close(saved);
    } catch (error) {
      this.error = normalizeError(error, this.meeting ? "We couldn't update the meeting. Please try again." : "We couldn't create the meeting. Please try again.").message;
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }
}
