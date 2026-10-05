import { Directive, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';

/**
 * Binds a MediaStream to a <video>/<audio> element.
 * Only touches `srcObject` when the stream identity changes (re-assigning the
 * same stream restarts decoding and causes black flashes), and routes audio to
 * the selected speaker where `setSinkId` is supported.
 */
@Directive({ selector: 'video[appMediaSrc], audio[appMediaSrc]' })
export class MediaSrcDirective implements OnChanges, OnDestroy {
  @Input() appMediaSrc: MediaStream | null | undefined = null;
  /** Bump to force play() after tracks were added to the same stream */
  @Input() mediaKick = 0;
  @Input() sinkId = '';

  constructor(private el: ElementRef<HTMLMediaElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    const media = this.el.nativeElement;
    if (changes['appMediaSrc'] && media.srcObject !== (this.appMediaSrc || null)) {
      media.srcObject = this.appMediaSrc || null;
    }
    if (changes['sinkId'] && this.sinkId && 'setSinkId' in media) {
      (media as any).setSinkId(this.sinkId).catch(() => undefined);
    }
    if (this.appMediaSrc) {
      void media.play().catch(() => undefined);
    }
  }

  ngOnDestroy(): void {
    // Release the element's hold on tracks; the tracks themselves belong to the call
    this.el.nativeElement.srcObject = null;
  }
}
