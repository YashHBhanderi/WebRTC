import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Subject, Subscription, catchError, debounceTime, distinctUntilChanged, of, switchMap, tap } from 'rxjs';
import { SearchMessage, SearchResults, SearchService } from 'src/app/core/services/search.service';
import { UserService } from 'src/app/core/services/user.service';
import { PRESENCE_LABEL, PresenceKey, presenceOf } from 'src/app/core/utils/presence.util';

type DateFilter = 'any' | '7d' | '30d' | '365d';

interface ResultRow {
  id: string;
  kind: 'user' | 'chat' | 'message' | 'file' | 'meeting';
  title: string;
  subtitle: string;
  avatar?: string;
  avatarName: string;
  online?: boolean;
  presence?: PresenceKey | null;
  icon?: string;
  time?: string;
  go: () => void;
}

interface ResultGroup {
  label: string;
  rows: ResultRow[];
}

const DATE_DAYS: Record<Exclude<DateFilter, 'any'>, number> = { '7d': 7, '30d': 30, '365d': 365 };
const FILE_ICONS: Record<string, string> = { image: 'ti-photo', video: 'ti-movie', audio: 'ti-music', pdf: 'ti-file-type-pdf' };

/**
 * Top-bar search over people, chats, messages and files. Debounced (one request per pause, the
 * previous one cancelled); results are grouped and keyboard navigable; picking a message opens its
 * chat, loads back to it and highlights it.
 */
@Component({
  selector: 'app-global-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './global-search.component.html',
  styleUrls: ['./global-search.component.scss'],
})
export class GlobalSearchComponent implements OnInit, OnDestroy {
  @ViewChild('input', { static: true }) input!: ElementRef<HTMLInputElement>;

  query = '';
  open = false;
  loading = false;
  error = false;
  groups: ResultGroup[] = [];
  rows: ResultRow[] = [];
  activeIndex = -1;

  dateFilter: DateFilter = 'any';
  senderId = '';
  senders: { _id: string; username: string }[] = [];
  /** Phones: the box expands over the top bar. */
  expanded = false;

  private readonly input$ = new Subject<string>();
  private sub?: Subscription;
  private sendersLoaded = false;

  constructor(
    private search: SearchService,
    private users: UserService,
    private router: Router,
    private host: ElementRef<HTMLElement>,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.sub = this.input$
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        tap((q) => {
          this.loading = q.length >= 2;
          this.error = false;
          if (q.length < 2) {
            this.setResults(null);
          }
          this.cdr.markForCheck();
        }),
        switchMap((q) => {
          if (q.length < 2) {
            return of(null);
          }
          return this.search.search(q, this.filters()).pipe(
            catchError(() => {
              this.error = true;
              return of(null);
            }),
          );
        }),
      )
      .subscribe((results) => {
        this.loading = false;
        this.setResults(results);
        this.cdr.markForCheck();
      });
    this.sub.add(this.users.newUsers$.subscribe((u: any) => {
      if (this.sendersLoaded) {
        this.senders = UserService.withUser(this.senders, { _id: String(u._id), username: u.username })
          .sort((a, b) => a.username.localeCompare(b.username));
        this.cdr.markForCheck();
      }
    }));
    // Possibly missed new users while offline: reload the sender filter when it's next opened
    this.sub.add(this.users.reconnected$.subscribe(() => (this.sendersLoaded = false)));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  get hasFilters(): boolean {
    return this.dateFilter !== 'any' || !!this.senderId;
  }

  get listboxId(): string {
    return 'global-search-results';
  }

  onInput(value: string): void {
    this.query = value;
    this.open = true;
    this.input$.next(value.trim());
  }

  onFocus(): void {
    this.open = true;
    this.loadSenders();
  }

  /** Filters changed: search again right away with the same text. */
  refresh(): void {
    const q = this.query.trim();
    if (q.length < 2) {
      return;
    }
    this.loading = true;
    this.error = false;
    this.cdr.markForCheck();
    this.search.search(q, this.filters()).subscribe({
      next: (r) => {
        this.loading = false;
        this.setResults(r);
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.error = true;
        this.cdr.markForCheck();
      },
    });
  }

  clearFilters(): void {
    this.dateFilter = 'any';
    this.senderId = '';
    this.refresh();
  }

  clear(): void {
    this.query = '';
    this.input$.next('');
    this.setResults(null);
    this.input.nativeElement.focus();
  }

  close(): void {
    this.open = false;
    this.expanded = false;
    this.activeIndex = -1;
    this.cdr.markForCheck();
  }

