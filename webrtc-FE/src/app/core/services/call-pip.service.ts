import { Injectable, NgZone } from '@angular/core';

export interface CallPipState {
  title: string;
  /** "Presenting", status ("Ringing…") or "In call". */
  status: string;
  muted: boolean;
  videoOn: boolean;
  stage: {
    stream: MediaStream | null;
    showVideo: boolean;
    name: string;
    initials: string;
    colors: { bg: string; fg: string };
  };
}

export interface CallPipHandlers {
  state: () => CallPipState;
  toggleMute: () => void;
  toggleVideo: () => void | Promise<void>;
  leave: () => void;
  /** The floating window was closed or the user went back to the app. */
  left: () => void;
}

const CARD_W = 480;
const CARD_H = 270;

/**
 * Floating call window using the W3C Picture-in-Picture API (a standard browser feature: no
 * library, no third-party branding). It stays above other apps on desktop and mobile where the
 * browser supports it (Chrome/Edge, Safari macOS/iOS, Chrome Android, Samsung Internet, Firefox 153+).
 *
 * The window shows video only: the main participant's camera, or a drawn card (initials, name,
 * status) when there is no video. Mute / camera / hang-up appear as the browser's own buttons
 * through Media Session where supported. Entering requires a user action: call enter()
 * synchronously inside a click handler (prepare() keeps the video ready beforehand).
 */
@Injectable({ providedIn: 'root' })
export class CallPipService {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private canvasStream: MediaStream | null = null;
  private handlers: CallPipHandlers | null = null;
  private shownSource: MediaStream | null = null;
  private cardKey = '';

  constructor(private zone: NgZone) {}

  get supported(): boolean {
    return typeof document !== 'undefined' && !!(document as any).pictureInPictureEnabled
      && typeof (HTMLVideoElement.prototype as any).requestPictureInPicture === 'function';
  }

  get isOpen(): boolean {
    return !!this.video && (document as any).pictureInPictureElement === this.video;
  }

  /** Attach to the call: the hidden video is kept playing so enter() works instantly in a click. */
  prepare(handlers: CallPipHandlers): void {
    if (!this.supported) {
      return;
    }
    const first = !this.handlers;
    this.handlers = handlers;
    this.ensureVideo();
    if (first) {
      this.bindMediaSession();
    }
    this.refresh();
  }

  /** Must be called synchronously from a click/tap (browsers require a user action). */
  enter(): Promise<boolean> {
    if (!this.supported || !this.video) {
      return Promise.resolve(false);
    }
    if (this.isOpen) {
      return Promise.resolve(true);
    }
    this.refresh();
    try {
      return (this.video as any).requestPictureInPicture().then(
        () => true,
        (error: any) => {
          console.warn('[pip] could not open:', error?.name || error);
          return false;
        },
      );
    } catch (error: any) {
      console.warn('[pip] could not open:', error?.name || error);
      return Promise.resolve(false);
    }
  }

  exit(): void {
    if (this.isOpen) {
      void (document as any).exitPictureInPicture?.().catch(() => undefined);
    }
  }

  /** Re-read the call state: who is shown, mute / camera for the browser's buttons. */
  refresh(): void {
    const video = this.video;
    const h = this.handlers;
    if (!video || !h) {
      return;
    }
    const s = h.state();
    const live = s.stage.showVideo && s.stage.stream && s.stage.stream.getVideoTracks().some((t) => t.readyState === 'live');
    if (live) {
      this.show(s.stage.stream!);
    } else {
      this.drawCard(s);
      this.show(this.canvasStream!);
    }
    const ms = (navigator as any).mediaSession;
    try {
      ms?.setMicrophoneActive?.(!s.muted);
      ms?.setCameraActive?.(s.videoOn);
    } catch {
      // not supported by this browser
    }
  }

  /** Call over: leave the floating window and free everything. */
  release(): void {
    this.exit();
    this.unbindMediaSession();
    this.handlers = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    this.canvasStream?.getTracks().forEach((t) => t.stop());
    this.canvasStream = null;
    this.canvas = null;
    this.shownSource = null;
    this.cardKey = '';
  }

  private ensureVideo(): void {
    if (this.video) {
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('aria-hidden', 'true');
    // In the DOM (Safari needs that) but not visible in the page
    Object.assign(video.style, { position: 'fixed', width: '2px', height: '2px', right: '0', bottom: '0', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(video);
    video.addEventListener('leavepictureinpicture', () => this.zone.run(() => this.handlers?.left()));
    this.video = video;
  }

  private show(source: MediaStream): void {
    if (!this.video || source === this.shownSource) {
      return;
    }
    this.shownSource = source;
    this.video.srcObject = source;
    void this.video.play().catch(() => undefined);
  }

  /** Card for audio calls / camera off. Only redrawn when its text changes. */
  private drawCard(s: CallPipState): void {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = CARD_W;
      this.canvas.height = CARD_H;
      this.canvasStream = (this.canvas as any).captureStream(0) as MediaStream;
    }
    const key = [s.stage.name, s.stage.initials, s.status, s.title, s.muted].join('|');
    if (key === this.cardKey) {
      return;
    }
    this.cardKey = key;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#121920';
    g.fillRect(0, 0, CARD_W, CARD_H);
    g.fillStyle = s.stage.colors.bg;
    g.beginPath();
    g.arc(CARD_W / 2, 104, 52, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = s.stage.colors.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '600 40px Inter, system-ui, sans-serif';
    g.fillText(s.stage.initials, CARD_W / 2, 106);
    g.fillStyle = '#f7f9fa';
    g.font = '600 24px Inter, system-ui, sans-serif';
    g.fillText(s.stage.name, CARD_W / 2, 190, CARD_W - 40);
    g.fillStyle = '#8a9dac';
    g.font = '18px Inter, system-ui, sans-serif';
    g.fillText(s.muted ? `${s.status} · You're muted` : s.status, CARD_W / 2, 224, CARD_W - 40);
    // captureStream(0): push exactly one frame per change (no timers, nothing to throttle)
    const track = this.canvasStream!.getVideoTracks()[0] as any;
    track?.requestFrame?.();
  }

  private bindMediaSession(): void {
    const ms = (navigator as any).mediaSession;
    if (!ms?.setActionHandler) {
      return;
    }
    const set = (action: string, fn: (() => void) | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // action not supported by this browser
      }
    };
    set('togglemicrophone', () => this.zone.run(() => { this.handlers?.toggleMute(); this.refresh(); }));
    set('togglecamera', () => this.zone.run(() => { void Promise.resolve(this.handlers?.toggleVideo()).then(() => this.refresh()); }));
    set('hangup', () => this.zone.run(() => this.handlers?.leave()));
    // Chrome 120+: may open the floating window automatically when the user switches tabs mid-call
    set('enterpictureinpicture', () => this.zone.run(() => void this.enter()));
  }

  private unbindMediaSession(): void {
    const ms = (navigator as any).mediaSession;
    for (const action of ['togglemicrophone', 'togglecamera', 'hangup', 'enterpictureinpicture']) {
      try {
        ms?.setActionHandler?.(action, null);
      } catch {
        // ignore
      }
    }
  }
}
