import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';
import { Subscription, firstValueFrom } from 'rxjs';
import { ChatMessage, MessageDraft } from 'src/app/core/interfaces/chat';
import { MessageSenderService } from 'src/app/core/services/message-sender.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { UserService } from 'src/app/core/services/user.service';
import { CallMember } from '../call.models';

const RECENT_MESSAGES = 40;

/** Chat of the meeting's conversation, inside the call (same messages as the main chat). */
@Component({
  selector: 'app-meeting-chat',
  template: `
    <aside class="mchat" aria-label="Meeting chat">
      <header class="mchat__header">
        <h3>Meeting chat</h3>
        <button type="button" class="mchat__close" (click)="close.emit()" aria-label="Close chat">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </header>
      <div class="mchat__list" #list>
        <div class="mchat__state" *ngIf="loading"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span></div>
        <div class="mchat__state" *ngIf="!loading && !messages.length">No messages yet</div>
        <ng-container *ngFor="let msg of messages; trackBy: trackById">
          <div class="mchat__notice" *ngIf="msg.type === 'call' || msg.type === 'system'">{{ msg.content }}</div>
          <app-message-item
            *ngIf="msg.type !== 'call' && msg.type !== 'system'"
            [message]="msg"
            [mine]="isMine(msg)"
            [isGroup]="isGroup"
            [first]="true"
            [senderName]="nameOf(msg)"
            [senderAvatar]="avatarOf(msg)"
            [compact]="true"
            [myUserId]="myUserId"
          ></app-message-item>
        </ng-container>
      </div>
      <app-message-composer [submit]="sendDraft" [compact]="true" placeholder="Message everyone"></app-message-composer>
    </aside>
  `,
  styles: [`
    :host { display: block; height: 100%; min-height: 0; }
    .mchat {
      height: 100%;
      display: flex;
      flex-direction: column;
      border-radius: var(--call-radius, 14px);
      overflow: hidden;
      background: var(--app-chat-bg, #eef1f5);
      color: var(--app-text, #111827);
    }
    .mchat__header {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 8px 10px 16px;
      background: var(--app-surface, #fff);
      border-bottom: 1px solid var(--app-border, #e4e7ec);
    }
    .mchat__header h3 { margin: 0; font-size: 1rem; font-weight: 600; }
    .mchat__close {
      width: 36px; height: 36px; border: 0; border-radius: 50%;
      background: transparent; color: var(--app-icon, #54656f);
    }
    .mchat__close:hover { background: var(--app-hover, #f2f4f7); }
    .mchat__list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 12px; }
    .mchat__state { padding: 24px; text-align: center; color: var(--app-muted, #6b7280); font-size: 0.85rem; }
    .mchat__notice {
      margin: 8px auto; width: fit-content; max-width: 100%;
      padding: 3px 10px; border-radius: 8px;
      background: var(--app-surface, #fff); color: var(--app-text-2, #4b5563);
      font-size: 0.75rem; text-align: center;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MeetingChatComponent implements OnInit, OnDestroy {
  @Input() conversationId = '';
  @Input() myUserId = '';
  @Input() isGroup = true;
  @Input() members: CallMember[] = [];
  @Output() close = new EventEmitter<void>();

  @ViewChild('list', { static: true }) list!: ElementRef<HTMLElement>;

  messages: ChatMessage[] = [];
  loading = true;
  readonly sendDraft = (draft: MessageDraft) => this.send(draft);
  private sub?: Subscription;
  private seen = new Set<string>();

  constructor(
    private users: UserService,
    private socket: SocketService,
    private sender: MessageSenderService,
    private cdr: ChangeDetectorRef,
  ) {}

  async ngOnInit(): Promise<void> {
    this.socket.joinConversation(this.conversationId);
    this.sub = this.socket.newMessageReceived().subscribe((data: any) => {
      if (String(data?.conversationId) !== this.conversationId || !data?._id || this.seen.has(data._id)) {
        return;
      }
      this.seen.add(data._id);
      this.messages = [...this.messages, data];
      this.scrollToEnd();
    });
    try {
      const res = await firstValueFrom(this.users.getMessages(this.conversationId, 1, RECENT_MESSAGES));
      const loaded: ChatMessage[] = res.data || [];
      loaded.forEach((m) => this.seen.add(m._id));
      // Keep anything that arrived while loading
      this.messages = [...loaded, ...this.messages.filter((m) => !loaded.some((l) => l._id === m._id))];
    } catch {
      // interceptor shows the error
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
      this.scrollToEnd();
    }
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  isMine(msg: ChatMessage): boolean {
    return String(msg.user?._id || msg.userId) === this.myUserId;
  }

  nameOf(msg: ChatMessage): string {
    if (this.isMine(msg)) {
      return 'You';
    }
    const id = String(msg.user?._id || msg.userId);
    return msg.user?.username || this.members.find((m) => String(m._id) === id)?.username || 'Participant';
  }

  avatarOf(msg: ChatMessage): string | undefined {
    const id = String(msg.user?._id || msg.userId);
    return msg.user?.avatar || this.members.find((m) => String(m._id) === id)?.avatar;
  }

  trackById(_: number, m: ChatMessage): string {
    return m._id;
  }

  private async send(draft: MessageDraft): Promise<boolean> {
    try {
      await this.sender.send(this.conversationId, draft);
      return true;
    } catch {
      return false;
    }
  }

  private scrollToEnd(): void {
    this.cdr.markForCheck();
    setTimeout(() => {
      const el = this.list.nativeElement;
      el.scrollTop = el.scrollHeight;
    });
  }
}
