import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { CallInfo, Conversation, SpreeWeClient } from '@spreewe/chat-sdk';
import { SPW_THEME, nameOf } from './theme';
import { SpwConversationListComponent } from './conversation-list.component';
import { SpwChatWindowComponent } from './chat-window.component';
import { SpwCallComponent } from './call.component';

/**
 * Complete chat + calling experience: conversation sidebar, chat window, incoming / outgoing calls.
 * Give it a connected SpreeWeClient: <spw-chat-app [client]="client"></spw-chat-app>
 * Fills its container; on narrow screens the sidebar and the chat window switch.
 */
@Component({
  selector: 'spw-chat-app',
  standalone: true,
  imports: [CommonModule, SpwConversationListComponent, SpwChatWindowComponent, SpwCallComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="app" [class.open]="!!active">
      <spw-conversation-list class="side" [client]="client" [selectedId]="active?.id || null" (selected)="active = $event"></spw-conversation-list>
      <div class="main">
        <button type="button" class="back" *ngIf="active" (click)="active = null">← Chats</button>
        <spw-chat-window *ngIf="active; else empty" [client]="client" [conversation]="active" [allowCalls]="allowCalls" (call)="startCall($event)"></spw-chat-window>
        <ng-template #empty><div class="empty muted">Select a conversation</div></ng-template>
      </div>
      <div class="call" *ngIf="call">
        <spw-call [client]="client" [call]="call" [direction]="callDirection" [allowRecording]="allowRecording" [names]="names" (closed)="call = null"></spw-call>
      </div>
      <div class="error toast" *ngIf="error" (click)="error = ''">{{ error }}</div>
    </div>
  `,
  styles: [SPW_THEME, `
    :host { display: block; height: 100%; min-height: 420px; }
    .app { position: relative; display: grid; grid-template-columns: minmax(220px, 300px) 1fr; height: 100%; border: 1px solid var(--spw-border); border-radius: var(--spw-radius); overflow: hidden; background: var(--spw-bg); }
    .main { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .main spw-chat-window { flex: 1; min-height: 0; }
    .side { border-right: 1px solid var(--spw-border); min-height: 0; }
    .empty { margin: auto; }
    .back { display: none; margin: 6px; align-self: flex-start; }
    .call { position: absolute; right: 12px; bottom: 12px; width: min(560px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto; z-index: 2; }
    .toast { position: absolute; left: 12px; bottom: 12px; background: var(--spw-bg); border: 1px solid var(--spw-danger); padding: 8px; border-radius: var(--spw-radius); cursor: pointer; }
    @media (max-width: 640px) {
      .app { grid-template-columns: 1fr; }
      .app.open .side { display: none; }
      .app:not(.open) .main { display: none; }
      .back { display: inline-block; }
    }
  `],
})
export class SpwChatAppComponent implements OnInit, OnDestroy {
  @Input() client!: SpreeWeClient;
  @Input() allowCalls = true;
  @Input() allowRecording = true;

  active: Conversation | null = null;
  call: CallInfo | null = null;
  callDirection: 'incoming' | 'outgoing' = 'incoming';
  names: Record<string, string> = {};
  error = '';
  private offs: (() => void)[] = [];

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.offs.push(
      this.client.events.on('call.incoming', (c) => this.zone.run(() => {
        if (this.call) return; // already in a call: the ring is ignored here
        this.callDirection = 'incoming';
        this.call = c;
        void this.loadNames();
        this.cdr.markForCheck();
      })),
      this.client.events.on('error', (e) => this.zone.run(() => { this.error = e.message; this.cdr.markForCheck(); })),
    );
    void this.loadNames();
  }

  ngOnDestroy(): void {
    this.offs.forEach((f) => f());
  }

  async startCall(type: 'audio' | 'video'): Promise<void> {
    if (!this.active || this.call) return;
    try {
      const call = await this.client.calls.start(this.active.id, type);
      this.callDirection = 'outgoing';
      this.call = { ...call, initiatedBy: String(this.client.me?._id) };
    } catch (e: any) {
      this.error = e?.message || 'Call could not start';
    }
    this.cdr.markForCheck();
  }

  private async loadNames(): Promise<void> {
    try {
      for (const u of await this.client.users.directory()) this.names[String(u._id)] = nameOf(u);
      this.active?.members.forEach((u) => (this.names[String(u._id)] = nameOf(u)));
    } catch { /* names are cosmetic */ }
  }
}
