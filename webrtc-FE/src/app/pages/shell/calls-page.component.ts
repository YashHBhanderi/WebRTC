import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { CallManagerService } from 'src/app/core/services/call-manager.service';
import { UserService } from 'src/app/core/services/user.service';
import { PresenceKey, presenceOf } from 'src/app/core/utils/presence.util';
import { AlertService } from 'src/app/_shared/alert/alert.service';

type Outcome = 'answered' | 'missed' | 'declined' | 'cancelled' | 'no-answer' | 'failed' | 'ongoing';
type HistoryFilter = 'all' | 'missed' | 'incoming' | 'outgoing';

interface CallEntry {
  _id: string;
  conversationId: string;
  isGroup: boolean;
  isMeeting: boolean;
  title: string;
  avatar?: string;
  callerName: string | null;
  participants?: { _id: string; username: string; avatar?: string; joined: boolean }[];
  callType: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  outcome: Outcome;
  duration: number;
  createdAt: string;
}

interface Person {
  _id: string;
  username: string;
  avatar?: string;
  presence: PresenceKey;
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  answered: '',
  missed: 'Missed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  'no-answer': 'No answer',
  failed: 'Failed',
  ongoing: 'In progress',
};

/**
 * Calls (Teams-style): pick people on the left and start an audio call with them; call history
 * (All / Missed / Incoming / Outgoing) in the main area, with call-back.
 */
@Component({
  selector: 'app-calls-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shared/list-pane.scss', './calls-page.component.scss'],
  templateUrl: './calls-page.component.html',
})
export class CallsPageComponent implements OnInit, OnDestroy {
  @ViewChild('peopleInput') peopleInput?: ElementRef<HTMLInputElement>;

  // ---- start a call
  people: Person[] = [];
  peopleLoaded = false;
  query = '';
  selected: Person[] = [];
  starting = false;

