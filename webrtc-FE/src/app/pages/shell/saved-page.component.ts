import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MEDIA_TYPE_LABELS } from 'src/app/core/interfaces/chat';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

interface SavedItem {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  content: string;
  type: string;
  createdAt: string;
  fileName?: string;
  user: { _id: string; username?: string; avatar?: string } | null;
}

/** Messages I saved, newest first; opening one jumps to it in its chat. */
@Component({
  selector: 'app-saved-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./section-pages.scss', './activity-page.component.scss'],
  template: `
    <section class="page page--narrow">
      <header class="page__header"><h1 class="page__title">Saved messages</h1></header>

      <ul class="activity__list" *ngIf="items.length" aria-label="Saved messages">
        <li *ngFor="let item of items; trackBy: trackById">
          <button type="button" class="activity__item" (click)="open(item)">
            <span class="activity__avatar">
              <app-avatar [src]="item.user?.avatar" [name]="item.user?.username || '?'" [size]="40"></app-avatar>
            </span>
            <span class="activity__text">
              <span class="activity__title">{{ item.user?.username || 'Someone' }} · {{ item.conversationTitle }}</span>
              <span class="activity__body">{{ preview(item) }}</span>
            </span>
            <span class="activity__meta"><span class="activity__time">{{ item.createdAt | date: 'MMM d' }}</span></span>
          </button>
          <button type="button" class="activity__callback" (click)="unsave(item)" aria-label="Remove from saved" title="Remove from saved">
            <i class="ti ti-bookmark" aria-hidden="true"></i>
          </button>
        </li>
      </ul>

      <ng-container *ngIf="loading && !items.length">
        <div class="activity__skeleton" *ngFor="let i of [1, 2, 3, 4]" aria-hidden="true"></div>
        <span class="visually-hidden" role="status">Loading saved messages</span>
      </ng-container>
      <div class="empty" *ngIf="!loading && !error && !items.length">
        <i class="ti ti-bookmark empty__icon" aria-hidden="true"></i>
        <h2 class="empty__title">No saved messages</h2>
        <p class="empty__text">Use “Save” in a message's menu to keep it here.</p>
      </div>
      <div class="empty" *ngIf="error" role="alert">
        <h2 class="empty__title">We couldn't load your saved messages.</h2>
        <button type="button" class="btn btn-sm btn-primary" (click)="load(true)">Try again</button>
      </div>
      <div class="activity__more" *ngIf="nextCursor && !error">
        <button type="button" class="btn btn-sm btn-light" (click)="load()" [disabled]="loading">{{ loading ? 'Loading…' : 'Show older' }}</button>
      </div>
    </section>
  `,
})
export class SavedPageComponent implements OnInit {
  items: SavedItem[] = [];
  nextCursor: string | null = null;
  loading = false;
  error = false;

  constructor(
    private actions: ChatActionsService,
    private alert: AlertService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    void this.load(true);
  }

  async load(reset = false): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    this.error = false;
    this.cdr.markForCheck();
    try {
      const res = await this.actions.savedMessages(reset ? null : this.nextCursor);
      this.items = reset ? res.items : [...this.items, ...res.items];
      this.nextCursor = res.nextCursor;
    } catch {
      this.error = true;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  open(item: SavedItem): void {
    void this.router.navigate(['/chat'], { queryParams: { c: item.conversationId, m: item.messageId } });
  }

  async unsave(item: SavedItem): Promise<void> {
    const before = this.items;
    this.items = this.items.filter((i) => i.messageId !== item.messageId);
    this.cdr.markForCheck();
    try {
      await this.actions.setSaved(item.messageId, false);
    } catch {
      this.items = before;
      this.cdr.markForCheck();
    }
  }

  preview(item: SavedItem): string {
    if (item.type === 'text' || item.content !== item.type) {
      return item.content;
    }
    return item.fileName || MEDIA_TYPE_LABELS[item.type] || item.type;
  }

  trackById(_: number, item: SavedItem): string {
    return item.messageId;
  }
}
