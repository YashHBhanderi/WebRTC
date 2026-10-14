import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { ChosenStatus } from '../utils/presence.util';
import { AuthService } from './auth.service';
import { SocketService } from './socket.service';

/** No keyboard / pointer input for this long → Away (while the chosen status is Available). */
const IDLE_AFTER_MS = 5 * 60 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

export interface MyPresence {
  status: ChosenStatus;
  statusMessage: string;
}

/** My chosen status / status message, and automatic Away from local inactivity. */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  readonly mine$ = new BehaviorSubject<MyPresence>({ status: 'Available', statusMessage: '' });

  private subs = new Subscription();
  private started = false;
  private idle = false;
  private lastActivity = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onActivity = () => {
    this.lastActivity = Date.now();
    if (this.idle) {
      this.setIdle(false);
    }
  };

  constructor(private socket: SocketService, private auth: AuthService, private zone: NgZone) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const me = this.auth.getLoggedInUser();
    this.mine$.next({ status: (me?.status as ChosenStatus) || 'Available', statusMessage: me?.statusMessage || '' });

    // My status changed on another device
    this.subs.add(this.socket.onPresence().subscribe((data: any) => {
      if (String(data?.userId) === String(this.auth.getLoggedInUser()?._id) && data.ownStatus) {
        this.remember({ status: data.ownStatus, statusMessage: data.statusMessage || '' });
      }
    }));
    // Reconnected: the server reset automatic away
    this.subs.add(this.socket.onConnect().subscribe(() => {
      this.idle = false;
      this.lastActivity = Date.now();
    }));

    this.zone.runOutsideAngular(() => {
      ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, this.onActivity, { passive: true, capture: true }));
      this.timer = setInterval(() => {
        if (!this.idle && Date.now() - this.lastActivity >= IDLE_AFTER_MS) {
          this.setIdle(true);
        }
      }, 30_000);
    });
  }

  stop(): void {
    this.subs.unsubscribe();
    this.subs = new Subscription();
    ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, this.onActivity, { capture: true } as any));
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.idle = false;
  }

  get mine(): MyPresence {
    return this.mine$.value;
  }

  async setStatus(status: ChosenStatus): Promise<void> {
    await this.socket.request('presence:set', { status });
    this.remember({ ...this.mine, status });
  }

  async setStatusMessage(statusMessage: string): Promise<void> {
    await this.socket.request('presence:set', { statusMessage });
    this.remember({ ...this.mine, statusMessage: statusMessage.trim() });
  }

  private remember(value: MyPresence): void {
    this.zone.run(() => this.mine$.next(value));
    // Notifications read DND from the stored user
    this.auth.updateLoggedInUser({ status: value.status, statusMessage: value.statusMessage });
  }

  private setIdle(idle: boolean): void {
    this.idle = idle;
    this.socket.emitPresenceIdle(idle);
  }
}
