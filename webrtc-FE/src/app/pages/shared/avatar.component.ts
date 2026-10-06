import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';

/** Image URLs that already failed once — never retried, so broken avatars don't refetch per row. */
const failedSources = new Set<string>();

/**
 * Profile / group picture with a letter fallback and optional online dot.
 * Identical URLs are served from the browser cache; images load lazily off-screen.
 */
@Component({
  selector: 'app-avatar',
  template: `
    <span class="av" [style.width.px]="size" [style.height.px]="size" [style.font-size.px]="size * 0.4">
      <img
        *ngIf="src && !failed; else letter"
        [src]="src"
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

  get initial(): string {
    return (this.name || '?').trim().charAt(0) || '?';
  }

  ngOnChanges(): void {
    this.failed = !!this.src && failedSources.has(this.src);
  }

  onError(): void {
    if (this.src) {
      failedSources.add(this.src);
    }
    this.failed = true;
  }
}
