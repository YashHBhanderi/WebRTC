import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { ChatMessage, Conversation, SpreeWeClient } from '@spreewe/chat-sdk';
import { SPW_THEME, nameOf } from './theme';
import { SpwComposerComponent } from './composer.component';
import { SpwAttachmentComponent } from './attachment.component';
import { SpwPresenceBadgeComponent } from './presence-badge.component';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉'];

/** One conversation (direct or group): header, decrypted message list, reactions, reply / edit / delete, typing, composer. */
@Component({
  selector: 'spw-chat-window',
  standalone: true,
  imports: [CommonModule, SpwComposerComponent, SpwAttachmentComponent, SpwPresenceBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <div>
        <b>{{ conversation?.name }}</b>
        <spw-presence-badge *ngIf="!conversation?.isGroup" [status]="peerStatus" [showLabel]="true"></spw-presence-badge>
        <span class="muted" *ngIf="conversation?.isGroup">{{ conversation?.members?.length }} members</span>
      </div>
      <div class="actions" *ngIf="allowCalls">
        <button type="button" (click)="call.emit('audio')" aria-label="Audio call">📞</button>
        <button type="button" (click)="call.emit('video')" aria-label="Video call">🎥</button>
      </div>
    </header>
    <div class="list" role="log" aria-live="polite">
      <div class="muted center" *ngIf="loading">Loading…</div>
      <div class="error center" *ngIf="error">{{ error }}</div>
      <div class="muted center" *ngIf="!loading && !error && !messages.length">No messages yet. Say hello.</div>
      <div class="msg" *ngFor="let m of messages; trackBy: byId" [class.mine]="m.senderId === myId" [class.system]="m.state === 'plain'">
        <div class="meta" *ngIf="conversation?.isGroup && m.senderId !== myId && m.state !== 'plain'">{{ senderName(m.senderId) }}</div>
        <div class="quote muted" *ngIf="m.replyToId">↪ {{ quoted(m.replyToId) }}</div>
        <ng-container [ngSwitch]="m.state">
          <span *ngSwitchCase="'pending'" class="muted">Waiting for this message's key…</span>
          <span *ngSwitchCase="'failed'" class="error">{{ m.warning || "Can't be decrypted on this device" }}</span>
          <ng-container *ngSwitchDefault>
            <span *ngIf="m.deleted" class="muted">Message deleted</span>
            <ng-container *ngIf="!m.deleted">
              <spw-attachment *ngIf="m.attachment" [attachment]="m.attachment"></spw-attachment>
              <span class="text" *ngIf="m.text">{{ m.text }}</span>
              <span class="muted small" *ngIf="m.edited"> (edited)</span>
            </ng-container>
          </ng-container>
        </ng-container>
        <div class="reactions" *ngIf="m.reactions.length">
          <span *ngFor="let r of grouped(m)">{{ r.emoji }} {{ r.count }}</span>
        </div>
        <div class="tools" *ngIf="m.state === 'ok' && !m.deleted">
          <button type="button" *ngFor="let e of quick" (click)="react(m, e)">{{ e }}</button>
          <button type="button" (click)="replyTo = m; editing = null">Reply</button>
          <ng-container *ngIf="m.senderId === myId">
            <button type="button" (click)="editing = m; replyTo = null">Edit</button>
            <button type="button" (click)="remove(m)">Delete</button>
          </ng-container>
        </div>
      </div>
      <div class="muted small typing" *ngIf="typingNames.length">{{ typingNames.join(', ') }} typing…</div>
    </div>
    <spw-composer [client]="client" [conversationId]="conversation?.id || ''" [replyTo]="replyTo" [editing]="editing"
      (sent)="replyTo = null; editing = null" (cancel)="replyTo = null; editing = null"></spw-composer>
  `,
  styles: [SPW_THEME, `
    :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--spw-bg); }
    header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--spw-border); gap: 8px; }
    header > div:first-child { display: flex; gap: 10px; align-items: center; min-width: 0; }
    .actions { display: flex; gap: 6px; }
    .list { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .center { align-self: center; }
    .msg { align-self: flex-start; max-width: min(75%, 560px); background: var(--spw-surface); border-radius: var(--spw-radius); padding: 6px 10px; }
    .msg.mine { align-self: flex-end; background: var(--spw-mine); }
    .msg.system { align-self: center; background: none; color: var(--spw-muted); font-size: 13px; }
    .text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .meta, .small { font-size: 12px; }
    .meta { font-weight: 600; margin-bottom: 2px; }
    .quote { font-size: 12px; border-left: 3px solid var(--spw-accent); padding-left: 6px; margin-bottom: 4px; }
    .reactions { display: flex; gap: 6px; font-size: 13px; margin-top: 4px; }
    .tools { display: none; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
    .tools button { padding: 1px 6px; font-size: 12px; }
    .msg:hover .tools, .msg:focus-within .tools { display: flex; }
  `],
})
export class SpwChatWindowComponent implements OnChanges, OnDestroy {
  @Input() client!: SpreeWeClient;
  @Input() conversation: Conversation | null = null;
  /** Show audio / video call buttons */
  @Input() allowCalls = true;
  @Output() call = new EventEmitter<'audio' | 'video'>();

  messages: ChatMessage[] = [];
  loading = false;
  error = '';
  replyTo: ChatMessage | null = null;
  editing: ChatMessage | null = null;
  peerStatus: string | null = null;
  typingNames: string[] = [];
  readonly quick = QUICK_REACTIONS;
  private typing = new Map<string, ReturnType<typeof setTimeout>>();
  private offs: (() => void)[] = [];

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  get myId(): string { return String(this.client?.me?._id || ''); }

  async ngOnChanges(): Promise<void> {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.replyTo = this.editing = null;
    this.typingNames = [];
    if (!this.client || !this.conversation) return;
    const id = this.conversation.id;
    const on = this.client.events.on.bind(this.client.events);
    const run = (fn: () => void) => this.zone.run(() => { fn(); this.cdr.markForCheck(); });
    this.offs.push(
      on('message', (m) => m.conversationId === id && run(() => {
        this.messages = [...this.messages, m];
        this.client.messages.markRead(id);
      })),
      on('message.updated', (m) => m.conversationId === id && run(() => (this.messages = this.messages.map((x) => (x.id === m.id ? { ...x, text: m.text, state: m.state, edited: true } : x))))),
      on('message.deleted', (d) => d.conversationId === id && run(() => (this.messages = this.messages.map((x) => (x.id === d.messageId ? { ...x, deleted: true, text: '' } : x))))),
      on('reaction.updated', (r: any) => String(r.conversationId) === id && run(() => (this.messages = this.messages.map((x) => (x.id === String(r.messageId) ? { ...x, reactions: (r.reactions || []).map((y: any) => ({ emoji: y.emoji, userId: String(y.userId?._id || y.userId) })) } : x))))),
      on('typing', (t) => t.conversationId === id && t.userId !== this.myId && run(() => this.setTyping(t.userId, t.isTyping))),
      on('presence', (p) => this.isPeer(String(p.userId)) && run(() => (this.peerStatus = String(p.status || 'Offline')))),
      on('keys', () => void this.load()),
    );
    this.peerStatus = (this.peer() as any)?.status || null;
    await this.load();
  }

  ngOnDestroy(): void {
    this.offs.forEach((f) => f());
  }

  byId = (_: number, m: ChatMessage) => m.id;

  senderName(userId: string): string {
    return nameOf(this.conversation?.members.find((u) => String(u._id) === userId));
  }

  quoted(id: string): string {
    const m = this.messages.find((x) => x.id === id);
    return m?.state === 'ok' ? m.text || m.attachment?.name || 'message' : 'message';
  }

  grouped(m: ChatMessage): { emoji: string; count: number }[] {
    const counts = new Map<string, number>();
    m.reactions.forEach((r) => counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1));
    return [...counts].map(([emoji, count]) => ({ emoji, count }));
  }

  react(m: ChatMessage, emoji: string): void {
    this.client.messages.react(m.conversationId, m.id, emoji);
  }

  async remove(m: ChatMessage): Promise<void> {
    try {
      await this.client.messages.delete(m.id);
    } catch (e: any) {
      this.error = e?.message || 'Could not delete';
      this.cdr.markForCheck();
    }
  }

  private async load(): Promise<void> {
    if (!this.conversation) return;
    this.loading = !this.messages.length;
    this.error = '';
    this.cdr.markForCheck();
    try {
      this.messages = await this.client.messages.history(this.conversation.id, { limit: 50 });
      this.client.messages.markRead(this.conversation.id);
    } catch (e: any) {
      this.error = e?.message || 'Could not load messages';
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  private peer() {
    return this.conversation?.isGroup ? null : this.conversation?.members.find((u) => String(u._id) !== this.myId) || null;
  }

  private isPeer(userId: string): boolean {
    return String(this.peer()?._id || '') === userId;
  }

  private setTyping(userId: string, on: boolean): void {
    clearTimeout(this.typing.get(userId));
    if (on) this.typing.set(userId, setTimeout(() => this.zone.run(() => { this.setTyping(userId, false); this.cdr.markForCheck(); }), 6000));
    else this.typing.delete(userId);
    this.typingNames = [...this.typing.keys()].map((id) => this.senderName(id));
  }
}
