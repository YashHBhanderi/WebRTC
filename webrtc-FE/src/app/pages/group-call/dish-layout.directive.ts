import { Directive, ElementRef, Input, NgZone, OnChanges, OnDestroy, OnInit } from '@angular/core';

/**
 * Gallery sizing in the spirit of "Videoconference Dish": find the largest 16:9 tile that lets
 * `count` tiles fit the container, and expose it as --dish-w / --dish-h. Recomputed on resize,
 * outside Angular (no change detection per frame).
 */
@Directive({ selector: '[appDishLayout]' })
export class DishLayoutDirective implements OnInit, OnChanges, OnDestroy {
  @Input('appDishLayout') count = 1;
  @Input() dishGap = 10;
  @Input() dishRatio = 9 / 16;

  private observer: ResizeObserver | null = null;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.el.nativeElement);
    });
  }

  ngOnChanges(): void {
    this.layout();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private layout(): void {
    const host = this.el.nativeElement;
    const width = host.clientWidth;
    const height = host.clientHeight;
    const n = Math.max(1, this.count);
    if (!width || !height) {
      return;
    }
    const fits = (w: number) => {
      const cols = Math.max(1, Math.floor((width + this.dishGap) / (w + this.dishGap)));
      const rows = Math.ceil(n / cols);
      return rows * (w * this.dishRatio) + (rows - 1) * this.dishGap <= height;
    };
    // Binary search the largest tile width that fits
    let lo = 40;
    let hi = width;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    host.style.setProperty('--dish-w', `${lo}px`);
    host.style.setProperty('--dish-h', `${Math.floor(lo * this.dishRatio)}px`);
  }
}
