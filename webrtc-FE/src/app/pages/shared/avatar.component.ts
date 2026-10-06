import { NgIf } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { avatarColors, avatarInitials } from 'src/app/core/utils/avatar.util';
import { mediaUrl } from 'src/app/core/utils/media-url.util';

/** Image URLs that already failed once — never retried, so broken avatars don't refetch per row. */
const failedSources = new Set<string>();

/**
 * Profile / group picture with an optional online dot. `src` is an S3 key, a full URL or a local
 * preview. Without a picture (or if it fails to load) it shows a generated avatar: initials on a
 * colour derived from the name.
 * Identical URLs are served from the browser cache; images load lazily off-screen.
 */
@Component({
  selector: 'app-avatar',
  standalone: true,
  imports: [NgIf],
  template: `
    <span
      class="av"
      [style.width.px]="size"
      [style.height.px]="size"
      [style.font-size.px]="size * (initial.length > 1 ? 0.36 : 0.42)"
      [style.background]="showImage ? null : colors.bg"
      [style.color]="showImage ? null : colors.fg"
    >
      <img
        *ngIf="showImage; else letter"
        [src]="url"
        alt=""
        loading="lazy"
        decoding="async"
        (error)="onError()"
      />
      <ng-template #letter><span class="av__letter" aria-hidden="true">{{ initial }}</span></ng-template>
      <span class="av__dot" *ngIf="online" aria-label="Online"></span>
    </span>
  `,
  styles: [`
    :host { display: inline-flex; flex: none; }
    .av {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--app-avatar-bg, #dbeafe);
      color: var(--app-brand-strong, #1d4ed8);
      font-weight: 600;
      text-transform: uppercase;
      user-select: none;
    }
    img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
    .av__dot {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 28%;
      height: 28%;
      min-width: 9px;
      min-height: 9px;
      border-radius: 50%;
      background: var(--app-success, #16a34a);
      border: 2px solid var(--app-surface, #fff);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AvatarComponent implements OnChanges {
  @Input() src: string | null | undefined = '';
  @Input() name: string | null | undefined = '';
  @Input() size = 40;
  @Input() online = false;

  failed = false;
  url = '';

  get showImage(): boolean {
    return !!this.url && !this.failed;
  }

  get initial(): string {
    return avatarInitials(this.name);
  }

  get colors() {
    return avatarColors(this.name);
  }

  ngOnChanges(): void {
    this.url = mediaUrl(this.src);
    this.failed = !!this.url && failedSources.has(this.url);
  }

  onError(): void {
    if (this.url) {
      failedSources.add(this.url);
    }
    this.failed = true;
  }
}
