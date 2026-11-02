import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ChatUser, Conversation, SpreeWeClient } from '@spreewe/chat-sdk';
import { SPW_THEME, nameOf } from './theme';

/** Conversation sidebar: direct + group conversations of the active workspace, unread markers, new chat / new group. */
@Component({
  selector: 'spw-conversation-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head"><b>{{ title }}</b><button type="button" (click)="mode = mode ? null : 'direct'" aria-label="New conversation">＋</button></div>
    <div class="new" *ngIf="mode">
      <div class="tabs">
        <button type="button" [class.primary]="mode === 'direct'" (click)="mode = 'direct'">Chat</button>
        <button type="button" [class.primary]="mode === 'group'" (click)="mode = 'group'">Group</button>
      </div>
      <input *ngIf="mode === 'group'" [(ngModel)]="groupName" placeholder="Group name" />
      <input [(ngModel)]="filter" placeholder="Search people" />
      <div class="people">
        <label *ngFor="let u of filtered()">
          <input *ngIf="mode === 'group'" type="checkbox" [checked]="picked.has(u._id)" (change)="toggle(u._id)" />
          <button *ngIf="mode === 'direct'" type="button" class="link" (click)="openDirect(u)">{{ name(u) }}</button>
          <span *ngIf="mode === 'group'">{{ name(u) }}</span>
        </label>
        <div class="muted" *ngIf="!filtered().length">No people found</div>
      </div>
      <button *ngIf="mode === 'group'" class="primary" type="button" [disabled]="!groupName.trim() || !picked.size" (click)="createGroup()">Create group</button>
    </div>
    <div class="error" *ngIf="error">{{ error }}</div>
    <div class="muted pad" *ngIf="loading">Loading…</div>
    <button type="button" class="conv" *ngFor="let c of conversations" [class.active]="c.id === selectedId" (click)="select(c)">
      <span class="name">{{ c.isGroup ? '# ' : '' }}{{ c.name }}</span>
      <span class="dot" *ngIf="unread.has(c.id)" aria-label="Unread"></span>
    </button>
    <div class="muted pad" *ngIf="!loading && !conversations.length">No conversations yet</div>
  `,
  styles: [SPW_THEME, `
    :host { display: flex; flex-direction: column; gap: 4px; padding: 8px; overflow: auto; background: var(--spw-surface); min-height: 0; }
    .head { display: flex; justify-content: space-between; align-items: center; padding: 4px; }
    .new { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px solid var(--spw-border); border-radius: var(--spw-radius); background: var(--spw-bg); }
    .tabs { display: flex; gap: 6px; }
    .people { max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
    .people label { display: flex; gap: 6px; align-items: center; }
    .link { border: 0; background: none; padding: 2px 0; text-align: left; }
    .conv { display: flex; justify-content: space-between; align-items: center; text-align: left; border: 0; background: none; padding: 8px; }
    .conv.active { background: var(--spw-bg); box-shadow: inset 3px 0 0 var(--spw-accent); }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--spw-accent); flex: none; }
    .pad { padding: 8px; }
  `],
})
export class SpwConversationListComponent implements OnInit, OnDestroy {
  @Input() client!: SpreeWeClient;
  @Input() title = 'Chats';
  @Input() selectedId: string | null = null;
  @Output() selected = new EventEmitter<Conversation>();

  conversations: Conversation[] = [];
  people: ChatUser[] = [];
  unread = new Set<string>();
  loading = true;
  error = '';
  mode: 'direct' | 'group' | null = null;
  filter = '';
  groupName = '';
  picked = new Set<string>();
  private offs: (() => void)[] = [];

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    const refresh = () => this.zone.run(() => void this.refresh());
    this.offs.push(
      this.client.events.on('message', (m) => this.zone.run(() => {
        if (m.conversationId !== this.selectedId) this.unread.add(m.conversationId);
        if (!this.conversations.some((c) => c.id === m.conversationId)) void this.refresh();
        this.cdr.markForCheck();
      })),
      this.client.events.on('conversation.added', refresh),
      this.client.events.on('conversation.removed', refresh),
      this.client.events.on('conversation.updated', refresh),
    );
    await this.refresh();
  }

  ngOnDestroy(): void {
    this.offs.forEach((f) => f());
  }

  name = nameOf;

  filtered(): ChatUser[] {
    const q = this.filter.trim().toLowerCase();
    const me = String(this.client.me?._id || '');
    return this.people.filter((u) => String(u._id) !== me && (!q || nameOf(u).toLowerCase().includes(q)));
  }

  toggle(id: string): void {
    this.picked.has(id) ? this.picked.delete(id) : this.picked.add(id);
  }

  select(c: Conversation): void {
    this.unread.delete(c.id);
    this.selectedId = c.id;
    this.selected.emit(c);
  }

  async refresh(): Promise<void> {
    try {
      [this.conversations, this.people] = await Promise.all([this.client.conversations.list(), this.client.users.directory()]);
      this.error = '';
    } catch (e: any) {
      this.error = e?.message || 'Could not load conversations';
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  async openDirect(u: ChatUser): Promise<void> {
    try {
      const id = await this.client.conversations.openDirect(String(u._id));
      this.mode = null;
      await this.refresh();
      // A brand-new direct conversation isn't listed until it has a message: show it anyway
      const c = this.conversations.find((x) => x.id === id) || { id, isGroup: false, name: nameOf(u), members: [this.client.me!, u], raw: null };
      this.select(c);
    } catch (e: any) {
      this.error = e?.message || 'Could not open the conversation';
    }
    this.cdr.markForCheck();
  }

  async createGroup(): Promise<void> {
    try {
      const c = await this.client.conversations.createGroup({ name: this.groupName.trim(), memberIds: [...this.picked] });
      this.mode = null;
      this.groupName = '';
      this.picked.clear();
      await this.refresh();
      this.select(this.conversations.find((x) => x.id === c.id) || c);
    } catch (e: any) {
      this.error = e?.message || 'Could not create the group';
    }
    this.cdr.markForCheck();
  }
}
