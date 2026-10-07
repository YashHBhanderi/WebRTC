import { Injectable, NgZone } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { Subject } from 'rxjs';

export interface CallNotificationInfo {
  callId: string;
  callerName: string;
  callType: 'audio' | 'video';
  /** Absolute URL of the caller's picture, if any. */
  icon?: string;
}

export interface CallNotificationAction {
  callId: string;
  action: 'accept' | 'decline' | 'open';
}

const DISMISSED_KEY = 'callNotificationsPromptDismissed';

/**
 * System notification for an incoming person-to-person call while this tab is open but not in
 * front (another tab/app, minimized window, locked phone screen with the browser running).
 * Uses the service worker when there is one (needed on Android Chrome; adds Accept/Decline
 * buttons), otherwise the page-level Notification API (desktop browsers).
 * Limits: iOS shows web notifications only for apps added to the Home Screen; browsers do not
 * let pages choose the notification sound (the ringtone plays from the tab, see RingtoneService).
 */
@Injectable({ providedIn: 'root' })
export class CallNotificationService {
  readonly actions$ = new Subject<CallNotificationAction>();
  private shown = new Map<string, Notification>();

  constructor(private zone: NgZone, private swPush: SwPush) {
    if (this.swPush.isEnabled) {
      this.swPush.notificationClicks.subscribe(({ action, notification }) => {
        const callId = notification?.data?.callId;
        if (callId) {
          this.actions$.next({ callId, action: action === 'accept' || action === 'decline' ? action : 'open' });
        }
      });
    }
  }

  get supported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  get permission(): NotificationPermission | 'unsupported' {
    return this.supported ? Notification.permission : 'unsupported';
  }

  /** Must be called from a click/tap: browsers ignore permission requests without a user gesture. */
  async requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!this.supported) {
      return 'unsupported';
    }
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  get promptDismissed(): boolean {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  dismissPrompt(): void {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
  }

  /** Shown only when the page isn't in front; the in-app ringing card covers the visible case. */
  async showIncoming(call: CallNotificationInfo): Promise<void> {
    if (this.permission !== 'granted' || (document.visibilityState === 'visible' && document.hasFocus())) {
      return;
    }
    const title = call.callerName || 'Incoming call';
    const options: NotificationOptions & Record<string, unknown> = {
      body: call.callType === 'video' ? 'Incoming video call' : 'Incoming voice call',
      icon: call.icon || undefined,
      tag: `call-${call.callId}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [700, 300, 700, 300, 700],
      data: {
        callId: call.callId,
        // Angular service worker: focus the app on click / Accept; Decline works without focusing
        onActionClick: {
          default: { operation: 'focusLastFocusedOrOpen', url: '/chat' },
          accept: { operation: 'focusLastFocusedOrOpen', url: '/chat' },
        },
      },
    };

    const registration = await this.registration();
    if (registration) {
      try {
        await registration.showNotification(title, {
          ...options,
          actions: [
            { action: 'accept', title: 'Accept' },
            { action: 'decline', title: 'Decline' },
          ],
        } as NotificationOptions);
        return;
      } catch {
        // fall through to the page-level API
      }
    }
    try {
      const n = new Notification(title, options);
      n.onclick = () => this.zone.run(() => {
        window.focus();
        n.close();
        this.actions$.next({ callId: call.callId, action: 'open' });
      });
      this.shown.set(call.callId, n);
    } catch {
      // e.g. Android Chrome without a service worker: the in-app card + ringtone still work
    }
  }

  async close(callId: string): Promise<void> {
    this.shown.get(callId)?.close();
    this.shown.delete(callId);
    const registration = await this.registration();
    try {
      (await registration?.getNotifications({ tag: `call-${callId}` }))?.forEach((n) => n.close());
    } catch {
      // ignore
    }
  }

  private async registration(): Promise<ServiceWorkerRegistration | null> {
    try {
      return (await navigator.serviceWorker?.getRegistration()) || null;
    } catch {
      return null;
    }
  }
}
