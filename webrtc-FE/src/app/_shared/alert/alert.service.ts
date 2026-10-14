import { Injectable, NgZone } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { BehaviorSubject } from 'rxjs';
import { ConfirmationDialogComponent } from '../dialog/confirmation-dialog/confirmation-dialog.component';
import { isSilentError, normalizeError } from 'src/app/core/errors/app-error';

export type ToastSeverity = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  handler: () => void;
}

export interface ToastOptions {
  title?: string;
  action?: ToastAction;
  /** ms; 0 keeps the toast until dismissed. Defaults depend on severity. */
  duration?: number;
}

export interface Toast {
  id: number;
  severity: ToastSeverity;
  title?: string;
  message: string;
  action?: ToastAction;
  /** How many identical toasts were merged into this one. */
  count: number;
}

export interface ConfirmOptions {
  title: string;
  text?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION: Record<ToastSeverity, number> = { success: 3000, info: 4000, warning: 6000, error: 7000 };

/**
 * Application-wide notifications: non-blocking bottom-right toasts (rendered by <app-toast-host>)
 * and confirmation dialogs. Identical visible toasts are merged instead of stacked.
 */
@Injectable({
  providedIn: 'root'
})
export class AlertService {
  private readonly toastsSubject = new BehaviorSubject<Toast[]>([]);
  readonly toasts$ = this.toastsSubject.asObservable();

  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private modal: NgbModal, private zone: NgZone) {}

  success(message: string, options?: ToastOptions): number {
    return this.show('success', message, options);
  }

  error(message: string, options?: ToastOptions): number {
    return this.show('error', message, options);
  }

  warning(message: string, options?: ToastOptions): number {
    return this.show('warning', message, options);
  }

  info(message: string, options?: ToastOptions): number {
    return this.show('info', message, options);
  }

  /**
   * Classifies an unknown error and shows a safe message. `fallback` is the contextual text used for
   * internal failures, e.g. "We couldn't upload the file. Please try again."
   */
  fromError(error: unknown, fallback?: string, options?: ToastOptions): number | null {
    if (isSilentError(error)) {
      return null;
    }
    const normalized = normalizeError(error, fallback);
    return this.show(normalized.code === 'NETWORK_ERROR' ? 'warning' : 'error', normalized.message, options);
  }

  show(severity: ToastSeverity, message: string, options: ToastOptions = {}): number {
    const text = (message || '').trim() || 'Something went wrong. Please try again.';
    const list = this.toastsSubject.value;
    const duplicate = list.find((t) => t.severity === severity && t.message === text && t.title === options.title);
    if (duplicate) {
      this.update(list.map((t) => (t.id === duplicate.id ? { ...t, count: t.count + 1 } : t)));
      this.schedule(duplicate.id, severity, options.duration);
      return duplicate.id;
    }
    const toast: Toast = { id: this.nextId++, severity, title: options.title, message: text, action: options.action, count: 1 };
    const next = [...list, toast];
    // Drop the oldest beyond the visible limit
    while (next.length > MAX_VISIBLE) {
      this.clearTimer(next.shift()!.id);
    }
    this.update(next);
    this.schedule(toast.id, severity, options.duration);
    return toast.id;
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this.update(this.toastsSubject.value.filter((t) => t.id !== id));
  }

  /** Pause auto-dismiss while hovered / focused (WCAG 2.2.1). */
  hold(id: number): void {
    this.clearTimer(id);
  }

  release(id: number): void {
    const toast = this.toastsSubject.value.find((t) => t.id === id);
    if (toast) {
      this.schedule(id, toast.severity);
    }
  }

  /** Dismisses every toast. Kept for callers of the previous API. */
  close(): void {
    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }
    this.update([]);
  }

  /** Confirmation dialog. Resolves true only when the user confirms. */
  async confirm(options: ConfirmOptions): Promise<boolean> {
    const ref = this.modal.open(ConfirmationDialogComponent, { centered: true, windowClass: 'app-modal', backdrop: 'static' });
    const dialog = ref.componentInstance as ConfirmationDialogComponent;
    dialog.title = options.title;
    dialog.content = options.text || '';
    dialog.okBtn = options.confirmText || 'Confirm';
    dialog.cancelBtn = options.cancelText || 'Cancel';
    dialog.okType = options.danger ? 'danger' : 'primary';
    try {
      await ref.result;
      return true;
    } catch {
      return false;
    }
  }

  private schedule(id: number, severity: ToastSeverity, duration?: number): void {
    this.clearTimer(id);
    const ms = duration ?? DEFAULT_DURATION[severity];
    if (ms > 0) {
      // Outside Angular so pending timers don't keep the app "unstable" (service worker / tests)
      this.zone.runOutsideAngular(() => {
        this.timers.set(id, setTimeout(() => this.zone.run(() => this.dismiss(id)), ms));
      });
    }
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private update(list: Toast[]): void {
    this.toastsSubject.next(list);
  }
}
