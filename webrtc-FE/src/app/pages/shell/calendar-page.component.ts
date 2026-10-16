import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { Subscription } from 'rxjs';
import { CallManagerService } from 'src/app/core/services/call-manager.service';
import { MeetingApiService, MeetingOccurrence, MeetingSummary } from 'src/app/core/services/meeting.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { CalendarSettings, CalendarSettingsService } from 'src/app/core/services/calendar-settings.service';
import { MeetingEditorComponent } from './meeting-editor.component';
import { CalendarSettingsComponent } from './calendar-settings.component';
import { DayActivate, GridRange } from './time-grid.component';
import { MeetingDetailsComponent } from './meeting-details.component';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';

type View = 'day' | 'work week' | 'week' | 'month' | 'upcoming' | 'past';

const VIEW_LABEL: Record<View, string> = { day: 'Day', 'work week': 'Work week', week: 'Week', month: 'Month', upcoming: 'Upcoming', past: 'Past' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DayCell {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
  items: MeetingOccurrence[];
}

const DAY_MS = 86400000;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Calendar: month / week grid, upcoming and past lists, details, schedule and join. */
@Component({
  selector: 'app-calendar-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calendar-page.component.html',
  styleUrls: ['../shared/list-pane.scss', './section-pages.scss', './calendar-page.component.scss'],
})
export class CalendarPageComponent implements OnInit, OnDestroy {
  readonly views: View[] = ['day', 'work week', 'week', 'month'];
  readonly viewLabels = VIEW_LABEL;
  view: View = 'work week';
  items: MeetingOccurrence[] = [];
  private gridKey = '';
  private gridCache: Date[] = [];
  mini: { month: Date; cells: { date: Date; key: string; inMonth: boolean }[] } = { month: new Date(), cells: [] };
  cursor = startOfDay(new Date());
  days: DayCell[] = [];
  list: MeetingOccurrence[] = [];
  selected: MeetingOccurrence | null = null;
  /** First click on a day highlights it; the next click on the same day opens the meeting form. */
  private pickedOnce = false;
  /** Time-grid: first click arms this slot; a second click on the same slot opens the form. */
  private armed: GridRange | null = null;
  recordings: { _id: string; title: string; startedAt: string; duration: number; status: string; transcriptStatus: string }[] = [];
  loading = false;
  error = false;
  private seq = 0;
  private subs = new Subscription();

  constructor(
    private api: MeetingApiService,
    private calls: CallManagerService,
    private socket: SocketService,
    private modal: NgbModal,
    private alert: AlertService,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private http: HttpClient,
    private store: CalendarSettingsService,
  ) { }

  ngOnInit(): void {
    try {
      const saved = localStorage.getItem('calendar.view') as View | null;
      if (saved === 'day' || saved === 'work week' || saved === 'week' || saved === 'month') {
        this.view = saved;
      }
    } catch {
      // ignore
    }
    this.syncMini();
    void this.load();
    // Settings (first day of week, work days, ...) apply immediately
    this.subs.add(this.store.settings$.subscribe(() => {
      this.syncMini();
      void this.load(true);
      this.cdr.markForCheck();
    }));
    // Someone changed a meeting I'm in / a call started or ended
    this.subs.add(this.socket.onMeetingUpdated().subscribe(() => void this.load(true)));
    this.subs.add(this.calls.meetings$.subscribe(() => void this.load(true)));
    // ?meeting=<id> (from a notification): show its details
    this.subs.add(this.route.queryParamMap.subscribe((params) => {
      const id = params.get('meeting');
      if (id) {
        void this.openById(id);
      }
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  get settings(): CalendarSettings {
    return this.store.value;
  }

  get isGridView(): boolean {
    return this.view === 'day' || this.view === 'work week' || this.view === 'week';
  }

  get viewLabel(): string {
    return VIEW_LABEL[this.view];
  }

  get title(): string {
    const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, o);
    if (this.view === 'upcoming') return 'Upcoming meetings';
    if (this.view === 'past') return 'Past meetings';
    if (this.view === 'month') return fmt(this.cursor, { month: 'long', year: 'numeric' });
    if (this.view === 'day') return fmt(this.cursor, { month: 'long', day: 'numeric', year: 'numeric' });
    const days = this.gridDays;
    const start = days[0] || this.cursor;
    const end = days[days.length - 1] || this.cursor;
    if (start.getFullYear() !== end.getFullYear()) {
      return `${fmt(start, { month: 'long', day: 'numeric', year: 'numeric' })} – ${fmt(end, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    }
    if (start.getMonth() !== end.getMonth()) {
      return `${fmt(start, { month: 'long', day: 'numeric' })} – ${fmt(end, { month: 'long', day: 'numeric' })}, ${end.getFullYear()}`;
    }
    return `${fmt(start, { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`;
  }

  /** Columns of the Day / Work week / Week grid */
  get gridDays(): Date[] {
    const key = `${this.view}|${dayKey(this.cursor)}|${this.settings.firstDayOfWeek}|${this.settings.workDays.join(',')}`;
    if (key !== this.gridKey) {
      this.gridKey = key;
      this.gridCache = this.computeGridDays();
    }
    return this.gridCache;
  }

  private computeGridDays(): Date[] {
    if (this.view === 'day') return [this.cursor];
    const start = this.weekStart(this.cursor);
    const all = Array.from({ length: 7 }, (_, i) => startOfDay(new Date(start.getTime() + i * DAY_MS + 12 * 3600000)));
    if (this.view === 'work week') {
      const work = all.filter((d) => this.settings.workDays.includes(d.getDay()));
      return work.length ? work : all;
    }
    return this.settings.showWeekends ? all : all.filter((d) => d.getDay() !== 0 && d.getDay() !== 6);
  }

  get weekdayNames(): string[] {
    const first = this.settings.firstDayOfWeek;
    return Array.from({ length: 7 }, (_, i) => WEEKDAYS[(first + i) % 7]);
  }

  setView(view: View): void {
    this.pickedOnce = false;
    this.armed = null;
    this.view = view;
    if (view !== 'upcoming' && view !== 'past') {
      try {
        localStorage.setItem('calendar.view', view);
      } catch {
        // ignore
      }
    }
    this.syncMini();
    void this.load();
  }

  move(step: number): void {
    this.pickedOnce = false;
    this.armed = null;
    const c = new Date(this.cursor);
    if (this.view === 'day') {
      c.setDate(c.getDate() + step);
    } else if (this.view === 'week' || this.view === 'work week') {
      c.setDate(c.getDate() + 7 * step);
    } else {
      c.setMonth(c.getMonth() + step, 1);
    }
    this.goTo(c);
  }

  today(): void {
    this.pickedOnce = false;
    this.armed = null;
    this.goTo(new Date());
  }

  /** Days to mark in the time-grid header: the whole week in week views, otherwise the cursor day. */
  get selectedDayKeys(): string[] {
    if (this.view === 'week' || this.view === 'work week') {
      return this.gridDays.map((d) => dayKey(d));
    }
    return [dayKey(this.cursor)];
  }

  /** Highlighted time slot after the first click (not the whole day column). */
  get slotHighlight(): GridRange | null {
    return this.armed;
  }

  /** Select a date (header arrows, Today): keeps the current view. */
  goTo(date: Date): void {
    const next = startOfDay(date);
    const prev = this.cursor;
    this.cursor = next;
    if (this.view === 'upcoming' || this.view === 'past') {
      this.setView('day');
      return;
    }
    this.syncMini();
    const needLoad = this.view === 'day'
      ? dayKey(prev) !== dayKey(next)
      : this.view === 'month'
        ? prev.getMonth() !== next.getMonth() || prev.getFullYear() !== next.getFullYear()
        : dayKey(this.weekStart(prev)) !== dayKey(this.weekStart(next));
    if (needLoad) {
      void this.load();
    } else {
      this.cdr.markForCheck();
    }
  }

  /**
   * Click a day in the sidebar, month grid, or time-grid header/column.
   * First click highlights it; a second click on the same day opens a new meeting.
   */
  pickDay(date: Date, slot?: { start: Date; end: Date }): void {
    this.armed = null;
    const same = dayKey(date) === dayKey(this.cursor);
    if (same && this.pickedOnce) {
      this.newMeeting(slot?.start ?? date, slot?.end);
      return;
    }
    this.pickedOnce = true;
    this.goTo(date);
  }

  onDayActivate(event: DayActivate): void {
    const same = !!this.armed
      && this.armed.start.getTime() === event.start.getTime()
      && this.armed.end.getTime() === event.end.getTime();
    if (same) {
      this.newMeeting(event.start, event.end);
      return;
    }
    this.armed = { start: event.start, end: event.end };
    this.pickedOnce = false;
    this.goTo(event.date);
  }

  // ---- sidebar mini calendar

  private syncMini(): void {
    this.mini = this.buildMini(new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1));
  }

  moveMini(step: number): void {
    this.mini = this.buildMini(new Date(this.mini.month.getFullYear(), this.mini.month.getMonth() + step, 1));
  }

  private buildMini(month: Date): { month: Date; cells: { date: Date; key: string; inMonth: boolean }[] } {
    const start = this.weekStart(month);
    const cells = Array.from({ length: 42 }, (_, i) => {
      const date = startOfDay(new Date(start.getTime() + i * DAY_MS + 12 * 3600000));
      return { date, key: dayKey(date), inMonth: date.getMonth() === month.getMonth() };
    });
    return { month, cells };
  }

  isToday(d: Date): boolean {
    return dayKey(d) === dayKey(new Date());
  }

  /** Sidebar / month: the cursor day, or every day of the open week / work week. */
  isSelectedDay(d: Date): boolean {
    if (this.view === 'upcoming' || this.view === 'past') {
      return false;
    }
    if (this.view === 'week' || this.view === 'work week') {
      return this.gridDays.some((g) => dayKey(g) === dayKey(d));
    }
    return dayKey(d) === dayKey(this.cursor);
  }

  /** First day of a contiguous selected run (for the week strip). */
  isSelStart(i: number): boolean {
    if (!this.isSelectedDay(this.mini.cells[i].date)) return false;
    return i % 7 === 0 || !this.isSelectedDay(this.mini.cells[i - 1].date);
  }

  /** Last day of a contiguous selected run (for the week strip). */
  isSelEnd(i: number): boolean {
    if (!this.isSelectedDay(this.mini.cells[i].date)) return false;
    return i % 7 === 6 || !this.isSelectedDay(this.mini.cells[i + 1].date);
  }

  openSettings(): void {
    this.modal.open(CalendarSettingsComponent, { windowClass: 'app-modal cs-modal', scrollable: true });
  }

  /** A drag on the time grid is a clear “new meeting here” and skips the two-click highlight. */
  onRangeSelect(range: GridRange): void {
    this.armed = null;
    this.pickedOnce = true;
    this.cursor = startOfDay(range.start);
    this.syncMini();
    this.newMeeting(range.start, range.end);
  }

  async load(quiet = false): Promise<void> {
    const seq = ++this.seq;
    const { from, to } = this.range();
    if (!quiet) {
      this.loading = true;
      this.error = false;
      this.cdr.markForCheck();
    }
    try {
      const items = await this.api.range(from, to);
      if (seq !== this.seq) return;
      this.items = items;
      if (this.view === 'upcoming' || this.view === 'past') {
        const now = Date.now();
        this.list = this.view === 'upcoming'
          ? items.filter((i) => new Date(i.occurrenceEnd).getTime() >= now)
          : items.filter((i) => new Date(i.occurrenceEnd).getTime() < now).reverse();
      } else if (this.view === 'month') {
        this.buildGrid(items, from, to);
      }
      if (this.selected) {
        this.selected = items.find((i) => i._id === this.selected!._id && i.occurrenceStart === this.selected!.occurrenceStart) || this.selected;
      }
    } catch {
      if (seq === this.seq) this.error = true;
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  // ---------------------------------------------------------------- actions

  newMeeting(day?: Date, end?: Date): void {
    this.armed = null;
    const ref = this.modal.open(MeetingEditorComponent, { size: 'xl', windowClass: 'app-modal me-modal', backdrop: 'static' });
    ref.componentInstance.defaultStart = day || null;
    ref.componentInstance.defaultEnd = end || null;
    ref.result.then((saved: MeetingSummary) => {
      this.alert.success('Meeting scheduled', { action: { label: 'Copy link', handler: () => this.copyLink(saved) } });
      void this.load();
    }, () => undefined);
  }

  edit(m: MeetingSummary): void {
    const ref = this.modal.open(MeetingEditorComponent, { size: 'xl', windowClass: 'app-modal me-modal', backdrop: 'static' });
    ref.componentInstance.meeting = m;
    ref.result.then(() => {
      this.alert.success('Meeting updated');
      void this.load();
    }, () => undefined);
  }

  async cancel(m: MeetingOccurrence, onlyThis: boolean): Promise<void> {
    const ok = await this.alert.confirm({
      title: onlyThis ? 'Cancel this occurrence?' : `Cancel "${m.title}"?`,
      text: onlyThis
        ? `Only the meeting on ${new Date(m.occurrenceStart).toLocaleString()} is cancelled.`
        : m.recurrence ? 'Every occurrence of this series is cancelled. Invitees are notified.' : 'Invitees are notified.',
      confirmText: 'Cancel meeting',
      cancelText: 'Keep',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      await this.api.cancel(m._id, onlyThis ? m.occurrenceStart : undefined);
      this.selected = null;
      this.alert.success('Meeting cancelled');
      void this.load();
    } catch {
      // the interceptor showed why
    }
  }

  join(m: MeetingSummary): void {
    this.calls.startCall(m.conversationId, 'video', 'meetNow');
  }

  openChat(m: MeetingSummary): void {
    void this.router.navigate(['/chat'], { queryParams: { c: m.conversationId } });
  }

  copyLink(m: Pick<MeetingSummary, 'code'>): void {
    navigator.clipboard.writeText(this.api.linkFor(m.code))
      .then(() => this.alert.info('Meeting link copied'))
      .catch(() => this.alert.error("We couldn't copy the link."));
  }

  select(item: MeetingOccurrence): void {
    const ref = this.modal.open(MeetingDetailsComponent, { size: 'lg', windowClass: 'app-modal md-modal', scrollable: false });
    ref.componentInstance.meeting = item;
    ref.result.then((r: { action: string; onlyThis?: boolean } | undefined) => {
      switch (r?.action) {
        case 'join': this.join(item); break;
        case 'chat': this.openChat(item); break;
        case 'copy': this.copyLink(item); break;
        case 'edit': this.edit(item); break;
        case 'cancel': void this.cancel(item, !!r.onlyThis); break;
      }
    }, () => undefined).finally(() => this.clearMeetingParam());
  }

  private clearMeetingParam(): void {
    if (this.route.snapshot.queryParamMap.get('meeting')) {
      void this.router.navigate([], { queryParams: { meeting: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
  }

  /** Join is offered from 15 minutes before until the end, or whenever its call is running. */
  canJoin(m: MeetingOccurrence): boolean {
    const now = Date.now();
    return !!m.activeCallId || (new Date(m.occurrenceStart).getTime() - 15 * 60000 <= now && now <= new Date(m.occurrenceEnd).getTime());
  }

  statusOf(m: MeetingOccurrence): 'live' | 'upcoming' | 'ended' {
    if (m.activeCallId) return 'live';
    return new Date(m.occurrenceEnd).getTime() < Date.now() ? 'ended' : 'upcoming';
  }

  timeRange(m: MeetingOccurrence): string {
    const s = new Date(m.occurrenceStart);
    const e = new Date(m.occurrenceEnd);
    const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${t(s)} – ${t(e)}`;
  }

  trackByDay(_: number, d: { key: string }): string {
    return d.key;
  }

  trackByItem(_: number, m: MeetingOccurrence): string {
    return `${m._id}:${m.occurrenceStart}`;
  }

  // ---------------------------------------------------------------- internals

  private async openById(id: string): Promise<void> {
    try {
      const m = await this.api.get(id);
      const next = this.items.concat(this.list).find((i) => i._id === id);
      this.select(next || { ...m, occurrenceStart: m.startAt, occurrenceEnd: m.endAt });
    } catch {
      // not visible to me any more
    }
  }

  private weekStart(d: Date): Date {
    const back = (d.getDay() - this.settings.firstDayOfWeek + 7) % 7;
    return startOfDay(new Date(d.getTime() - back * DAY_MS + 12 * 3600000));
  }

  private range(): { from: Date; to: Date } {
    const now = startOfDay(new Date());
    switch (this.view) {
      case 'upcoming':
        return { from: new Date(), to: new Date(now.getTime() + 31 * DAY_MS) };
      case 'past':
        return { from: new Date(now.getTime() - 31 * DAY_MS), to: new Date() };
      case 'day':
        return { from: this.cursor, to: new Date(this.cursor.getTime() + DAY_MS) };
      case 'work week':
      case 'week': {
        const from = this.weekStart(this.cursor);
        return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
      }
      default: {
        const first = new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1);
        const from = this.weekStart(first);
        return { from, to: new Date(from.getTime() + 42 * DAY_MS) };
      }
    }
  }

  private buildGrid(items: MeetingOccurrence[], from: Date, to: Date): void {
    const byDay = new Map<string, MeetingOccurrence[]>();
    for (const item of items) {
      const k = dayKey(new Date(item.occurrenceStart));
      byDay.set(k, [...(byDay.get(k) || []), item]);
    }
    const todayKey = dayKey(new Date());
    const days: DayCell[] = [];
    for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
      // Midday avoids DST-shift surprises when stepping by 24h
      const date = startOfDay(new Date(t + 12 * 3600000));
      const key = dayKey(date);
      if (days.some((d) => d.key === key)) continue;
      days.push({ date, key, inMonth: date.getMonth() === this.cursor.getMonth(), isToday: key === todayKey, items: byDay.get(key) || [] });
    }
    this.days = days;
  }
}