  // ---- history
  readonly filters: { value: HistoryFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'missed', label: 'Missed' },
    { value: 'incoming', label: 'Incoming' },
    { value: 'outgoing', label: 'Outgoing' },
  ];
  filter: HistoryFilter = 'all';
  items: CallEntry[] = [];
  nextCursor: string | null = null;
  loading = false;
  error = false;
  /** Call opened from Activity (?call=<id>): selected and briefly highlighted */
  focusedId: string | null = null;
  flashId: string | null = null;
  private seq = 0;
  private sub = new Subscription();

  constructor(
    private http: HttpClient,
    private calls: CallManagerService,
    private users: UserService,
    private alert: AlertService,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.sub.add(this.route.queryParamMap.subscribe((params) => {
      const callId = params.get('call');
      if (callId) {
        this.focusedId = callId;
        // A specific call: show it among all calls
        this.filter = 'all';
      }
      void this.load(true);
    }));
    // A call just finished: refresh the history
    let hadCall = !!this.calls.activeCall;
    this.sub.add(this.calls.changed$.subscribe(() => {
      const has = !!this.calls.activeCall;
      if (hadCall && !has) {
        setTimeout(() => void this.load(true), 1500);
      }
      hadCall = has;
    }));
    this.loadPeople();
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  // ================================================================ people picker

  private loadPeople(): void {
    this.users.getAllUsersExceptCurrentUser().subscribe({
      next: (res) => {
        this.people = (res.data || [])
          .map((u: any) => ({ _id: String(u._id), username: u.username, avatar: u.avatar, presence: presenceOf(u) }))
          .sort((a, b) => a.username.localeCompare(b.username));
        this.peopleLoaded = true;
        this.cdr.markForCheck();
      },
      error: () => {
        this.peopleLoaded = true;
        this.cdr.markForCheck();
      },
    });
  }

  get suggestions(): Person[] {
    const q = this.query.trim().toLowerCase();
    const chosen = new Set(this.selected.map((p) => p._id));
    return this.people.filter((p) => !chosen.has(p._id) && (!q || p.username.toLowerCase().includes(q))).slice(0, 50);
  }

  isSelected(p: Person): boolean {
    return this.selected.some((s) => s._id === p._id);
  }

  toggle(p: Person): void {
    this.selected = this.isSelected(p) ? this.selected.filter((s) => s._id !== p._id) : [...this.selected, p];
    this.query = '';
    this.peopleInput?.nativeElement.focus();
  }

  remove(p: Person): void {
    this.selected = this.selected.filter((s) => s._id !== p._id);
  }

  /** Backspace in an empty search removes the last chosen person (like Teams' "To:" field). */
  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Backspace' && !this.query && this.selected.length) {
      this.selected = this.selected.slice(0, -1);
    } else if (event.key === 'Enter' && this.suggestions.length && this.query.trim()) {
      event.preventDefault();
      this.toggle(this.suggestions[0]);
    }
  }

  /**
   * Audio call with the chosen people through the existing call system: one person → your 1:1 chat;
   * several → an existing group with exactly those members, otherwise a new group chat named after them.
   */
  async startAudioCall(): Promise<void> {
    if (!this.selected.length) {
      this.alert.warning('Select at least one person to call.', {
        title: 'No one selected',
        action: { label: 'Choose people', handler: () => this.peopleInput?.nativeElement.focus() },
      });
      return;
    }
    if (this.starting) {
      return;
    }
    this.starting = true;
    this.cdr.markForCheck();
    try {
      const conversationId = await this.conversationFor(this.selected);
      this.calls.startCall(conversationId, 'audio', 'ring');
      this.selected = [];
    } catch {
      // The error interceptor already showed a friendly message
    } finally {
      this.starting = false;
      this.cdr.markForCheck();
    }
  }

  private async conversationFor(people: Person[]): Promise<string> {
    if (people.length === 1) {
      const res = await firstValueFrom(this.users.createOrGetConversation(people[0]._id));
      return String(res.conversationId);
    }
    // Same people exactly: every chosen person plus me (I'm in all of my groups), nobody else
    const groups = (await firstValueFrom(this.users.getUserGropuConversations())).data || [];
    const existing = groups.find((g: any) => {
      const ids = new Set((g.members || []).map((m: any) => String(m._id)));
      return ids.size === people.length + 1 && people.every((p) => ids.has(p._id));
    });
    if (existing) {
      return String(existing._id);
    }
    const form = new FormData();
    const name = people.map((p) => p.username).join(', ');
    form.append('groupName', name.length > 100 ? `${name.slice(0, 97)}…` : name);
    form.append('groupMembers', JSON.stringify(people.map((p) => p._id)));
    form.append('groupDescription', '');
    const created: any = await firstValueFrom(this.users.createGroup(form));
    return String(created?.data?._id);
  }

  // ================================================================ history

  setFilter(filter: HistoryFilter): void {
    if (filter !== this.filter) {
      this.filter = filter;
      this.focusedId = null;
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
      // A focused call may be older than the first page: keep loading (a few pages at most)
      let pages = 0;
      do {
        let params = new HttpParams();
        if (this.filter !== 'all') params = params.set('filter', this.filter);
        if (this.nextCursor && (!reset || pages > 0)) params = params.set('before', this.nextCursor);
        const res = await firstValueFrom(this.http.get<{ data: { items: CallEntry[]; nextCursor: string | null } }>(`${environment.apiUrl}/calls`, {
          params,
          context: new HttpContext().set(SKIP_ERROR_TOAST, true),
        }));
        if (seq !== this.seq) return;
        this.items = reset && pages === 0 ? res.data.items : [...this.items, ...res.data.items];
        this.nextCursor = res.data.nextCursor;
        pages++;
      } while (this.focusedId && !this.items.some((c) => c._id === this.focusedId) && this.nextCursor && pages < 6);
      this.revealFocused();
    } catch {
      if (seq === this.seq) this.error = true;
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  private revealFocused(): void {
    const id = this.focusedId;
    if (!id || !this.items.some((c) => c._id === id)) {
      return;
    }
    this.flashId = id;
    this.cdr.markForCheck();
    setTimeout(() => document.getElementById(`call-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    setTimeout(() => {
      this.flashId = null;
      this.cdr.markForCheck();
    }, 2500);
  }

  select(call: CallEntry): void {
    this.focusedId = call._id;
    void this.router.navigate([], { queryParams: { call: call._id }, replaceUrl: true });
  }

  callBack(call: CallEntry, type: 'audio' | 'video'): void {
    // Groups start a meeting (lobby); 1:1 rings the other person
    this.calls.startCall(call.conversationId, type, call.isGroup ? 'meetNow' : 'ring');
  }

  openChat(call: CallEntry): void {
    void this.router.navigate(['/chat'], { queryParams: { c: call.conversationId } });
  }

  label(call: CallEntry): string {
    return OUTCOME_LABEL[call.outcome] || '';
  }

  isBad(call: CallEntry): boolean {
    return call.outcome === 'missed' || call.outcome === 'failed';
  }

  peopleText(call: CallEntry): string {
    const names = (call.participants || []).map((p) => p.username).filter(Boolean);
    if (!call.isGroup || !names.length) {
      return '';
    }
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  }

  describe(call: CallEntry): string {
    const kind = call.callType === 'video' ? 'video call' : 'audio call';
    const what = this.label(call) || (call.outcome === 'answered' ? this.duration(call.duration) : '');
    return `${call.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${kind}, ${call.title}${what ? ', ' + what : ''}`;
  }

  duration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  when(value: string): string {
    const d = new Date(value);
    const now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  trackById(_: number, item: { _id: string }): string {
    return item._id;
  }
}
