import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';

export interface IncomingCall {
  callId: string;
  groupId: string;
  callType: 'audio' | 'video';
  isGroup: boolean;
  callerId: string;
  callerName: string;
  avatar?: string;
  groupName?: string;
}

/** Ringing screen for an incoming call. Plays a synthesized ring (no asset) and vibrates on phones. */
@Component({
  selector: 'app-incoming-call',
  templateUrl: './incoming-call.component.html',
  styleUrls: ['./incoming-call.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncomingCallComponent implements OnInit, OnDestroy {
  @Input() call!: IncomingCall;
  @Output() accept = new EventEmitter<void>();
  @Output() decline = new EventEmitter<void>();

  private audioCtx: AudioContext | null = null;
  private ringTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private zone: NgZone) {}

  get title(): string {
    return this.call.isGroup ? this.call.groupName || 'Group call' : this.call.callerName;
  }

  get subtitle(): string {
    const kind = this.call.callType === 'video' ? 'video' : 'voice';
    return this.call.isGroup ? `${this.call.callerName} is calling · ${kind}` : `Incoming ${kind} call`;
  }

  get initial(): string {
    return (this.title || '?').charAt(0).toUpperCase();
  }

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      this.ring();
      this.ringTimer = setInterval(() => this.ring(), 3000);
    });
  }

  ngOnDestroy(): void {
    if (this.ringTimer) {
      clearInterval(this.ringTimer);
    }
    try {
      navigator.vibrate?.(0);
    } catch {
      // ignore
    }
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }

  /** Two short tones. Browsers may block audio before any user gesture; that's fine. */
  private ring(): void {
    try {
      navigator.vibrate?.([400, 200, 400]);
    } catch {
      // ignore
    }
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) {
        return;
      }
      this.audioCtx = this.audioCtx || new Ctx();
      const ctx = this.audioCtx!;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
      [0, 0.45].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0, ctx.currentTime + offset);
        gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + offset + 0.03);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + offset + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.4);
      });
    } catch {
      // ignore
    }
  }
}
