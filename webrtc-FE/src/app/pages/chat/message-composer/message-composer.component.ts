import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { MessageDraft } from 'src/app/core/interfaces/chat';
import { AlertService } from 'src/app/_shared/alert/alert.service';

export interface ReplyPreview {
  id: string;
  author: string;
  text: string;
}

const ALLOWED_FILE = /^(image|video|audio)\/|^application\/pdf$/;
/** Mirrors the server's per-type limits (webrtc-BE file.service MEDIA_RULES) for early feedback. */
const MAX_FILE_MB: Record<string, number> = { image: 10, video: 100, audio: 25, application: 25 };
const FILE_LABEL: Record<string, string> = { image: 'Photos', video: 'Videos', audio: 'Audio files', application: 'PDF files' };

/**
 * Message input: emoji picker, attachment (with preview), reply preview, Enter to send.
 * `submit` performs the actual send and resolves true on success (the draft is then cleared).
 */
@Component({
  selector: 'app-message-composer',
  templateUrl: './message-composer.component.html',
  styleUrls: ['./message-composer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageComposerComponent implements OnDestroy {
  @Input() submit!: (draft: MessageDraft) => Promise<boolean>;
  @Input() replyTo: ReplyPreview | null = null;
  @Input() placeholder = 'Type a message';
  /** Accept files pasted anywhere on the page (main chat) rather than only into the box. */
  @Input() pasteFromDocument = false;
  @Input() compact = false;
  @Output() cancelReply = new EventEmitter<void>();
  @Output() typing = new EventEmitter<void>();

  @ViewChild('input', { static: true }) input!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileInput', { static: true }) fileInput!: ElementRef<HTMLInputElement>;

  text = '';
  file: File | null = null;
  filePreviewUrl = '';
  sending = false;
  pickerOpen = false;
  pickerAnchor: HTMLElement | null = null;

  constructor(private cdr: ChangeDetectorRef, private alert: AlertService) {}

  ngOnDestroy(): void {
    this.revokePreview();
  }

  get canSend(): boolean {
    return !this.sending && (!!this.text.trim() || !!this.file);
  }

  get fileKind(): 'image' | 'video' | 'audio' | 'pdf' | 'file' {
    const type = this.file?.type || '';
    if (type.startsWith('image')) return 'image';
    if (type.startsWith('video')) return 'video';
    if (type.startsWith('audio')) return 'audio';
    if (type === 'application/pdf') return 'pdf';
    return 'file';
  }

  focus(): void {
    setTimeout(() => this.input.nativeElement.focus());
  }

  onInput(): void {
    this.autoGrow();
    this.typing.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    } else if (event.key === 'Escape' && this.replyTo) {
      this.cancelReply.emit();
    }
  }

  async send(): Promise<void> {
    if (!this.canSend || !this.submit) {
      return;
    }
    this.sending = true;
    this.cdr.markForCheck();
    try {
      const ok = await this.submit({ text: this.text, file: this.file, replyToId: this.replyTo?.id || null });
      if (ok) {
        this.text = '';
        this.clearFile();
        this.input.nativeElement.style.height = 'auto';
      }
    } finally {
      this.sending = false;
      this.cdr.markForCheck();
      this.focus();
    }
  }

  openPicker(anchor: HTMLElement): void {
    this.pickerAnchor = anchor;
    this.pickerOpen = !this.pickerOpen;
  }

  /** Insert at the caret, keeping the caret after the emoji. */
  insertEmoji(emoji: string): void {
    const el = this.input.nativeElement;
    const start = el.selectionStart ?? this.text.length;
    const end = el.selectionEnd ?? this.text.length;
    this.text = this.text.slice(0, start) + emoji + this.text.slice(end);
    this.cdr.markForCheck();
    setTimeout(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
      this.autoGrow();
    });
  }

  onFileChosen(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      this.setFile(file);
    }
  }

  @HostListener('document:paste', ['$event'])
  onDocumentPaste(event: ClipboardEvent): void {
    const fromBox = event.target === this.input.nativeElement;
    const target = event.target as HTMLElement | null;
    const otherField = !fromBox && !!target?.closest('input, textarea, [contenteditable="true"]');
    if ((!this.pasteFromDocument && !fromBox) || otherField) {
      return;
    }
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) {
          event.preventDefault();
          this.setFile(file);
          return;
        }
      }
    }
  }

  clearFile(): void {
    this.revokePreview();
    this.file = null;
    this.fileInput.nativeElement.value = '';
    this.cdr.markForCheck();
  }

  private setFile(file: File): void {
    if (!ALLOWED_FILE.test(file.type)) {
      this.alert.warning('You can send photos, videos, audio and PDF files.');
      return;
    }
    const family = file.type.split('/')[0];
    const maxMb = MAX_FILE_MB[family] ?? 25;
    if (file.size > maxMb * 1024 * 1024) {
      this.alert.warning(`${FILE_LABEL[family] || 'Files'} up to ${maxMb} MB can be sent.`);
      return;
    }
    this.revokePreview();
    this.file = file;
    this.filePreviewUrl = URL.createObjectURL(file);
    this.cdr.markForCheck();
  }

  private revokePreview(): void {
    if (this.filePreviewUrl) {
      URL.revokeObjectURL(this.filePreviewUrl);
      this.filePreviewUrl = '';
    }
  }

  private autoGrow(): void {
    const el = this.input.nativeElement;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }
}
