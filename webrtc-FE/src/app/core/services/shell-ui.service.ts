import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Page → shell hints (e.g. a phone showing one conversation full screen hides the tab bar). */
@Injectable({ providedIn: 'root' })
export class ShellUiService {
  readonly immersive$ = new BehaviorSubject<boolean>(false);

  private pending: boolean | null = null;

  /** Deferred: pages call this during their change detection; the shell (a parent) updates next turn. */
  setImmersive(value: boolean): void {
    if (this.immersive$.value === value && this.pending === null) {
      return;
    }
    const scheduled = this.pending !== null;
    this.pending = value;
    if (!scheduled) {
      queueMicrotask(() => {
        const next = this.pending;
        this.pending = null;
        if (next !== null && next !== this.immersive$.value) {
          this.immersive$.next(next);
        }
      });
    }
  }
}
