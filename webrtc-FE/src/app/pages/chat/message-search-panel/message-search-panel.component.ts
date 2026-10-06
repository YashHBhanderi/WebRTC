import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';
import { CHAT_CONFIG, ChatConfig } from 'src/app/core/config/chat.config';
import { SearchCursor, SearchResult } from 'src/app/core/interfaces/chat';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';

interface ResultGroup {
  label: string;
  items: SearchResult[];
}

/** Right-side "Search messages" panel. Searches the server, never the loaded page only. */
@Component({
  selector: 'app-message-search-panel',
  templateUrl: './message-search-panel.component.html',
  styleUrls: ['./message-search-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageSearchPanelComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() conversationId = '';
  @Input() myUserId = '';
  @Input() activeMessageId: string | null = null;
  @Output() jump = new EventEmitter<{ messageId: string; term: string }>();
  @Output() close = new EventEmitter<void>();

  @ViewChild('input') input?: ElementRef<HTMLInputElement>;

  query = '';
  groups: ResultGroup[] = [];
  total = 0;
  loading = false;
  loadingMore = false;
  error = '';
  searched = false;
  private results: SearchResult[] = [];
  private cursor: SearchCursor | null = null;
  private requestSeq = 0;
  private readonly query$ = new Subject<string>();
  private readonly sub: Subscription;

  constructor(
    private actions: ChatActionsService,
    private cdr: ChangeDetectorRef,
    @Inject(CHAT_CONFIG) private config: ChatConfig,
  ) {
    this.sub = this.query$.pipe(debounceTime(300), distinctUntilChanged()).subscribe((q) => void this.run(q));
  }

  get hasMore(): boolean {
    return !!this.cursor;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] && !changes['conversationId'].firstChange) {
      this.reset();
      this.query = '';
    }
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.input?.nativeElement.focus());
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  onQuery(value: string): void {
    this.query = value;
    this.query$.next(value.trim());
  }

  clearQuery(): void {
    this.query = '';
    this.query$.next('');
    this.input?.nativeElement.focus();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (this.query) {
        this.clearQuery();
      } else {
        this.close.emit();
      }
    }
  }

  open(result: SearchResult): void {
    this.jump.emit({ messageId: result._id, term: this.query.trim() });
  }

  async loadMore(): Promise<void> {
    if (!this.cursor || this.loadingMore) {
      return;
    }
    this.loadingMore = true;
    this.cdr.markForCheck();
    const seq = this.requestSeq;
    try {
      const page = await this.actions.search(this.conversationId, this.query.trim(), this.cursor, this.config.searchPageSize);
      if (seq !== this.requestSeq) {
        return;
      }
      this.results = [...this.results, ...page.results];
      this.cursor = page.nextCursor;
      this.regroup();
    } catch (error: any) {
      this.error = error?.message || 'Search failed';
    } finally {
      this.loadingMore = false;
      this.cdr.markForCheck();
    }
  }

  senderLabel(result: SearchResult): string {
    return String(result.user?._id) === this.myUserId ? 'You' : result.user?.username || 'Unknown';
  }

  /** Text around the first match, so a hit deep inside a long message is still visible. */
  snippet(content: string): string {
    const text = (content || '').replace(/\s+/g, ' ');
    const q = this.query.trim().toLowerCase();
    const index = q ? text.toLowerCase().indexOf(q) : -1;
    if (index < 60) {
      return text.length > 160 ? `${text.slice(0, 160)}…` : text;
    }
    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + q.length + 100);
    return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  /** MM/DD as requested; the month heading carries the year. */
  shortDate(value: string): string {
    const d = new Date(value);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  trackGroup(_: number, g: ResultGroup): string {
    return g.label;
  }

  trackResult(_: number, r: SearchResult): string {
    return r._id;
  }

  private reset(): void {
    this.requestSeq++;
    this.results = [];
    this.groups = [];
    this.total = 0;
    this.cursor = null;
    this.error = '';
    this.searched = false;
    this.loading = false;
    this.cdr.markForCheck();
  }

  private async run(q: string): Promise<void> {
    this.reset();
    if (q.length < 2) {
      return;
    }
    const seq = this.requestSeq;
    this.loading = true;
    this.cdr.markForCheck();
    try {
      const page = await this.actions.search(this.conversationId, q, null, this.config.searchPageSize);
      if (seq !== this.requestSeq) {
        return; // a newer query superseded this one
      }
      this.results = page.results;
      this.cursor = page.nextCursor;
      this.searched = true;
      this.regroup();
    } catch (error: any) {
      if (seq === this.requestSeq) {
        this.error = error?.message || 'Search failed';
      }
    } finally {
      if (seq === this.requestSeq) {
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  private regroup(): void {
    const groups: ResultGroup[] = [];
    for (const result of this.results) {
      const label = new Date(result.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const last = groups[groups.length - 1];
      if (last?.label === label) {
        last.items.push(result);
      } else {
        groups.push({ label, items: [result] });
      }
    }
    this.groups = groups;
    this.total = this.results.length;
  }
}
