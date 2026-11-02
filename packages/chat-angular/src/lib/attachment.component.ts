import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { Attachment } from '@spreewe/chat-sdk';
import { SPW_THEME } from './theme';

/** Downloads and decrypts an attachment on this device, then shows it (image / video / audio) or offers it as a file. */
@Component({
  selector: 'spw-attachment',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *ngIf="url; else pending">
      <img *ngIf="kind === 'image'" [src]="url" [alt]="attachment?.name" />
      <video *ngIf="kind === 'video'" [src]="url" controls></video>
      <audio *ngIf="kind === 'audio'" [src]="url" controls></audio>
      <a *ngIf="kind === 'file'" [href]="url" [attr.download]="attachment?.name">{{ attachment?.name }} ({{ size }})</a>
    </ng-container>
    <ng-template #pending>
      <span class="muted" *ngIf="!error">Decrypting {{ attachment?.name }}…</span>
      <span class="error" *ngIf="error">{{ error }}</span>
    </ng-template>
  `,
  styles: [SPW_THEME, `img, video { max-width: 280px; max-height: 240px; border-radius: var(--spw-radius); display: block; }`],
})
export class SpwAttachmentComponent implements OnChanges, OnDestroy {
  @Input() attachment: Attachment | undefined;
  url: string | null = null;
  error = '';

  constructor(private cdr: ChangeDetectorRef) {}

  get kind(): 'image' | 'video' | 'audio' | 'file' {
    const t = this.attachment?.mimeType || '';
    return t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : 'file';
  }

  get size(): string {
    const b = this.attachment?.size || 0;
    return b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  }

  async ngOnChanges(): Promise<void> {
    this.release();
    if (!this.attachment) return;
    try {
      this.url = URL.createObjectURL(await this.attachment.download());
    } catch {
      this.error = "This attachment couldn't be downloaded or decrypted.";
    }
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.release();
  }

  private release(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.error = '';
  }
}
