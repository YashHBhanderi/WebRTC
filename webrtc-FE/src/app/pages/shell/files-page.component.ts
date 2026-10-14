import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { fileIconFor } from '../chat/message-composer/message-composer.component';

interface SharedFile {
  _id: string;
  conversationId: string;
  conversationTitle: string;
  type: string;
  createdAt: string;
  fileName?: string;
  fileSize?: number;
  fileUrl?: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
  user: { _id: string; username?: string } | null;
}

type Filter = '' | 'image' | 'video' | 'audio' | 'pdf' | 'file';

/** Files shared in my chats, newest first, filterable by type. */
@Component({
  selector: 'app-files-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./section-pages.scss', './activity-page.component.scss', './files-page.component.scss'],
  template: `
    <section class="page">
      <header class="page__header activity__header">
        <h1 class="page__title">Files</h1>
        <div class="segmented" role="radiogroup" aria-label="File type">
          <button *ngFor="let f of filters" type="button" role="radio" class="segmented__opt"
                  [class.segmented__opt--on]="filter === f.value" [attr.aria-checked]="filter === f.value" (click)="setFilter(f.value)">
            {{ f.label }}
          </button>
        </div>
      </header>

      <div class="files-table" *ngIf="items.length" role="table" aria-label="Shared files">
        <div class="files-row files-row--head" role="row">
          <span role="columnheader">Name</span>
          <span role="columnheader" class="hide-sm">Shared in</span>
          <span role="columnheader" class="hide-sm">Shared by</span>
          <span role="columnheader">Date</span>
          <span role="columnheader"><span class="visually-hidden">Actions</span></span>
        </div>
        <div class="files-row" role="row" *ngFor="let item of items; trackBy: trackById">
          <span role="cell" class="files-name">
            <span class="files-icon">
              <img *ngIf="item.type === 'image' && item.thumbnailUrl; else icon" [src]="item.thumbnailUrl" alt="" loading="lazy" />
              <ng-template #icon><i class="fa-solid {{ iconOf(item) }}" aria-hidden="true"></i></ng-template>
            </span>
            <span class="files-name__text">
              <span class="files-name__title" [title]="item.fileName || ''">{{ item.fileName || label(item) }}</span>
              <span class="files-name__size">{{ item.fileSize | fileSize }}</span>
            </span>
          </span>
          <span role="cell" class="hide-sm files-muted">{{ item.conversationTitle }}</span>
          <span role="cell" class="hide-sm files-muted">{{ item.user?.username || '' }}</span>
          <span role="cell" class="files-muted">{{ item.createdAt | date: 'MMM d, y' }}</span>
          <span role="cell" class="files-actions">
            <button type="button" class="icon-btn-sm" (click)="openInChat(item)" [attr.aria-label]="'Show ' + (item.fileName || 'file') + ' in chat'" title="Show in chat">
              <i class="fa-regular fa-comment"></i>
            </button>
            <a class="icon-btn-sm" *ngIf="item.downloadUrl" [href]="item.downloadUrl" download rel="noopener" [attr.aria-label]="'Download ' + (item.fileName || 'file')" title="Download">
              <i class="fa-solid fa-download"></i>
            </a>
          </span>
        </div>
      </div>

      <ng-container *ngIf="loading && !items.length">
        <div class="activity__skeleton" *ngFor="let i of [1, 2, 3, 4, 5]" aria-hidden="true"></div>
        <span class="visually-hidden" role="status">Loading files</span>
      </ng-container>
      <div class="empty" *ngIf="!loading && !error && !items.length">
        <i class="fa-solid fa-folder-open empty__icon" aria-hidden="true"></i>
        <h2 class="empty__title">No files yet</h2>
        <p class="empty__text">Files shared in your chats will be collected here.</p>
      </div>
      <div class="empty" *ngIf="error" role="alert">
        <h2 class="empty__title">We couldn't load your files.</h2>
        <button type="button" class="btn btn-sm btn-primary" (click)="load(true)">Try again</button>
      </div>
      <div class="activity__more" *ngIf="nextCursor && !error">
        <button type="button" class="btn btn-sm btn-light" (click)="load()" [disabled]="loading">{{ loading ? 'Loading…' : 'Show more' }}</button>
      </div>
    </section>
  `,
})
export class FilesPageComponent implements OnInit {
  readonly filters: { value: Filter; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'image', label: 'Photos' },
    { value: 'video', label: 'Videos' },
    { value: 'pdf', label: 'PDFs' },
    { value: 'file', label: 'Documents' },
    { value: 'audio', label: 'Audio' },
  ];
  filter: Filter = '';
  items: SharedFile[] = [];
  nextCursor: string | null = null;
  loading = false;
  error = false;
  private seq = 0;

  constructor(private http: HttpClient, private router: Router, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    void this.load(true);
  }

  setFilter(value: Filter): void {
    if (this.filter !== value) {
      this.filter = value;
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
      let params = new HttpParams();
      if (this.filter) params = params.set('type', this.filter);
      if (!reset && this.nextCursor) params = params.set('before', this.nextCursor);
      const res = await firstValueFrom(this.http.get<{ data: { items: SharedFile[]; nextCursor: string | null } }>(`${environment.apiUrl}/files`, {
        params,
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
      if (seq !== this.seq) {
        return;
      }
      this.items = reset ? res.data.items : [...this.items, ...res.data.items];
      this.nextCursor = res.data.nextCursor;
    } catch {
      if (seq === this.seq) {
        this.error = true;
      }
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  openInChat(item: SharedFile): void {
    void this.router.navigate(['/chat'], { queryParams: { c: item.conversationId, m: item._id } });
  }

  iconOf(item: SharedFile): string {
    return fileIconFor(item.fileName || '', item.type);
  }

  label(item: SharedFile): string {
    return { image: 'Photo', video: 'Video', audio: 'Audio', pdf: 'Document', file: 'File' }[item.type] || 'File';
  }

  trackById(_: number, item: SharedFile): string {
    return item._id;
  }
}
