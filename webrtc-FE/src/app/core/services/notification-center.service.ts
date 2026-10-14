import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, NgZone } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { BehaviorSubject, Subject, Subscription, filter, firstValueFrom, map } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { AuthService } from './auth.service';
import { CallManagerService } from './call-manager.service';
import { SocketService } from './socket.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

export type ActivityType = 'mention' | 'reply' | 'reaction' | 'missed-call' | 'meeting-invite' | 'meeting-reminder' | 'recording';

export interface ActivityItem {
  _id: string;
  type: ActivityType;
  actor: { _id: string; username: string; avatar?: string } | null;
  conversationId?: string | null;
  messageId?: string | null;
  callId?: string | null;
  meetingId?: string | null;
  recordingId?: string | null;
  text: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationPrefs {
  /** System notifications while the tab isn't in front */
  desktop: boolean;
  sound: boolean;
  messages: boolean;
  mentions: boolean;
  replies: boolean;
  reactions: boolean;
  missedCalls: boolean;
  meetings: boolean;
}

const PREFS_KEY = 'app.notificationPrefs';
const DEFAULT_PREFS: NotificationPrefs = {
  desktop: true,
  sound: true,
  messages: true,
  mentions: true,
  replies: true,
  reactions: false,
  missedCalls: true,
  meetings: true,
};
const TYPE_PREF: Record<ActivityType, keyof NotificationPrefs> = {
  mention: 'mentions',
  reply: 'replies',
  reaction: 'reactions',
  'missed-call': 'missedCalls',
  'meeting-invite': 'meetings',
  'meeting-reminder': 'meetings',
  recording: 'meetings',
};
/** Presence values that silence alerts (badges still update). */
const QUIET_STATUSES = ['Do not disturb', 'DND'];

/**
 * Activity feed + alerts. Alerts (system notification, sound) respect the user's preferences,
 * Do not disturb, the chat currently in view and an ongoing call — the badge always updates.
 */
@Injectable({ providedIn: 'root' })
export class NotificationCenterService {
  readonly unread$ = new BehaviorSubject<number>(0);
  /** Live entries pushed while the app is open (the Activity page prepends them). */
  readonly incoming$ = new Subject<ActivityItem>();
  readonly prefs$ = new BehaviorSubject<NotificationPrefs>(this.readPrefs());

  /** Chat currently on screen (set by the chat page). */
  activeConversationId: string | null = null;

  private subs = new Subscription();
  private started = false;
  private alertedMessages = new Set<string>();
  private toastedRecordings = new Set<string>();
  private pendingDelivered = new Set<string>();
  private deliveredTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chats with unread messages (navigation badge); the chat page reports exact numbers. */
  readonly unreadChats$ = new BehaviorSubject<number>(0);
  private unreadChatIds = new Set<string>();
  private audio: AudioContext | null = null;
  private onChatPage = false;

  constructor(
    private http: HttpClient,
    private socket: SocketService,
    private auth: AuthService,
    private calls: CallManagerService,
    private router: Router,
    private zone: NgZone,
    private toast: AlertService,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.refreshUnread();

    this.onChatPage = this.router.url.startsWith('/chat');
    this.subs.add(this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      this.onChatPage = (e as NavigationEnd).urlAfterRedirects.startsWith('/chat');
    }));

    this.subs.add(this.socket.onNotificationNew().subscribe((item: ActivityItem) => {
      this.unread$.next(this.unread$.value + 1);
      this.incoming$.next(item);
      if (this.prefs[TYPE_PREF[item.type]]) {
        this.alert(this.titleFor(item), this.bodyFor(item), this.linkFor(item), `act-${item._id}`, item.conversationId);
      }
    }));
    this.subs.add(this.socket.onNotificationRead().subscribe((data) => this.unread$.next(Math.max(0, data?.unread || 0))));
    // Reconnected: we may have missed pushes
    this.subs.add(this.socket.onConnect().subscribe(() => void this.refreshUnread()));

    // New chat messages are not stored as Activity (the chat list shows them) but can still alert
    this.subs.add(this.socket.newMessageReceived().subscribe((m: any) => this.onMessage(m)));
    void this.loadUnreadChats();

