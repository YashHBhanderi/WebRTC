import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AlertService, Toast, ToastSeverity } from './alert.service';

const ICON: Record<ToastSeverity, string> = {
  success: 'ti-circle-check',
  error: 'ti-alert-circle',
  warning: 'ti-alert-triangle',
  info: 'ti-info-circle',
};

/** Bottom-right toast stack. Rendered once, in AppComponent. */
@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="toast-stack" aria-label="Notifications">
      <div *ngFor="let t of alert.toasts$ | async; trackBy: trackById"
           class="app-toast app-toast--{{ t.severity }}"
           [attr.role]="t.severity === 'error' || t.severity === 'warning' ? 'alert' : 'status'"
           [attr.aria-live]="t.severity === 'error' || t.severity === 'warning' ? 'assertive' : 'polite'"
           (mouseenter)="alert.hold(t.id)" (mouseleave)="alert.release(t.id)"
           (focusin)="alert.hold(t.id)" (focusout)="alert.release(t.id)">
        <i class="ti app-toast__icon {{ icon(t.severity) }}" aria-hidden="true"></i>
        <div class="app-toast__body">
          <div class="app-toast__title" *ngIf="t.title">{{ t.title }}</div>
          <div class="app-toast__message">{{ t.message }}<span class="app-toast__count" *ngIf="t.count > 1"> ({{ t.count }})</span></div>
          <button *ngIf="t.action" type="button" class="app-toast__action" (click)="run(t)">{{ t.action.label }}</button>
        </div>
        <button type="button" class="app-toast__close" aria-label="Dismiss notification" (click)="alert.dismiss(t.id)">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
    </section>
  `,
  styles: [`
    .toast-stack {
      position: fixed; right: 16px; bottom: 16px; z-index: 1090;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      width: min(380px, calc(100vw - 32px)); pointer-events: none;
    }
    .app-toast {
      pointer-events: auto; width: 100%;
      display: flex; gap: 10px; align-items: flex-start;
      padding: 12px 10px 12px 14px; border-radius: 10px;
      background: var(--app-surface); color: var(--app-text);
      border: 1px solid var(--app-border); border-left: 4px solid var(--toast-accent);
      box-shadow: var(--app-shadow); font-size: 0.875rem;
      animation: toast-in 160ms ease-out;
    }
    .app-toast--success { --toast-accent: var(--app-success); }
    .app-toast--error { --toast-accent: var(--app-danger); }
    .app-toast--warning { --toast-accent: var(--app-warning, #c4831f); }
    .app-toast--info { --toast-accent: var(--app-brand); }
    .app-toast__icon { color: var(--toast-accent); margin-top: 2px; font-size: 1rem; }
    .app-toast__body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .app-toast__title { font-weight: 600; margin-bottom: 2px; }
    .app-toast__message { color: var(--app-text-2); line-height: 1.4; }
    .app-toast__title + .app-toast__message { font-size: 0.8125rem; }
    .app-toast__count { color: var(--app-muted); }
    .app-toast__action {
      margin-top: 6px; padding: 2px 0; border: 0; background: none;
      color: var(--app-brand); font-weight: 600; font-size: 0.8125rem;
    }
    .app-toast__close {
      border: 0; background: none; color: var(--app-muted);
      width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0; margin-top: -4px;
    }
    .app-toast__close:hover { background: var(--app-hover); color: var(--app-text); }
    .app-toast__action:focus-visible, .app-toast__close:focus-visible { outline: 2px solid var(--app-brand); outline-offset: 2px; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .app-toast { animation: none; } }
    @media (max-width: 575.98px) {
      .toast-stack { right: 8px; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); width: auto; }
    }
  `],
})
export class ToastHostComponent {
  constructor(public alert: AlertService) {}

  icon(severity: ToastSeverity): string {
    return ICON[severity];
  }

  run(t: Toast): void {
    this.alert.dismiss(t.id);
    t.action?.handler();
  }

  trackById(_: number, t: Toast): number {
    return t.id;
  }
}
