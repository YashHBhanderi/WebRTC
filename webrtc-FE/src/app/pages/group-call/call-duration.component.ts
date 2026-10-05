import { ChangeDetectionStrategy, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy } from '@angular/core';

/**
 * mm:ss / h:mm:ss since `startedAt`. Ticks outside Angular and writes the DOM
 * directly, so a running call does not trigger app-wide change detection every second.
 */
@Component({
  selector: 'app-call-duration',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallDurationComponent implements OnChanges, OnDestroy {
  @Input() startedAt: number | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnChanges(): void {
    this.stop();
    this.render();
    if (this.startedAt) {
      this.zone.runOutsideAngular(() => {
        this.timer = setInterval(() => this.render(), 1000);
      });
    }
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private render(): void {
    if (!this.startedAt) {
      this.el.nativeElement.textContent = '';
      return;
    }
    const total = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    this.el.nativeElement.textContent = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
}