    // Whoever started a recording hears about a failure (friendly text only, details stay in the server log)
    this.subs.add(this.socket.onRecordingUpdated().subscribe((e) => {
      const me = this.auth.getLoggedInUser()?._id;
      if (!me || e.startedBy !== String(me)) {
        return;
      }
      const key = `${e.recordingId}:${e.status}:${e.transcriptStatus}`;
      if (this.toastedRecordings.has(key)) {
        return;
      }
      this.toastedRecordings.add(key);
      const title = e.title ? `“${e.title}”` : 'your meeting';
      this.zone.run(() => {
        if (e.status === 'failed') {
          this.toast.error(`We couldn't process the recording of ${title}. Please try recording again.`);
        } else if (e.status === 'completed' && e.transcriptStatus === 'failed') {
          this.toast.warning(`The recording of ${title} is ready, but its transcript couldn't be created. You can retry from the recording page.`);
        }
      });
    }));
  }

  /** The chat page knows the exact unread chats; it reports them whenever its lists change. */
  setUnreadChats(ids: string[]): void {
    this.unreadChatIds = new Set(ids.map(String));
    this.unreadChats$.next(this.unreadChatIds.size);
  }

  private async loadUnreadChats(): Promise<void> {
    try {
      const opts = { context: new HttpContext().set(SKIP_ERROR_TOAST, true) };
      const [direct, groups] = await Promise.all([
        firstValueFrom(this.http.get<{ data: any[] }>(`${environment.apiUrl}/conversations`, opts)),
        firstValueFrom(this.http.get<{ data: any[] }>(`${environment.apiUrl}/groupConversations`, opts)),
      ]);
      const ids = [...(direct.data || []), ...(groups.data || [])].filter((c) => c.unreadCount > 0).map((c) => String(c._id));
      // The chat page may already have reported; keep the union
      ids.forEach((id) => this.unreadChatIds.add(id));
      this.unreadChats$.next(this.unreadChatIds.size);
    } catch {
      // badge stays as is
    }
  }

  private queueDelivered(conversationId: string): void {
    this.pendingDelivered.add(conversationId);
    if (this.deliveredTimer) {
      return;
    }
    this.deliveredTimer = setTimeout(() => {
      this.deliveredTimer = null;
      const ids = [...this.pendingDelivered];
      this.pendingDelivered.clear();
      this.socket.markDelivered(ids);
    }, 1000);
  }

  stop(): void {
    this.subs.unsubscribe();
    this.subs = new Subscription();
    this.started = false;
    this.unread$.next(0);
    this.unreadChats$.next(0);
    this.unreadChatIds.clear();
    this.alertedMessages.clear();
    this.activeConversationId = null;
  }

  // ---------------------------------------------------------------- feed

  list(before?: string | null, view: 'all' | 'unread' | 'mentions' = 'all'): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
    let params = new HttpParams();
    if (before) {
      params = params.set('before', before);
    }
    if (view !== 'all') {
      params = params.set('view', view);
    }
    return firstValueFrom(this.http
      .get<{ data: { items: ActivityItem[]; nextCursor: string | null } }>(`${environment.apiUrl}/notifications`, {
        params,
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      })
      .pipe(map((r) => r.data)));
  }

  async markRead(ids?: string[]): Promise<void> {
    if (ids && !ids.length) {
      return;
    }
    await firstValueFrom(this.http.post(`${environment.apiUrl}/notifications/read`, ids ? { ids } : {}));
  }

  async refreshUnread(): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.get<{ data: { unread: number } }>(`${environment.apiUrl}/notifications/unread-count`, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
      this.unread$.next(res.data.unread || 0);
    } catch {
      // badge stays as is
    }
  }

  linkFor(item: { type: ActivityType; conversationId?: string | null; messageId?: string | null; meetingId?: string | null; recordingId?: string | null }): string {
    if (item.type === 'recording' && item.recordingId) {
      return `/recordings/${item.recordingId}`;
    }
    // Calls live in Call History (never as chat messages)
    if (item.type === 'missed-call') {
      return (item as any).callId ? `/calls?call=${(item as any).callId}` : '/calls';
    }
    if ((item.type === 'meeting-invite' || item.type === 'meeting-reminder') && item.meetingId) {
      return `/calendar?meeting=${item.meetingId}`;
    }
    if (item.conversationId && item.messageId) {
      return `/chat?c=${item.conversationId}&m=${item.messageId}`;
    }
    if (item.conversationId) {
      return `/chat?c=${item.conversationId}`;
    }
    return '/activity';
  }

  titleFor(item: ActivityItem): string {
    const who = item.actor?.username || 'Someone';
    switch (item.type) {
      case 'mention': return `${who} mentioned you`;
      case 'reply': return `${who} replied to your message`;
      case 'reaction': return `${who} reacted ${item.text} to your message`;
      case 'missed-call': return `Missed call from ${who}`;
      case 'meeting-invite': return item.text.startsWith('Cancelled:') ? `${who} cancelled a meeting` : `${who} invited you to a meeting`;
      case 'meeting-reminder': return 'Meeting starting soon';
      case 'recording': return item.text;
      default: return 'New activity';
    }
  }

  bodyFor(item: ActivityItem): string {
    return item.type === 'reaction' || item.type === 'recording' ? '' : item.text;
  }

  // ---------------------------------------------------------------- preferences

  get prefs(): NotificationPrefs {
    return this.prefs$.value;
  }

  setPrefs(changes: Partial<NotificationPrefs>): void {
    const next = { ...this.prefs, ...changes };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // applies for this session only
    }
    this.prefs$.next(next);
  }

  // ---------------------------------------------------------------- alerts

  private onMessage(m: any): void {
    const id = String(m?._id || '');
    const me = this.auth.getLoggedInUser()?._id;
    const senderId = String(m?.user?._id || m?.userId?._id || m?.userId || '');
    if (!id || !me || senderId === String(me) || m.type === 'system') {
      return;
    }
    if (m.type === 'call' || !this.prefs.messages) {
      this.queueDelivered(String(m.conversationId || ''));
      return;
    }
    // Delivered twice (conversation room + personal socket)
    if (this.alertedMessages.has(id)) {
      return;
    }
    this.alertedMessages.add(id);
    if (this.alertedMessages.size > 500) {
      this.alertedMessages = new Set([...this.alertedMessages].slice(-200));
    }
    this.queueDelivered(String(m.conversationId || ''));
    const viewing = this.onChatPage && this.activeConversationId === String(m.conversationId);
    if (!viewing && !this.unreadChatIds.has(String(m.conversationId))) {
      this.unreadChatIds.add(String(m.conversationId));
      this.unreadChats$.next(this.unreadChatIds.size);
    }
    const sender = m?.user?.username || 'New message';
    const body = m.type === 'text' ? m.content : `Sent ${m.type === 'pdf' ? 'a document' : `a ${m.type}`}`;
    const conversationId = String(m.conversationId || '');
    this.alert(sender, body, `/chat?c=${conversationId}&m=${id}`, `msg-${conversationId}`, conversationId);
  }

  private alert(title: string, body: string, link: string, tag: string, conversationId?: string | null): void {
    if (this.isQuiet()) {
      return;
    }
    const visible = document.visibilityState === 'visible' && document.hasFocus();
    // Already looking at this chat
    if (visible && conversationId && this.onChatPage && this.activeConversationId === String(conversationId)) {
      return;
    }
    if (this.prefs.sound && !this.calls.activeCall) {
      this.chime();
    }
    if (!visible && this.prefs.desktop) {
      void this.systemNotification(title, body, link, tag);
    }
  }

  private isQuiet(): boolean {
    const status = this.auth.getLoggedInUser()?.status;
    return !!status && QUIET_STATUSES.includes(status);
  }

  private async systemNotification(title: string, body: string, link: string, tag: string): Promise<void> {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    const options: NotificationOptions & Record<string, unknown> = {
      body: (body || '').slice(0, 160),
      tag,
      renotify: true,
      icon: 'assets/icon.svg',
      // Angular service worker: open the app at the right place on click
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: link } } },
    };
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.showNotification(title, options);
        return;
      }
    } catch {
      // fall through to the page-level API
    }
    try {
      const n = new Notification(title, options);
      n.onclick = () => this.zone.run(() => {
        window.focus();
        n.close();
        void this.router.navigateByUrl(link);
      });
    } catch {
      // unsupported (e.g. Android without a service worker)
    }
  }

  /** Short two-note chime (generated, no audio file to download). */
  private chime(): void {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) {
        return;
      }
      this.audio = this.audio || new Ctx();
      const ctx = this.audio!;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      const start = ctx.currentTime + 0.01;
      [[880, 0], [1320, 0.11]].forEach(([freq, offset]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, start + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + offset);
        osc.stop(start + offset + 0.25);
      });
    } catch {
      // autoplay policy before the first user gesture: silently skip
    }
  }

  private readPrefs(): NotificationPrefs {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }
}
