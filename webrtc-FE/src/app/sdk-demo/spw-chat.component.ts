import { ChangeDetectorRef, Component, Input, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ChatMessage, ChatUser, Conversation, SpreeWeClient } from '@spreewe/chat-sdk';

/**
 * Reusable chat UI on top of @spreewe/chat-sdk (prototype). Standalone: depends only on the SDK client
 * it is given, not on the SpreeWe app's services. Conversation list + messages + composer.
 */
@Component({
  selector: 'spw-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="spw" *ngIf="client">
      <aside class="spw-list">
        <div class="spw-head">Conversations</div>
        <button class="spw-conv" *ngFor="let c of conversations" [class.active]="c.id === active?.id" (click)="open(c)">
          {{ c.name }} <small *ngIf="c.isGroup">group</small>
        </button>
        <div class="spw-empty" *ngIf="!conversations.length">No conversations yet</div>
        <div class="spw-head">Start a chat</div>
        <select [(ngModel)]="pickUser" aria-label="Person">
          <option [ngValue]="null">Choose a person…</option>
          <option *ngFor="let u of people" [ngValue]="u">{{ u.name || u.username || u.email }}</option>
        </select>
        <button (click)="startDirect()" [disabled]="!pickUser">Open</button>
      </aside>
      <section class="spw-main">
        <ng-container *ngIf="active; else none">
          <div class="spw-head">{{ active.name }}</div>
          <div class="spw-messages">
            <div class="spw-msg" *ngFor="let m of messages" [class.mine]="m.senderId === client.me?._id">
              <span *ngIf="m.state === 'ok' || m.state === 'plain'">{{ m.text }}</span>
              <em *ngIf="m.state === 'pending'">Waiting for this message's key…</em>
              <em *ngIf="m.state === 'failed'">{{ m.warning || "Can't be decrypted on this device" }}</em>
            </div>
          </div>
          <form class="spw-compose" (ngSubmit)="send()">
            <input [(ngModel)]="draft" name="draft" placeholder="Encrypted message" autocomplete="off" />
            <button type="submit" [disabled]="!draft.trim() || sending">Send</button>
          </form>
        </ng-container>
        <ng-template #none><div class="spw-empty">Pick a conversation</div></ng-template>
        <div class="spw-error" *ngIf="error" role="alert">{{ error }}</div>
      </section>
    </div>
  `,
  styles: [`
    .spw { display: flex; height: 100%; min-height: 420px; border: 1px solid #ccd; font-family: inherit; }
    .spw-list { width: 240px; border-right: 1px solid #ccd; display: flex; flex-direction: column; gap: 4px; padding: 8px; overflow: auto; }
    .spw-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .spw-head { font-weight: 600; padding: 6px 8px; }
    .spw-conv { text-align: left; padding: 6px 8px; border: 0; background: none; cursor: pointer; }
    .spw-conv.active { background: #e8eef5; }
    .spw-messages { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .spw-msg { align-self: flex-start; background: #f0f2f5; padding: 6px 10px; border-radius: 8px; max-width: 75%; }
    .spw-msg.mine { align-self: flex-end; background: #d9e9f7; }
    .spw-compose { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #ccd; }
    .spw-compose input { flex: 1; }
    .spw-empty { color: #667; padding: 8px; }
    .spw-error { color: #b00020; padding: 8px; }
  `],
})
export class SpwChatComponent implements OnInit, OnDestroy {
  @Input() client!: SpreeWeClient;
  conversations: Conversation[] = [];
  people: ChatUser[] = [];
  active: Conversation | null = null;
  messages: ChatMessage[] = [];
  draft = '';
  sending = false;
  error = '';
  pickUser: ChatUser | null = null;
  private off: (() => void)[] = [];

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    // SDK callbacks run outside Angular's knowledge: re-enter the zone so the view updates
    this.off.push(this.client.onMessage((m) => this.zone.run(() => this.onIncoming(m))));
    this.off.push(this.client.onError((e) => this.zone.run(() => (this.error = e.message))));
    this.off.push(this.client.onKeysChanged(() => this.zone.run(() => void this.reload())));
    await this.refresh();
  }

  ngOnDestroy(): void {
    this.off.forEach((f) => f());
  }

  async refresh(): Promise<void> {
    try {
      [this.conversations, this.people] = await Promise.all([this.client.listConversations(), this.client.directory()]);
    } catch (e: any) {
      this.error = e?.message || 'Could not load conversations';
    }
    this.cdr.markForCheck();
  }

  async open(c: Conversation): Promise<void> {
    this.active = c;
    await this.reload();
  }

  async startDirect(): Promise<void> {
    if (!this.pickUser) return;
    try {
      const id = await this.client.openDirect(String(this.pickUser._id));
      await this.refresh();
      const c = this.conversations.find((x) => x.id === id);
      if (c) await this.open(c);
    } catch (e: any) {
      this.error = e?.message || 'Could not open the conversation';
    }
  }

  async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text || !this.active) return;
    this.sending = true;
    this.error = '';
    try {
      await this.client.send(this.active.id, text);
      this.draft = '';
    } catch (e: any) {
      this.error = e?.message || 'Not sent';
    } finally {
      this.sending = false;
    }
  }

  private async reload(): Promise<void> {
    if (!this.active) return;
    this.messages = await this.client.history(this.active.id);
    this.cdr.markForCheck();
  }

  private onIncoming(m: ChatMessage): void {
    if (m.conversationId === this.active?.id) this.messages = [...this.messages, m];
    else if (!this.conversations.some((c) => c.id === m.conversationId)) void this.refresh();
  }
}
