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
import { ChatUser, EditTarget, MessageDraft } from 'src/app/core/interfaces/chat';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { MAX_FILES_PER_SEND, UPLOAD_ACCEPT, validateUpload } from 'src/app/core/services/upload.service';

export interface PendingFile {
  file: File;
  previewUrl: string;
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'file';
}

export interface ReplyPreview {
  id: string;
  author: string;
  text: string;
}

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
  /** People who can be @mentioned (chat members except me). */
  @Input() mentionCandidates: ChatUser[] = [];
  /** Saves an edit; resolves true on success. Required for edit mode. */
  @Input() submitEdit?: (id: string, text: string, mentionIds: string[]) => Promise<boolean>;
  @Input() set editing(value: EditTarget | null) {
    this.editTarget = value;
    if (value) {
      this.text = value.text;
      this.mentioned = new Map(value.mentionIds
        .map((id) => this.mentionCandidates.find((c) => String(c._id) === String(id)))
        .filter((c): c is ChatUser => !!c)
        .map((c) => [String(c._id), c.username]));
      this.clearFile();
      this.focus();
      setTimeout(() => this.autoGrow());
    }
  }
  @Output() cancelReply = new EventEmitter<void>();
  @Output() cancelEdit = new EventEmitter<void>();
  @Output() typing = new EventEmitter<void>();
  /** ↑ in an empty composer */
  @Output() editLast = new EventEmitter<void>();

  @ViewChild('input', { static: true }) input!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileInput', { static: true }) fileInput!: ElementRef<HTMLInputElement>;

  readonly accept = UPLOAD_ACCEPT;
  text = '';
  files: PendingFile[] = [];
  sending = false;
  pickerOpen = false;
  pickerAnchor: HTMLElement | null = null;
  editTarget: EditTarget | null = null;

  /** @mention picker */
  mentionQuery: string | null = null;
  mentionOptions: ChatUser[] = [];
  mentionIndex = 0;
  /** id → username of people mentioned in this draft */
  private mentioned = new Map<string, string>();

  constructor(private cdr: ChangeDetectorRef, private alert: AlertService) {}

  ngOnDestroy(): void {
    this.files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
  }

  get canSend(): boolean {
    return !this.sending && (!!this.text.trim() || (!!this.files.length && !this.editTarget));
  }

  private kindOf(file: File): PendingFile['kind'] {
    const type = file.type || '';
    if (type.startsWith('image')) return 'image';
    if (type.startsWith('video')) return 'video';
    if (type.startsWith('audio')) return 'audio';
    if (type === 'application/pdf') return 'pdf';
    return 'file';
  }

  /** Add attachments (picker, paste, drag & drop). Invalid ones are reported and skipped. */
  addFiles(list: FileList | File[]): void {
    if (this.editTarget) {
      return;
    }
    const incoming = Array.from(list);
    const room = MAX_FILES_PER_SEND - this.files.length;
    if (incoming.length > room) {
      this.alert.warning(`You can send up to ${MAX_FILES_PER_SEND} files at a time.`);
    }
    const problems: string[] = [];
    for (const file of incoming.slice(0, Math.max(0, room))) {
      const problem = validateUpload(file);
      if (problem) {
        problems.push(problem);
        continue;
      }
      const kind = this.kindOf(file);
      this.files = [...this.files, { file, kind, previewUrl: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : '' }];
    }
    if (problems.length) {
      this.alert.warning(problems.length === 1 ? problems[0] : `${problems.length} files couldn't be added. ${problems[0]}`);
    }
    this.cdr.markForCheck();
    this.focus();
  }

  removeFile(item: PendingFile): void {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
    this.files = this.files.filter((f) => f !== item);
    this.cdr.markForCheck();
  }

  fileIcon(item: PendingFile): string {
    return fileIconFor(item.file.name, item.kind);
  }

  focus(): void {
    setTimeout(() => this.input.nativeElement.focus());
  }

  onInput(): void {
    this.autoGrow();
    this.updateMentionQuery();
    if (!this.editTarget) {
      this.typing.emit();
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (this.mentionQuery !== null && this.mentionOptions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.mentionIndex = (this.mentionIndex + step + this.mentionOptions.length) % this.mentionOptions.length;
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.pickMention(this.mentionOptions[this.mentionIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeMentions();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    } else if (event.key === 'Escape' && this.editTarget) {
      event.stopPropagation();
      this.exitEdit();
    } else if (event.key === 'Escape' && this.replyTo) {
      this.cancelReply.emit();
    } else if (event.key === 'ArrowUp' && !this.text && !this.editTarget) {
      // Like Teams: ↑ in an empty box edits your last message (handled by the chat page)
      this.editLast.emit();
    }
  }

  exitEdit(): void {
    this.editTarget = null;
    this.text = '';
    this.mentioned.clear();
    this.input.nativeElement.style.height = 'auto';
    this.cancelEdit.emit();
    this.cdr.markForCheck();
  }

  pickMention(user: ChatUser): void {
    const el = this.input.nativeElement;
    const caret = el.selectionStart ?? this.text.length;
    const before = this.text.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) {
      return;
    }
    const insert = `@${user.username} `;
    this.text = this.text.slice(0, at) + insert + this.text.slice(caret);
    this.mentioned.set(String(user._id), user.username);
    this.closeMentions();
    this.cdr.markForCheck();
    setTimeout(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = at + insert.length;
      this.autoGrow();
    });
  }

  closeMentions(): void {
    this.mentionQuery = null;
    this.mentionOptions = [];
    this.mentionIndex = 0;
  }

  private updateMentionQuery(): void {
    const el = this.input.nativeElement;
    const caret = el.selectionStart ?? this.text.length;
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(this.text.slice(0, caret));
    if (!match || !this.mentionCandidates.length) {
      this.closeMentions();
      return;
    }
    const q = match[2].toLowerCase();
    this.mentionQuery = q;
    this.mentionOptions = this.mentionCandidates
      .filter((c) => (c.username || '').toLowerCase().includes(q))
      .slice(0, 6);
    this.mentionIndex = 0;
  }

  /** Mentions whose @name is still in the text. */
  private currentMentionIds(): string[] {
    return [...this.mentioned.entries()]
      .filter(([, name]) => this.text.includes(`@${name}`))
      .map(([id]) => id);
  }

  async send(): Promise<void> {
    if (!this.canSend || !this.submit) {
      return;
    }
    this.sending = true;
    this.closeMentions();
    this.cdr.markForCheck();
    try {
      if (this.editTarget) {
        const target = this.editTarget;
        const ok = this.submitEdit ? await this.submitEdit(target.id, this.text, this.currentMentionIds()) : false;
        if (ok) {
          this.exitEdit();
        }
        return;
      }
      const files = this.files.map((f) => f.file);
      const ok = await this.submit({ text: this.text, file: files[0] || null, files, replyToId: this.replyTo?.id || null, mentionIds: this.currentMentionIds() });
      if (ok) {
        this.text = '';
        this.mentioned.clear();
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
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      this.addFiles(input.files);
    }
    input.value = '';
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
    const pasted: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) {
          pasted.push(file);
        }
      }
    }
    if (pasted.length) {
      event.preventDefault();
      this.addFiles(pasted);
    }
  }

  clearFile(): void {
    this.files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    this.files = [];
    if (this.fileInput) {
      this.fileInput.nativeElement.value = '';
    }
    this.cdr.markForCheck();
  }

  private autoGrow(): void {
    const el = this.input.nativeElement;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }
}

/** Font Awesome icon for a file name / kind (shared by the composer, messages and upload cards). */
export function fileIconFor(name: string, kind?: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (kind === 'image') return 'fa-file-image';
  if (kind === 'video') return 'fa-file-video';
  if (kind === 'audio') return 'fa-file-audio';
  if (kind === 'pdf' || ext === 'pdf') return 'fa-file-pdf';
  if (['doc', 'docx'].includes(ext)) return 'fa-file-word';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'fa-file-excel';
  if (['ppt', 'pptx'].includes(ext)) return 'fa-file-powerpoint';
  if (ext === 'zip') return 'fa-file-zipper';
  if (['txt', 'log', 'md'].includes(ext)) return 'fa-file-lines';
  return 'fa-file';
}
