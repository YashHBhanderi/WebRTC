import { Injectable } from '@angular/core';

export interface PendingP2pOffer {
  from: string;
  offer: RTCSessionDescriptionInit;
  callType: 'audio' | 'video';
}

const KEY = 'pendingP2pCallOffer';

/** Hands off 1:1 SDP offer from chat Accept → video-call page. */
@Injectable({ providedIn: 'root' })
export class CallHandoffService {
  stash(offer: PendingP2pOffer): void {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(offer));
    } catch {
      // ignore
    }
  }

  take(): PendingP2pOffer | null {
    try {
      const raw = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
