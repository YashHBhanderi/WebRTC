import { Directive, ElementRef, EventEmitter, NgZone, OnDestroy, OnInit, Output } from '@angular/core';

/**
 * Touch long-press (≈450 ms without moving) and desktop right-click → `appLongPress`.
 * Used to open the message menu on phones, where there is no hover state.
 */
@Directive({ selector: '[appLongPress]' })
export class LongPressDirective implements OnInit, OnDestroy {
  @Output() appLongPress = new EventEmitter<void>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private startX = 0;
  private startY = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnInit(): void {
    const node = this.el.nativeElement;
    const listen = (type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      node.addEventListener(type, fn, opts);
      this.cleanups.push(() => node.removeEventListener(type, fn, opts));
    };
    this.zone.runOutsideAngular(() => {
      listen('touchstart', (e: TouchEvent) => {
        const t = e.touches[0];
        this.startX = t.clientX;
        this.startY = t.clientY;
        this.clear();
        this.timer = setTimeout(() => this.fire(), 450);
      }, { passive: true });
      listen('touchmove', (e: TouchEvent) => {
        const t = e.touches[0];
        if (Math.abs(t.clientX - this.startX) > 10 || Math.abs(t.clientY - this.startY) > 10) {
          this.clear();
        }
      }, { passive: true });
      listen('touchend', () => this.clear(), { passive: true });
      listen('touchcancel', () => this.clear(), { passive: true });
      listen('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        this.clear();
        this.fire();
      });
    });
  }

  ngOnDestroy(): void {
    this.clear();
    this.cleanups.forEach((fn) => fn());
  }

  private fire(): void {
    this.timer = null;
    try {
      navigator.vibrate?.(15);
    } catch {
      // ignore
    }
    this.zone.run(() => this.appLongPress.emit());
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
