import { Injectable } from '@angular/core';
import { HttpContextToken, HttpEvent, HttpInterceptor, HttpHandler, HttpRequest, HttpErrorResponse } from '@angular/common/http';
import { from, Observable, throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { Router } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { clearStoredSession } from 'src/app/core/services/auth.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { normalizeError } from 'src/app/core/errors/app-error';

// Parallel requests fail together when a session ends; handle that once
let sessionEndedAt = 0;
/**
 * Set on requests whose failures the caller shows inline (forms, search boxes...), so the
 * interceptor doesn't also raise a toast: `{ context: new HttpContext().set(SKIP_ERROR_TOAST, true) }`.
 */
export const SKIP_ERROR_TOAST = new HttpContextToken<boolean>(() => false);
/** Marks the one retry after a 401, so a second 401 really ends the session. */
const RETRIED_AFTER_401 = new HttpContextToken<boolean>(() => false);

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(
    private alertService: AlertService,
    private router: Router,
    private clerk: ClerkService,
  ) {

  }
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(req).pipe(
      catchError((error: HttpErrorResponse) => {
        if (error.status === 401) {
          // A cached token can be expired by the server's clock (e.g. this device's clock is off):
          // retry once with a freshly issued token before signing out
          if (!req.context.get(RETRIED_AFTER_401) && this.clerk.isSignedIn) {
            return from(this.clerk.getToken({ skipCache: true })).pipe(
              switchMap((token) => {
                if (!token) {
                  return this.endSession(error);
                }
                const retry = req.clone({ setHeaders: { Authorization: `Bearer ${token}` }, context: req.context.set(RETRIED_AFTER_401, true) });
                return next.handle(retry).pipe(
                  catchError((again: HttpErrorResponse) => (again.status === 401 ? this.endSession(again) : throwError(() => again))),
                );
              }),
            );
          }
          return this.endSession(error);
        }
        const normalized = normalizeError(error);
        if (!req.context.get(SKIP_ERROR_TOAST)) {
          if (normalized.code === 'NETWORK_ERROR') {
            this.alertService.warning(normalized.message);
          } else {
            this.alertService.error(normalized.message);
          }
        }
        // Callers keep receiving a safe string (existing contract)
        return throwError(() => normalized.message);
      })
    );
  }

  /** 401 = the server does not accept the session: sign out (local + Clerk) and show sign-in. */
  private endSession(error: HttpErrorResponse): Observable<never> {
    const message = 'Your session has expired. Please sign in again.';
    clearStoredSession();
    // Clerk too, or the sign-in page would send a still-signed-in user straight back to /chat
    void this.clerk.signOut();
    if (Date.now() - sessionEndedAt > 3000 && !this.router.url.startsWith('/auth')) {
      sessionEndedAt = Date.now();
      this.alertService.error(message);
      this.router.navigate(['/auth/login']);
    }
    return throwError(() => message);
  }
}
