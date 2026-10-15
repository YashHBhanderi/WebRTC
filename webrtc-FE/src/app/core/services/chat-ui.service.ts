import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const KEY = 'chat.ui.showLastMessage';

/**
 * Chat list appearance, remembered per browser. Off = name and a smaller avatar only.
 */
@Injectable({ providedIn: 'root' })
export class ChatUiService {
  readonly showLastMessage$ = new BehaviorSubject<boolean>(read());

  get showLastMessage(): boolean {
    return this.showLastMessage$.value;
  }

  setShowLastMessage(value: boolean): void {
    try {
      localStorage.setItem(KEY, value ? '1' : '0');
    } catch {
      // private mode / blocked storage: still applies for this session
    }
    this.showLastMessage$.next(value);
  }
}

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}
