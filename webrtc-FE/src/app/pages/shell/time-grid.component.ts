import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener,
  Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { CalendarSettings, CalendarSettingsService } from 'src/app/core/services/calendar-settings.service';
import { MeetingOccurrence } from 'src/app/core/services/meeting.service';

export interface GridRange {
  start: Date;
  end: Date;
}

interface PlacedEvent {
  item: MeetingOccurrence;
  top: number;
  height: number;
  left: number;
  width: number;
}

interface OffBlock {
  top: number;
  height: number;
}

interface Column {
  date: Date;
  key: string;
  isToday: boolean;
  events: PlacedEvent[];
  off: OffBlock[];
  location: string;
  draft: { top: number; height: number } | null;
}

/** Row height in px for one slot, per time scale: finer scales get more room (Teams-like). */
const SLOT_PX: Record<number, number> = { 60: 48, 30: 32, 15: 24, 10: 20, 6: 18, 5: 16 };
const DAY_MIN = 24 * 60;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Teams-style time grid: one column per day, divided into slots of the chosen time scale.
 * Click or drag on a column to pick a range; an optional draft block (used by the meeting editor)
 * can be resized from its bottom edge.
 */
@Component({
  selector: 'app-time-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./time-grid.component.scss'],
  template: `
    <div class="tg" [style.--slot-px]="slotPx + 'px'" [style.--hour-px]="hourPx + 'px'" [class.tg--compact]="compact">
      <div class="tg__head" [style.--cols]="columns.length">
        <span class="tg__corner"></span>
        <div class="tg__day" *ngFor="let c of columns; trackBy: trackByKey" [class.tg__day--today]="c.isToday">
          <span class="tg__dow">{{ c.date | date: 'EEE' }}</span>
          <span class="tg__dom">{{ c.date | date: 'd' }}</span>
          <span class="tg__loc" *ngIf="settings.showWorkLocation && c.location"><i class="ti" [class.ti-building]="c.location === 'Office'" [class.ti-home]="c.location === 'Remote'" aria-hidden="true"></i> {{ c.location }}</span>
        </div>
      </div>
      <div class="tg__scroll" #scroll>
        <div class="tg__body" [style.height.px]="hourPx * 24" [style.--cols]="columns.length">
          <div class="tg__gutter" aria-hidden="true">
            <span class="tg__hour" *ngFor="let h of hours" [style.top.px]="h * hourPx">{{ hourLabel(h) }}</span>
          </div>
          <div class="tg__col" *ngFor="let c of columns; trackBy: trackByKey" [class.tg__col--today]="c.isToday"
               (pointerdown)="startSelect($event, c)" role="gridcell" [attr.aria-label]="c.date | date: 'fullDate'">
            <div class="tg__off" *ngFor="let o of c.off" [style.top.px]="o.top" [style.height.px]="o.height"></div>
            <div class="tg__sel" *ngIf="selectionFor(c) as s" [style.top.px]="s.top" [style.height.px]="s.height"></div>
            <div class="tg__draft" *ngIf="c.draft as d" [style.top.px]="d.top" [style.height.px]="d.height">
              <span>{{ draftLabel }}</span>
              <span class="tg__draft-handle" (pointerdown)="startResize($event, c)" title="Drag to change the end time"></span>
            </div>
            <button type="button" class="tg__event" *ngFor="let e of c.events; trackBy: trackByEvent"
                    [class.tg__event--live]="!!e.item.activeCallId"
                    [style.top.px]="e.top" [style.height.px]="e.height" [style.left.%]="e.left" [style.width.%]="e.width"
                    (pointerdown)="$event.stopPropagation()" (click)="eventClick.emit(e.item)">
              <span class="tg__event-title">{{ e.item.title }}</span>
              <span class="tg__event-time" *ngIf="e.height >= 34">{{ e.item.occurrenceStart | date: 'shortTime' }} – {{ e.item.occurrenceEnd | date: 'shortTime' }}</span>
            </button>
            <span class="tg__now" *ngIf="c.isToday" [style.top.px]="nowTop"></span>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class TimeGridComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  @Input() days: Date[] = [];
  @Input() items: MeetingOccurrence[] = [];
  /** Highlighted proposed range (meeting editor) */
  @Input() draft: GridRange | null = null;
  @Input() draftLabel = '';
  @Input() compact = false;
  /** Minutes from midnight to scroll to when the grid is first shown (default: start of work) */
  @Input() scrollToMinutes: number | null = null;
  @Output() rangeSelect = new EventEmitter<GridRange>();
  @Output() draftChange = new EventEmitter<GridRange>();
  @Output() eventClick = new EventEmitter<MeetingOccurrence>();

  @ViewChild('scroll') scroll?: ElementRef<HTMLElement>;

  settings!: CalendarSettings;
  columns: Column[] = [];
  hours = Array.from({ length: 24 }, (_, i) => i);
  slotPx = 16;
  hourPx = 192;
  nowTop = 0;
  private sel: { col: Column; from: number; to: number } | null = null;
  private resizing: Column | null = null;
  private subs = new Subscription();
  private timer?: ReturnType<typeof setInterval>;
  private scrolled = false;

  constructor(private store: CalendarSettingsService, private cdr: ChangeDetectorRef) {
    this.apply(store.value);
  }

  ngOnInit(): void {
    this.subs.add(this.store.settings$.subscribe((s) => {
      // keep the same time of day in view when the scale changes
      const el = this.scroll?.nativeElement;
      const minute = el ? (el.scrollTop / this.hourPx) * 60 : null;
      this.apply(s);
      this.rebuild();
      if (el && minute !== null) {
        setTimeout(() => (el.scrollTop = (minute / 60) * this.hourPx));
      }
    }));
    this.timer = setInterval(() => {
      this.updateNow();
      this.cdr.markForCheck();
    }, 60000);
  }

  ngOnChanges(_: SimpleChanges): void {
    this.rebuild();
  }

  ngAfterViewInit(): void {
    this.scrollInitial();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- layout

  private apply(s: CalendarSettings): void {
    this.settings = s;
    this.slotPx = SLOT_PX[s.timeScale] || 16;
    this.hourPx = (60 / s.timeScale) * this.slotPx;
  }

  private scrollInitial(): void {
    if (this.scrolled || !this.scroll || !this.columns.length) {
      return;
    }
    this.scrolled = true;
    const first = this.settings.workPeriods[0]?.start ?? 8 * 60;
    const target = this.scrollToMinutes ?? Math.max(0, first - 30);
    setTimeout(() => {
      if (this.scroll) this.scroll.nativeElement.scrollTop = (target / 60) * this.hourPx;
    });
  }

  private updateNow(): void {
    const n = new Date();
    this.nowTop = ((n.getHours() * 60 + n.getMinutes()) / 60) * this.hourPx;
  }

  private rebuild(): void {
    this.updateNow();
    const today = dayKey(new Date());
    const px = this.hourPx / 60;
    this.columns = this.days.map((date) => {
      const day = startOfDay(date);
      const dayStart = day.getTime();
      const dayEnd = dayStart + DAY_MIN * 60000;
      const events = this.layout(this.items.filter((i) => {
        const s = new Date(i.occurrenceStart).getTime();
        const e = new Date(i.occurrenceEnd).getTime();
        return s < dayEnd && e > dayStart;
      }), dayStart, dayEnd, px);
      const working = this.settings.workDays.includes(day.getDay());
      let draft: Column['draft'] = null;
      if (this.draft) {
        const s = Math.max(this.draft.start.getTime(), dayStart);
        const e = Math.min(this.draft.end.getTime(), dayEnd);
        if (e > s) {
          draft = { top: ((s - dayStart) / 60000) * px, height: Math.max(((e - s) / 60000) * px, this.slotPx) };
        }
      }
      return {
        date: day,
        key: dayKey(day),
        isToday: dayKey(day) === today,
        events,
        off: this.offBlocks(working, px),
        location: working && this.settings.workPeriods.length ? this.locationLabel() : '',
        draft,
      };
    });
    this.scrollInitial();
    this.cdr.markForCheck();
  }

  private locationLabel(): string {
    const locs = new Set(this.settings.workPeriods.map((p) => p.location));
    return locs.size === 1 ? (locs.has('office') ? 'Office' : 'Remote') : 'Office / Remote';
  }

  /** Greys out time outside the working hours (and whole non-working days). */
  private offBlocks(working: boolean, px: number): OffBlock[] {
    if (!working) {
      return [{ top: 0, height: DAY_MIN * px }];
    }
    const blocks: OffBlock[] = [];
    let cursor = 0;
    for (const p of this.settings.workPeriods) {
      if (p.start > cursor) blocks.push({ top: cursor * px, height: (p.start - cursor) * px });
      cursor = Math.max(cursor, p.end);
    }
    if (cursor < DAY_MIN) blocks.push({ top: cursor * px, height: (DAY_MIN - cursor) * px });
    return blocks;
  }

  /** Side-by-side columns for overlapping events. */
  private layout(list: MeetingOccurrence[], dayStart: number, dayEnd: number, px: number): PlacedEvent[] {
    const rows = list
      .map((item) => {
        const s = Math.max(new Date(item.occurrenceStart).getTime(), dayStart);
        const e = Math.min(new Date(item.occurrenceEnd).getTime(), dayEnd);
        const startMin = (s - dayStart) / 60000;
        const endMin = Math.max((e - dayStart) / 60000, startMin + 15);
        return { item, startMin, endMin, lane: 0, lanes: 1 };
      })
      .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    let group: typeof rows = [];
    let groupEnd = -1;
    const flush = () => {
      const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
      group.forEach((g) => (g.lanes = lanes));
      group = [];
    };
    for (const r of rows) {
      if (group.length && r.startMin >= groupEnd) {
        flush();
        groupEnd = -1;
      }
      const used = new Set(group.filter((g) => g.endMin > r.startMin).map((g) => g.lane));
      while (used.has(r.lane)) r.lane++;
      group.push(r);
      groupEnd = Math.max(groupEnd, r.endMin);
    }
    flush();
    return rows.map((r) => ({
      item: r.item,
      top: r.startMin * px,
      height: (r.endMin - r.startMin) * px - 1,
      left: (r.lane / r.lanes) * 100,
      width: 100 / r.lanes - 1,
    }));
  }

  // ---------------------------------------------------------------- selection

  selectionFor(c: Column): { top: number; height: number } | null {
    if (!this.sel || this.sel.col !== c) {
      return null;
    }
    const s = this.settings.timeScale;
    const lo = Math.min(this.sel.from, this.sel.to);
    const hi = Math.max(this.sel.from, this.sel.to) + s;
    const px = this.hourPx / 60;
    return { top: lo * px, height: (hi - lo) * px };
  }

  private minuteAt(event: PointerEvent, col: Column): number {
    const el = (event.target as HTMLElement).closest('.tg__col') as HTMLElement | null
      || this.scroll?.nativeElement.querySelector('.tg__col') as HTMLElement | null;
    const rect = (this.colElement(col) || el)!.getBoundingClientRect();
    const raw = ((event.clientY - rect.top) / this.hourPx) * 60;
    const s = this.settings.timeScale;
    return Math.min(DAY_MIN - s, Math.max(0, Math.floor(raw / s) * s));
  }

  private colElement(col: Column): HTMLElement | null {
    const idx = this.columns.indexOf(col);
    const cols = this.scroll?.nativeElement.querySelectorAll('.tg__col');
    return (cols?.[idx] as HTMLElement) || null;
  }

  startSelect(event: PointerEvent, col: Column): void {
    if (event.button !== 0) return;
    const m = this.minuteAt(event, col);
    this.sel = { col, from: m, to: m };
    this.cdr.markForCheck();
  }

  startResize(event: PointerEvent, col: Column): void {
    event.stopPropagation();
    event.preventDefault();
    this.resizing = col;
  }

  @HostListener('document:pointermove', ['$event'])
  onMove(event: PointerEvent): void {
    if (this.sel) {
      this.sel = { ...this.sel, to: this.minuteAt(event, this.sel.col) };
      this.cdr.markForCheck();
    } else if (this.resizing && this.draft) {
      const dayStart = this.resizing.date.getTime();
      const s = this.settings.timeScale;
      const end = new Date(dayStart + (this.minuteAt(event, this.resizing) + s) * 60000);
      if (end.getTime() > this.draft.start.getTime()) {
        this.draftChange.emit({ start: this.draft.start, end });
      }
    }
  }

  @HostListener('document:pointerup')
  onUp(): void {
    if (this.resizing) {
      this.resizing = null;
      return;
    }
    if (!this.sel) return;
    const { col, from, to } = this.sel;
    this.sel = null;
    const s = this.settings.timeScale;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to) + s;
    const base = col.date.getTime();
    // a plain click proposes a 30 minute block (one slot when slots are longer)
    const length = from === to ? Math.max(30, s) : hi - lo;
    this.rangeSelect.emit({ start: new Date(base + lo * 60000), end: new Date(base + (lo + length) * 60000) });
    this.cdr.markForCheck();
  }

  // ---------------------------------------------------------------- template helpers

  hourLabel(h: number): string {
    return h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  }

  trackByKey(_: number, c: Column): string {
    return c.key;
  }

  trackByEvent(_: number, e: PlacedEvent): string {
    return `${e.item._id}:${e.item.occurrenceStart}`;
  }
}
