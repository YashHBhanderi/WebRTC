import { Injectable } from '@angular/core';
import { HttpEvent, HttpInterceptor, HttpHandler, HttpRequest, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Router } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { clearStoredSession } from 'src/app/core/services/auth.service';

// Parallel requests fail together when a session ends; handle that once
let sessionEndedAt = 0;

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(
    private alertService: AlertService,
    private router: Router,
  ) {

  }
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(req).pipe(
      catchError((error: HttpErrorResponse) => {
        if (error.status === 401) {
          return this.endSession(error);
        }
        let errorMessage = 'An unknown error occurred!';
        if (error.error instanceof ErrorEvent) {
          errorMessage = `Error: ${error.error.message}`;
        } else {
          if (error.error.message) {
            errorMessage = error.error.message;
          } else {
            switch (error.status) {
              case 0:
                errorMessage = 'Network error or Server issue';
                break;
              case 400:
                errorMessage = 'Bad Request';
                break;
              case 401:
                errorMessage = 'Unauthorized';
                break;
              case 403:
                errorMessage = 'Access Denied !';
                break;
              case 404:
                errorMessage = 'Not Found';
                break;
              case 413:
                // Usually the reverse proxy's body-size limit (the HTML page has no message)
                errorMessage = 'This file is too large to upload';
                break;
              case 500:
                errorMessage = 'Internal Server Error';
                break;
              default:
                errorMessage = `Error Code: ${error.status}\nMessage: ${error.message}`;
            }
          }
        }
        this.alertService.error(errorMessage);
        return throwError(errorMessage);
      })
    );
  }

  /** 401 = token missing, invalid or expired: forget the session and show the login page. */
  private endSession(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || 'Your session has expired. Please log in again.';
    clearStoredSession();
    if (Date.now() - sessionEndedAt > 3000 && !this.router.url.startsWith('/auth')) {
      sessionEndedAt = Date.now();
      this.alertService.error(message);
      this.router.navigate(['/auth/login']);
    }
    return throwError(() => message);
  }
}
