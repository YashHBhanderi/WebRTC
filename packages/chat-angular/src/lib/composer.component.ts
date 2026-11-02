import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ChatMessage, SpreeWeClient } from '@spreewe/chat-sdk';
import { SPW_THEME } from './theme';

/** Message composer: text, attachment, reply / edit mode, typing indicator. Everything is encrypted by the SDK before it leaves the device. */
@Component({
  selector: 'spw-composer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ctx" *ngIf="replyTo || editing">
      <span class="muted">{{ editing ? 'Editing message' : 'Replying to: ' + (replyTo?.text || 'message') }}</span>
      <button type="button" (click)="cancel.emit()" aria-label="Cancel">✕</button>
    </div>
    <form (ngSubmit)="submit()">
      <label class="attach" *ngIf="!editing" [attr.aria-label]="'Attach a file'">📎<input type="file" (change)="pick($event)" hidden /></label>
      <input [(ngModel)]="text" name="text" [placeholder]="placeholder" autocomplete="off" (input)="onTyping()" [disabled]="busy" />
      <button class="primary" type="submit" [disabled]="busy || (!text.trim() && !file)">{{ editing ? 'Save' : 'Send' }}</button>
    </form>
    <div class="file" *ngIf="file">{{ file.name }} <button type="button" (click)="file = null">Remove</button></div>
    <div class="error" *ngIf="error" role="alert">{{ error }}</div>
  `,
  styles: [SPW_THEME, `
    :host { display: block; border-top: 1px solid var(--spw-border); padding: 8px; background: var(--spw-bg); }
    form { display: flex; gap: 6px; align-items: center; }
    form input[name=text] { flex: 1; }
    .attach { cursor: pointer; padding: 4px 6px; }
    .ctx, .file { display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding: 0 0 6px; gap: 8px; }
  `],
})
export class SpwComposerComponent {
  @Input() client!: SpreeWeClient;
  @Input() conversationId = '';
  @Input() replyTo: ChatMessage | null = null;
  /** Message being edited (its text is preloaded) */
  @Input() set editing(m: ChatMessage | null) {
    this.editing_ = m;
    if (m) this.text = m.text;
  }
  get editing(): ChatMessage | null { return this.editing_; }
  @Input() placeholder = 'Write an encrypted message';
  @Output() sent = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  text = '';
  file: File | null = null;
  busy = false;
  error = '';
  private editing_: ChatMessage | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  pick(e: Event): void {
    this.file = (e.target as HTMLInputElement).files?.[0] || null;
  }

  onTyping(): void {
    if (!this.conversationId) return;
    if (!this.typingTimer) this.client.chat.typing(this.conversationId, true);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.client.chat.typing(this.conversationId, false);
      this.typingTimer = null;
    }, 2500);
  }

  async submit(): Promise<void> {
    const text = this.text.trim();
    if (!this.conversationId || (!text && !this.file)) return;
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      if (this.editing_) await this.client.messages.edit(this.conversationId, this.editing_.id, text);
      else if (this.file) await this.client.files.sendAttachment(this.conversationId, this.file, text);
      else await this.client.messages.send(this.conversationId, text, { replyTo: this.replyTo?.id });
      this.text = '';
      this.file = null;
      this.client.chat.typing(this.conversationId, false);
      this.sent.emit();
    } catch (e: any) {
      this.error = e?.message || 'Not sent';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