  expand(): void {
    this.expanded = true;
    this.open = true;
    this.cdr.markForCheck();
    setTimeout(() => this.input.nativeElement.focus());
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!this.rows.length) {
        return;
      }
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex = (this.activeIndex + step + this.rows.length) % this.rows.length;
      document.getElementById(this.optionId(this.activeIndex))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const row = this.rows[this.activeIndex] || this.rows[0];
      if (row) {
        event.preventDefault();
        this.pick(row);
      }
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
      this.input.nativeElement.blur();
    }
  }

  pick(row: ResultRow): void {
    this.close();
    this.input.nativeElement.blur();
    row.go();
  }

  optionId(index: number): string {
    return `gs-opt-${index}`;
  }

  indexOf(row: ResultRow): number {
    return this.rows.indexOf(row);
  }

  /** Ctrl+E (as in Teams) or "/" focuses search. */
  @HostListener('document:keydown', ['$event'])
  onGlobalKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const ctrlE = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'e';
    if (ctrlE || (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey)) {
      event.preventDefault();
      if (window.matchMedia('(max-width: 767.98px)').matches) {
        this.expand();
      } else {
        this.input.nativeElement.focus();
        this.input.nativeElement.select();
      }
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  onOutside(event: PointerEvent): void {
    if (this.open && !this.host.nativeElement.contains(event.target as Node)) {
      this.close();
    }
  }

  private filters() {
    let from: Date | null = null;
    if (this.dateFilter !== 'any') {
      from = new Date(Date.now() - DATE_DAYS[this.dateFilter] * 86400000);
    }
    return { from, senderId: this.senderId || null, limit: 6 };
  }

  private loadSenders(): void {
    if (this.sendersLoaded) {
      return;
    }
    this.sendersLoaded = true;
    this.users.getAllUsersExceptCurrentUser().subscribe({
      next: (res) => {
        this.senders = (res.data || [])
          .map((u: any) => ({ _id: String(u._id), username: u.username }))
          .sort((a, b) => a.username.localeCompare(b.username));
        this.cdr.markForCheck();
      },
      error: () => (this.sendersLoaded = false),
    });
  }

  private setResults(r: SearchResults | null): void {
    this.activeIndex = -1;
    if (!r) {
      this.groups = [];
      this.rows = [];
      return;
    }
    const q = this.query.trim();
    const groups: ResultGroup[] = [];
    if (r.users.length) {
      groups.push({
        label: 'People',
        rows: r.users.map((u) => ({
          id: `u-${u._id}`,
          kind: 'user',
          title: u.username,
          subtitle: u.statusMessage ? `${PRESENCE_LABEL[presenceOf(u)]} · ${u.statusMessage}` : PRESENCE_LABEL[presenceOf(u)],
          avatar: u.avatar,
          avatarName: u.username,
          presence: presenceOf(u),
          go: () => this.router.navigate(['/chat'], { queryParams: { user: u._id } }),
        })),
      });
    }
    if (r.chats.length) {
      groups.push({
        label: 'Chats',
        rows: r.chats.map((c) => ({
          id: `c-${c._id}`,
          kind: 'chat',
          title: c.title,
          subtitle: c.isGroup ? `Group · ${c.memberCount || 0} members` : 'Chat',
          avatar: c.avatar,
          avatarName: c.title,
          online: !c.isGroup && !!c.isOnline,
          go: () => this.router.navigate(['/chat'], { queryParams: { c: c._id } }),
        })),
      });
    }
    if (r.messages.length) {
      groups.push({
        label: 'Messages',
        rows: r.messages.map((m) => this.messageRow(m, 'message', q)),
      });
    }
    if (r.meetings?.length) {
      groups.push({
        label: 'Meetings',
        rows: r.meetings.map((m) => ({
          id: `mt-${m._id}`,
          kind: 'meeting',
          title: m.title,
          subtitle: `${this.formatDate(m.startAt)}${m.recurring ? ' · Recurring' : ''}`,
          avatarName: m.title,
          icon: 'ti-calendar',
          go: () => this.router.navigate(['/calendar'], { queryParams: { meeting: m._id } }),
        })),
      });
    }
    if (r.files.length) {
      groups.push({
        label: 'Files',
        rows: r.files.map((m) => this.messageRow(m, 'file', q)),
      });
    }
    this.groups = groups;
    this.rows = groups.flatMap((g) => g.rows);
  }

  private messageRow(m: SearchMessage, kind: 'message' | 'file', q: string): ResultRow {
    const sender = m.user?.username || 'Someone';
    return {
      id: `${kind === 'file' ? 'f' : 'm'}-${m._id}`,
      kind,
      title: kind === 'file' ? m.fileName || 'File' : m.content,
      subtitle: `${sender} · ${m.conversationTitle}`,
      avatar: kind === 'message' ? m.user?.avatar : undefined,
      avatarName: sender,
      icon: kind === 'file' ? FILE_ICONS[m.type] || 'ti-file' : undefined,
      time: this.formatDate(m.createdAt),
      go: () => this.router.navigate(['/chat'], {
        queryParams: { c: m.conversationId, m: m._id, q: kind === 'message' ? q : null },
      }),
    };
  }

  private formatDate(value: string): string {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      return '';
    }
    const now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
}
