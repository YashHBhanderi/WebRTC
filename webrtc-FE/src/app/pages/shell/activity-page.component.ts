import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ActivityItem, ActivityType, NotificationCenterService } from 'src/app/core/services/notification-center.service';

type ActivityView = 'all' | 'unread' | 'mentions';

const ICON: Record<ActivityType, string> = {
  mention: 'fa-at',
  reply: 'fa-reply',
  reaction: 'fa-face-smile',
  'missed-call': 'fa-phone-slash',
  'meeting-invite': 'fa-calendar-plus',
  'meeting-reminder': 'fa-clock',
  recording: 'fa-circle-play',
};

/**
 * Activity (Teams-style): the feed on the left, filtered All / Unread / @Mentions, styled like the
 * chat list. Picking an entry opens where it happened — the exact chat message (loaded and
 * highlighted), the call in Call History, the meeting or the recording.
 */
@Component({
  selector: 'app-activity-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shared/list-pane.scss'],
  styles: [`
    .act-markall { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--app-icon); }
    .act-markall:hover:not(:disabled) { background: var(--app-hover); color: var(--app-text); }
    .act-markall:disabled { opacity: 0.4; }
    .act-avatar { position: relative; flex: none; }
    .act-badge {
      position: absolute; right: -4px; bottom: -4px; width: 20px; height: 20px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center; font-size: 0.6rem; color: #fff;
      background: var(--app-brand); border: 2px solid var(--app-surface);
    }
    .act-badge--missed-call { background: var(--app-danger); }
    .act-badge--reaction { background: var(--app-warning); }
    .act-title { font-weight: 400; }
    .conv--unread .act-title { font-weight: 700; }
    .act-context { font-size: 0.75rem; color: var(--app-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .act-context i { font-size: 0.65rem; margin-right: 2px; }
    .act-detail { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .act-back { display: none; margin: 8px 12px 0; align-self: flex-start; }
    @media (max-width: 767.98px) {
      .act-hide { display: none; }
      .pane-main--optional.act-show { display: flex; flex-direction: column; }
      .act-show .act-back { display: inline-flex; }
    }
    .act-more { display: flex; justify-content: center; padding: 12px; }
  `],
  template: `
    <div class="pane-layout">
      <aside class="pane-side" aria-label="Activity" [class.act-hide]="!!contextItem">
        <header class="pane-side__header">
          <h1>Activity</h1>
          <button type="button" class="act-markall" (click)="markAllRead()" [disabled]="!hasUnread" title="Mark all as read" aria-label="Mark all as read">
            <lucide-icon name="book-open-check" [size]="22" aria-hidden="true"></lucide-icon>
          </button>
        </header>

        <nav class="chips" aria-label="Filter activity">
          <button type="button" class="chip" *ngFor="let f of filters" [class.chip--active]="view === f.value" [attr.aria-pressed]="view === f.value" (click)="setView(f.value)">{{ f.label }}</button>
        </nav>

        <div class="pane-side__list">
          <ng-container *ngIf="loading && !items.length">
            <div class="row-skeleton" *ngFor="let i of [1, 2, 3, 4, 5, 6]" aria-hidden="true"></div>
            <span class="visually-hidden" role="status">Loading activity</span>
          </ng-container>

          <ul class="conv-list" *ngIf="items.length" aria-label="Activity">
            <li *ngFor="let item of items; trackBy: trackById">
              <button type="button" class="conv" [class.conv--active]="item._id === selectedId" [class.conv--unread]="!item.read"
                      [attr.aria-current]="item._id === selectedId ? 'true' : null" (click)="open(item)">
                <span class="act-avatar">
                  <app-avatar [src]="item.actor?.avatar" [name]="item.actor?.username || '?'" [size]="44"></app-avatar>
                  <span class="act-badge act-badge--{{ item.type }}" aria-hidden="true"><i class="fa-solid {{ icon(item.type) }}"></i></span>
                </span>
                <span class="conv__body">
                  <span class="conv__row">
                    <span class="conv__title act-title">{{ center.titleFor(item) }}</span>
                    <span class="conv__time">{{ when(item.createdAt) }}</span>
                  </span>
                  <span class="conv__row">
                    <span class="conv__preview">{{ center.bodyFor(item) || kindLabel(item.type) }}</span>
                    <span class="conv__badges"><span class="unread-dot" *ngIf="!item.read"><span class="visually-hidden">Unread</span></span></span>
                  </span>
                  <span class="conv__row">
                    <span class="act-context"><i class="fa-solid {{ icon(item.type) }}" aria-hidden="true"></i> {{ contextLabel(item) }}</span>
                  </span>
                </span>
              </button>
            </li>
          </ul>

          <div class="pane-state" *ngIf="!loading && !error && !items.length">
            <i class="fa-solid" [class.fa-bell]="view === 'all'" [class.fa-circle-check]="view === 'unread'" [class.fa-at]="view === 'mentions'" aria-hidden="true"></i>
            <strong>{{ view === 'unread' ? "You're all caught up" : view === 'mentions' ? 'No mentions yet' : 'No activity yet' }}</strong>
            <span *ngIf="view === 'all'">Mentions, replies, reactions and missed calls show up here.</span>
          </div>
          <div class="pane-state" *ngIf="error" role="alert">
            <strong>We couldn't load your activity.</strong>
            <button type="button" class="btn btn-sm btn-primary" (click)="load(true)">Try again</button>
          </div>
          <div class="act-more" *ngIf="nextCursor && !error">
            <button type="button" class="btn btn-sm btn-light" (click)="load()" [disabled]="loading">{{ loading ? 'Loading…' : 'Show older' }}</button>
          </div>
        </div>
      </aside>

      <section class="pane-main pane-main--optional" [class.act-show]="!!contextItem" aria-label="Activity details">
        <button type="button" class="btn btn-sm btn-light act-back" *ngIf="contextItem" (click)="contextItem = null; selectedId = null"><i class="fa-solid fa-arrow-left me-1"></i>Activity</button>
        <app-activity-context *ngIf="contextItem; else noneSelected" [item]="contextItem"></app-activity-context>
      </section>
      <ng-template #noneSelected>
        <div class="pane-state">
          <i class="fa-regular fa-bell" aria-hidden="true"></i>
          <strong>Select an activity</strong>
          <span>Open a mention, reply or reaction to see that message here, or a missed call to see it in context.</span>
        </div>
      </ng-template>
    </div>
  `,
})
export class ActivityPageComponent implements OnInit, OnDestroy {
  readonly filters: { value: ActivityView; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'unread', label: 'Unread' },
    { value: 'mentions', label: '@Mentions' },
  ];
  view: ActivityView = 'all';
  items: ActivityItem[] = [];
  nextCursor: string | null = null;
  selectedId: string | null = null;
  /** Shown in the detail pane inside Activity (messages and calls never navigate away) */
  contextItem: ActivityItem | null = null;
  loading = false;
  error = false;
  private seq = 0;
  private sub = new Subscription();

  constructor(
    public center: NotificationCenterService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  get hasUnread(): boolean {
    return this.center.unread$.value > 0 || this.items.some((i) => !i.read);
  }

  ngOnInit(): void {
    void this.load(true);
    // New activity arrives live (when it matches the current filter)
    this.sub.add(this.center.incoming$.subscribe((item) => {
      if (this.view === 'mentions' && item.type !== 'mention') {
        return;
      }
      if (!this.items.some((i) => i._id === item._id)) {
        this.items = [item, ...this.items];
        this.cdr.markForCheck();
      }
    }));
    this.sub.add(this.center.unread$.subscribe(() => this.cdr.markForCheck()));
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  setView(view: ActivityView): void {
    if (view !== this.view) {
      this.view = view;
      void this.load(true);
    }
  }

  async load(reset = false): Promise<void> {
    if (this.loading && !reset) {
      return;
    }
    const seq = ++this.seq;
    this.loading = true;
    this.error = false;
    if (reset) {
      this.items = [];
      this.nextCursor = null;
    }
    this.cdr.markForCheck();
    try {
      const res = await this.center.list(reset ? null : this.nextCursor, this.view);
      if (seq !== this.seq) return;
      this.items = reset ? res.items : [...this.items, ...res.items];
      this.nextCursor = res.nextCursor;
    } catch {
      if (seq === this.seq) this.error = true;
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  /** Mark read, then go where it happened (chat message / call history / meeting / recording). */
  open(item: ActivityItem): void {
    this.selectedId = item._id;
    if (!item.read) {
      item.read = true;
      this.items = [...this.items];
      this.center.unread$.next(Math.max(0, this.center.unread$.value - 1));
      void this.center.markRead([item._id]).catch(() => void this.center.refreshUnread());
    }
    this.cdr.markForCheck();
    if (item.type === 'missed-call' || (item.conversationId && item.type !== 'meeting-invite' && item.type !== 'meeting-reminder' && item.type !== 'recording')) {
      // Independent context: stay in Activity, leave Chat / Calls selection untouched
      this.contextItem = { ...item };
      return;
    }
    void this.router.navigateByUrl(this.center.linkFor(item));
  }

  async markAllRead(): Promise<void> {
    this.items = this.view === 'unread' ? [] : this.items.map((i) => ({ ...i, read: true }));
    this.center.unread$.next(0);
    this.cdr.markForCheck();
    try {
      await this.center.markRead();
    } catch {
      void this.center.refreshUnread();
    }
  }

  icon(type: ActivityType): string {
    return ICON[type] || 'fa-bell';
  }

  contextLabel(item: ActivityItem): string {
    switch (item.type) {
      case 'missed-call': return 'Call history';
      case 'meeting-invite':
      case 'meeting-reminder': return 'Calendar';
      case 'recording': return 'Recordings';
      default: return 'Chat';
    }
  }

  kindLabel(type: ActivityType): string {
    switch (type) {
      case 'missed-call': return 'Missed call';
      case 'reaction': return 'Reaction';
      case 'recording': return 'Recording';
      default: return '';
    }
  }

  when(value: string): string {
    const d = new Date(value);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  trackById(_: number, item: ActivityItem): string {
    return item._id;
  }
}
