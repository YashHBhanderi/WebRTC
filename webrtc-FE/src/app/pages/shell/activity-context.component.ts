import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { ChatMessage } from 'src/app/core/interfaces/chat';
import { AuthService } from 'src/app/core/services/auth.service';
import { CallManagerService } from 'src/app/core/services/call-manager.service';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';
import { ActivityItem } from 'src/app/core/services/notification-center.service';
import { UserService } from 'src/app/core/services/user.service';

interface CallEntry {
  _id: string;
  conversationId: string;
  isGroup: boolean;
  isMeeting: boolean;
  title: string;
  avatar?: string;
  callType: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  outcome: string;
  duration: number;
  createdAt: string;
}

const HIGHLIGHT_MS = 5000;

/**
 * Detail pane of the Activity page (Teams-style): shows the activity's chat around the exact
 * message, or the exact call-history entry, inside Activity itself. It never touches the Chat
 * or Calls pages' own selection.
 */
@Component({
  selector: 'app-activity-context',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .ctx__head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--app-border); }
    .ctx__head h2 { font-size: 1rem; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctx__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; }
    .ctx__older { display: flex; justify-content: center; padding: 8px; }
    .ctx__day { text-align: center; font-size: 0.75rem; color: var(--app-muted); margin: 12px 0 6px; }
    .ctx__msg { border-radius: 8px; }
    .ctx__call { display: flex; align-items: center; gap: 12px; padding: 16px; margin: 16px; border: 1px solid var(--app-border); border-radius: 10px; background: var(--app-surface); transition: box-shadow .2s, background .2s; }
    .ctx__call--flash { background: var(--app-brand-soft, rgba(44, 58, 71, .18)); box-shadow: 0 0 0 2px var(--app-brand); }
    .ctx__call-body { flex: 1; min-width: 0; }
    .ctx__call-title { font-weight: 600; }
    .ctx__call-sub { color: var(--app-muted); font-size: 0.85rem; }
    .ctx__call-actions { display: flex; gap: 6px; }
    .ctx__call-actions button { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--app-icon); }
    .ctx__call-actions button:hover { background: var(--app-hover); color: var(--app-text); }
    .ctx__state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; flex: 1; padding: 24px; text-align: center; color: var(--app-muted); }
  `],
  template: `
    <ng-container *ngIf="item">
      <header class="ctx__head">
        <h2>{{ heading }}</h2>
        <button type="button" class="btn btn-sm btn-light" (click)="openInApp()">{{ item.callId && !item.messageId ? 'Open in Calls' : 'Open in Chat' }}</button>
      </header>

      <!-- Message context -->
      <div class="ctx__scroll" #scroller *ngIf="mode === 'message'">
        <div class="ctx__state" *ngIf="loading && !messages.length" role="status">Loading messages…</div>
        <div class="ctx__state" *ngIf="error" role="alert">
          <strong>That message is no longer available.</strong>
        </div>
        <div class="ctx__older" *ngIf="hasMore && messages.length">
          <button type="button" class="btn btn-sm btn-light" (click)="loadOlder()" [disabled]="loadingOlder">{{ loadingOlder ? 'Loading…' : 'Load older messages' }}</button>
        </div>
        <ng-container *ngFor="let msg of messages; let i = index; trackBy: trackByMessage">
          <div class="ctx__day" *ngIf="isNewDay(i)">{{ msg.createdAt | date: 'fullDate' }}</div>
          <div class="ctx__msg" *ngIf="msg.type !== 'system' && (msg.type !== 'call' || msg.call)" [id]="'actctx-' + msg._id">
            <app-message-item
              [message]="msg"
              [mine]="isMine(msg)"
              [isGroup]="true"
              [first]="isFirstOfRun(i)"
              [senderName]="isMine(msg) ? 'You' : senderName(msg)"
              [senderAvatar]="msg.user?.avatar"
              [replyAuthor]="replyAuthor(msg.replyTo)"
              [showTicks]="false"
              [highlighted]="highlightId === msg._id"
              [myUserId]="myUserId"
              [mentionNames]="[]"
            ></app-message-item>
          </div>
        </ng-container>
      </div>

      <!-- Call context -->
      <div class="ctx__scroll" *ngIf="mode === 'call'">
        <div class="ctx__state" *ngIf="loading && !call" role="status">Loading call…</div>
        <div class="ctx__state" *ngIf="error" role="alert"><strong>That call is no longer in your history.</strong></div>
        <div class="ctx__call" *ngIf="call as c" [class.ctx__call--flash]="flash" id="actctx-call">
          <app-avatar [src]="c.avatar" [name]="c.title" [size]="48"></app-avatar>
          <div class="ctx__call-body">
            <div class="ctx__call-title" [class.text-danger]="c.outcome === 'missed'">{{ c.title }}</div>
            <div class="ctx__call-sub">
              <i class="ti" [class.ti-arrow-down]="c.direction === 'incoming'" [class.ti-arrow-up]="c.direction === 'outgoing'" aria-hidden="true"></i>
              {{ c.isMeeting ? 'Meeting' : c.direction === 'incoming' ? 'Incoming' : 'Outgoing' }} · {{ c.callType === 'video' ? 'Video' : 'Audio' }}
              <ng-container *ngIf="outcomeLabel(c)"> · {{ outcomeLabel(c) }}</ng-container>
              <ng-container *ngIf="c.outcome === 'answered'"> · {{ duration(c.duration) }}</ng-container>
              · {{ c.createdAt | date: 'MMM d, h:mm a' }}
            </div>
          </div>
          <div class="ctx__call-actions">
            <button type="button" (click)="callBack(c, 'audio')" title="Audio call" [attr.aria-label]="'Audio call ' + c.title"><i class="ti ti-phone"></i></button>
            <button type="button" (click)="callBack(c, 'video')" title="Video call" [attr.aria-label]="'Video call ' + c.title"><i class="ti ti-video"></i></button>
          </div>
        </div>
      </div>
    </ng-container>
  `,
})
export class ActivityContextComponent implements OnChanges, OnDestroy {
  @Input() item: ActivityItem | null = null;
  @ViewChild('scroller') scroller?: ElementRef<HTMLElement>;

  mode: 'message' | 'call' | 'none' = 'none';
  messages: ChatMessage[] = [];
  call: CallEntry | null = null;
  highlightId: string | null = null;
  flash = false;
  loading = false;
  loadingOlder = false;
  hasMore = false;
  error = false;
  readonly myUserId: string = this.auth.getLoggedInUser()?._id;

  private pageSize = 20;
  private seq = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private users: UserService,
    private actions: ChatActionsService,
    private calls: CallManagerService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  get heading(): string {
    if (!this.item) return '';
    return this.mode === 'call' ? (this.call?.title || 'Call') : (this.item.actor?.username || 'Chat');
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['item']) {
      void this.open();
    }
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearTimeout);
  }

  private async open(): Promise<void> {
    const item = this.item;
    const seq = ++this.seq;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.messages = [];
    this.call = null;
    this.highlightId = null;
    this.flash = false;
    this.error = false;
    this.hasMore = false;
    if (!item) {
      this.mode = 'none';
      return;
    }
    this.mode = item.type === 'missed-call' ? 'call' : 'message';
    this.loading = true;
    this.cdr.markForCheck();
    try {
      if (this.mode === 'call') {
        await this.loadCall(item, seq);
      } else {
        await this.loadMessages(item, seq);
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

  // ---------------------------------------------------------------- messages

  private async loadMessages(item: ActivityItem, seq: number): Promise<void> {
    if (!item.conversationId) {
      throw new Error('no conversation');
    }
    let limit = this.pageSize;
    if (item.messageId) {
      // Load back exactly far enough to include the message
      const newer = await this.actions.position(item.conversationId, item.messageId);
      limit = Math.ceil((newer + 1 + 5) / this.pageSize) * this.pageSize;
    }
    const res = await firstValueFrom(this.users.getMessages(item.conversationId, 1, limit));
    if (seq !== this.seq) return;
    const data: ChatMessage[] = res.data || [];
    this.messages = data;
    this.hasMore = data.length === limit;
    this.cdr.detectChanges();
    if (item.messageId && data.some((m) => m._id === item.messageId)) {
      this.reveal(item.messageId);
    } else if (item.messageId) {
      this.error = true;
    } else {
      this.scrollTo(null);
    }
  }

  async loadOlder(): Promise<void> {
    const item = this.item;
    if (!item?.conversationId || this.loadingOlder) return;
    const seq = this.seq;
    this.loadingOlder = true;
    this.cdr.markForCheck();
    try {
      const next = Math.floor(this.messages.length / this.pageSize) + 1;
      const res = await firstValueFrom(this.users.getMessages(item.conversationId, next, this.pageSize));
      if (seq !== this.seq) return;
      const data: ChatMessage[] = res.data || [];
      const known = new Set(this.messages.map((m) => m._id));
      this.messages = [...data.filter((m) => !known.has(m._id)), ...this.messages];
      this.hasMore = data.length === this.pageSize;
    } finally {
      this.loadingOlder = false;
      this.cdr.markForCheck();
    }
  }

  private reveal(messageId: string): void {
    this.highlightId = messageId;
    this.cdr.markForCheck();
    this.timers.push(setTimeout(() => this.scrollTo(messageId), 60));
    this.timers.push(setTimeout(() => {
      this.highlightId = null;
      this.cdr.markForCheck();
    }, HIGHLIGHT_MS));
  }

  private scrollTo(messageId: string | null): void {
    const el = messageId ? document.getElementById('actctx-' + messageId) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (this.scroller) {
      this.scroller.nativeElement.scrollTop = this.scroller.nativeElement.scrollHeight;
    }
  }

  isMine(msg: ChatMessage): boolean {
    return String(msg.user?._id || msg.userId) === String(this.myUserId);
  }

  senderName(msg: ChatMessage): string {
    return msg.senderName || msg.user?.username || 'Unknown';
  }

  replyAuthor(reply: any): string {
    if (!reply) return '';
    if (String(reply.userId) === String(this.myUserId)) return 'You';
    const known = this.messages.find((m) => String(m.user?._id || m.userId) === String(reply.userId));
    return known?.user?.username || this.item?.actor?.username || 'Reply';
  }

  isFirstOfRun(i: number): boolean {
    const prev = this.messages[i - 1];
    const cur = this.messages[i];
    return !prev || this.isNewDay(i) || String(prev.user?._id || prev.userId) !== String(cur.user?._id || cur.userId);
  }

  isNewDay(i: number): boolean {
    if (i === 0) return true;
    return new Date(this.messages[i - 1].createdAt).toDateString() !== new Date(this.messages[i].createdAt).toDateString();
  }

  trackByMessage(_: number, m: ChatMessage): string {
    return m._id;
  }

  // ---------------------------------------------------------------- call

  private async loadCall(item: ActivityItem, seq: number): Promise<void> {
    if (!item.callId) {
      throw new Error('no call');
    }
    let before: string | null = null;
    // The call may be older than the first page: page back a few times at most
    for (let pages = 0; pages < 6; pages++) {
      let params = new HttpParams();
      if (before) params = params.set('before', before);
      const res = await firstValueFrom(this.http.get<{ data: { items: CallEntry[]; nextCursor: string | null } }>(`${environment.apiUrl}/calls`, {
        params,
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
      if (seq !== this.seq) return;
      const found = res.data.items.find((c) => c._id === item.callId);
      if (found) {
        this.call = found;
        this.flash = true;
        this.cdr.markForCheck();
        this.timers.push(setTimeout(() => document.getElementById('actctx-call')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50));
        this.timers.push(setTimeout(() => {
          this.flash = false;
          this.cdr.markForCheck();
        }, HIGHLIGHT_MS));
        return;
      }
      before = res.data.nextCursor;
      if (!before) break;
    }
    this.error = true;
  }

  outcomeLabel(c: CallEntry): string {
    const labels: Record<string, string> = { missed: 'Missed', declined: 'Declined', cancelled: 'Cancelled', 'no-answer': 'No answer', failed: 'Failed', ongoing: 'In progress' };
    return labels[c.outcome] || '';
  }

  duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  }

  callBack(c: CallEntry, type: 'audio' | 'video'): void {
    this.calls.startCall(c.conversationId, type, c.isGroup ? 'meetNow' : 'ring');
  }

  /** Explicit jump to the real Chat / Calls page (never done automatically). */
  openInApp(): void {
    const item = this.item;
    if (!item) return;
    if (this.mode === 'call') {
      void this.router.navigate(['/calls'], { queryParams: { call: item.callId } });
    } else {
      void this.router.navigate(['/chat'], { queryParams: { c: item.conversationId, m: item.messageId || null } });
    }
  }
}
