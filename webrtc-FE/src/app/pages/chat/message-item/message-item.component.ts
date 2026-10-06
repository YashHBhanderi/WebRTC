import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { CHAT_CONFIG, ChatConfig } from 'src/app/core/config/chat.config';
import { ChatMessage, messageHasText } from 'src/app/core/interfaces/chat';

export interface MediaOpenEvent {
  url: string;
  type: string;
}

/**
 * One chat message: sender avatar, bubble (quote, media, text with Read more), reactions,
 * a hover action strip (quick reactions, full picker, reply, menu), a side reply button,
 * swipe-to-reply and long-press for touch.
 */
@Component({
  selector: 'app-message-item',
  templateUrl: './message-item.component.html',
  styleUrls: ['./message-item.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageItemComponent implements OnInit, OnChanges, OnDestroy {
  @Input() message!: ChatMessage;
  @Input() mine = false;
  @Input() isGroup = false;
  /** First bubble of a run from the same sender (shows the name in groups, bubble tail). */
  @Input() first = true;
  @Input() senderName = '';
  @Input() senderAvatar: string | undefined = '';
  @Input() replyAuthor = '';
  /** 1:1 chats: sent/seen ticks on own messages. */
  @Input() showTicks = false;
  @Input() highlighted = false;
  @Input() searchHit = false;
  @Input() searchTerm = '';
  /** Read-only rendering (meeting chat panel): no strip, no reply, no swipe. */
  @Input() compact = false;
  @Input() myUserId = '';

  @Output() reply = new EventEmitter<ChatMessage>();
  @Output() react = new EventEmitter<string>();
  @Output() copy = new EventEmitter<ChatMessage>();
  @Output() forward = new EventEmitter<ChatMessage>();
  @Output() remove = new EventEmitter<ChatMessage>();
  @Output() quoteClick = new EventEmitter<string>();
  @Output() avatarClick = new EventEmitter<string>();
  @Output() openMedia = new EventEmitter<MediaOpenEvent>();

  @ViewChild('bubble', { static: true }) bubble!: ElementRef<HTMLElement>;
  @ViewChild('swipeIcon', { static: true }) swipeIcon!: ElementRef<HTMLElement>;

  readonly quickReactions: string[];
  readonly readMoreChars: number;

  expanded = false;
  stripBelow = false;
  /** Strip forced visible: long-press on touch, menu or picker open. */
  stripPinned = false;
  menuOpen = false;
  pickerOpen = false;
  pickerAnchor: HTMLElement | null = null;

  private touchCleanup: (() => void) | null = null;
  private dismissCleanup: (() => void) | null = null;

  constructor(
    @Inject(CHAT_CONFIG) config: ChatConfig,
    private host: ElementRef<HTMLElement>,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    this.quickReactions = config.quickReactions.slice(0, 4);
    this.readMoreChars = config.readMoreChars;
  }

  ngOnInit(): void {
    if (!this.compact) {
      this.bindSwipe();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    // A search match hidden behind "Read more" must be visible when jumped to
    if ((changes['searchHit'] || changes['searchTerm']) && this.searchHit && this.isLong && this.searchTerm) {
      const index = (this.message.content || '').toLowerCase().indexOf(this.searchTerm.trim().toLowerCase());
      if (index >= this.readMoreChars - 20) {
        this.expanded = true;
      }
    }
  }

  ngOnDestroy(): void {
    this.touchCleanup?.();
    this.dismissCleanup?.();
  }

  get hasText(): boolean {
    return messageHasText(this.message);
  }

  get isLong(): boolean {
    return (this.message.content || '').length > this.readMoreChars;
  }

  get visibleText(): string {
    const text = this.message.content || '';
    return this.isLong && !this.expanded ? `${text.slice(0, this.readMoreChars).trimEnd()}…` : text;
  }

  get senderId(): string {
    return String(this.message.user?._id || this.message.userId || '');
  }

  get reactions(): { emoji: string; count: number; mine: boolean }[] {
    const list = this.message.reactions || [];
    const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const r of list) {
      const entry = byEmoji.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      entry.count++;
      entry.mine = entry.mine || String(r.userId) === this.myUserId;
      byEmoji.set(r.emoji, entry);
    }
    return [...byEmoji.values()];
  }

  get quoteText(): string {
    const reply = this.message.replyTo;
    if (!reply) {
      return '';
    }
    return reply.type === 'text' || !reply.type ? reply.content : reply.type.charAt(0).toUpperCase() + reply.type.slice(1);
  }

  toggleExpanded(event: Event): void {
    event.stopPropagation();
    this.expanded = !this.expanded;
  }

  /** Flip the strip below the bubble when there is no room above it in the scroll area. */
  onHover(): void {
    if (this.compact) {
      return;
    }
    const scroller = this.host.nativeElement.closest('.messages, .mchat__list') as HTMLElement | null;
    const top = this.bubble.nativeElement.getBoundingClientRect().top;
    const limit = (scroller?.getBoundingClientRect().top ?? 0) + 52;
    const below = top < limit;
    if (below !== this.stripBelow) {
      this.stripBelow = below;
      this.cdr.markForCheck();
    }
  }

  onLongPress(): void {
    if (this.compact) {
      return;
    }
    this.onHover();
    this.stripPinned = true;
    this.listenForDismiss();
    this.cdr.markForCheck();
  }

  /** While a long-press strip is open, a tap anywhere else closes it (listener only exists then). */
  private listenForDismiss(): void {
    this.dismissCleanup?.();
    const handler = (event: Event) => {
      if (this.menuOpen || this.pickerOpen || this.host.nativeElement.contains(event.target as Node)) {
        return;
      }
      this.zone.run(() => {
        this.stripPinned = false;
        this.cdr.markForCheck();
      });
      this.dismissCleanup?.();
    };
    this.zone.runOutsideAngular(() => {
      document.addEventListener('touchstart', handler, { capture: true, passive: true });
      document.addEventListener('mousedown', handler, { capture: true });
    });
    this.dismissCleanup = () => {
      document.removeEventListener('touchstart', handler, { capture: true } as any);
      document.removeEventListener('mousedown', handler, { capture: true } as any);
      this.dismissCleanup = null;
    };
  }

  sendReaction(emoji: string): void {
    this.react.emit(emoji);
    this.stripPinned = false;
  }

  openPicker(anchor: HTMLElement): void {
    this.pickerAnchor = anchor;
    this.pickerOpen = true;
  }

  onPicked(emoji: string): void {
    this.pickerOpen = false;
    this.stripPinned = false;
    this.react.emit(emoji);
  }

  closePicker(): void {
    this.pickerOpen = false;
  }

  onMenuOpenChange(open: boolean): void {
    this.menuOpen = open;
    if (!open) {
      this.stripPinned = false;
    }
  }

  onReply(): void {
    this.stripPinned = false;
    this.reply.emit(this.message);
  }

  openFile(type: string): void {
    if (this.message.fileUrl) {
      this.openMedia.emit({ url: this.message.fileUrl, type });
    }
  }

  fileName(): string {
    if (this.message.fileName) {
      return this.message.fileName;
    }
    // Legacy links: last path segment, without a query string
    return decodeURIComponent((this.message.fileUrl || '').split('?')[0].split('/').pop() || 'Document');
  }

  /** Touch: drag the bubble right to reply (WhatsApp-style), with a horizontal reply cue. */
  private bindSwipe(): void {
    const el = this.bubble.nativeElement;
    const icon = this.swipeIcon.nativeElement;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let active = false;
    const reset = () => {
      el.style.transition = 'transform 0.18s ease';
      el.style.transform = '';
      icon.style.opacity = '0';
      icon.style.transform = 'translateY(-50%) scale(0.6)';
      dx = 0;
      active = false;
    };
    const start = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      active = false;
      el.style.transition = '';
    };
    const move = (e: TouchEvent) => {
      const x = e.touches[0].clientX - startX;
      const y = e.touches[0].clientY - startY;
      if (!active && (Math.abs(y) > 12 || x < 8)) {
        return;
      }
      if (!active && x > Math.abs(y)) {
        active = true;
      }
      if (active) {
        dx = Math.min(Math.max(x, 0), 76);
        el.style.transform = `translateX(${dx}px)`;
        const progress = Math.min(dx / 56, 1);
        icon.style.opacity = String(progress);
        icon.style.transform = `translateY(-50%) scale(${0.6 + progress * 0.4})`;
      }
    };
    const end = () => {
      if (active && dx >= 56) {
        this.zone.run(() => this.onReply());
      }
      reset();
    };
    this.zone.runOutsideAngular(() => {
      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchmove', move, { passive: true });
      el.addEventListener('touchend', end, { passive: true });
      el.addEventListener('touchcancel', reset, { passive: true });
    });
    this.touchCleanup = () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', reset);
    };
  }
}
