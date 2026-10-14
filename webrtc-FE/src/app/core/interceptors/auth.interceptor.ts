import { Injectable } from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { from, Observable, switchMap } from 'rxjs';
import { environment } from 'src/environments/environment';
import { ClerkService } from 'src/app/core/services/clerk.service';

/** Adds the Clerk session token to this app's API calls (never to third-party URLs). */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private clerk: ClerkService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    if (!this.isOwnApi(req.url) || !this.clerk.isSignedIn) {
      return next.handle(req);
    }
    return from(this.clerk.getToken()).pipe(
      switchMap((token) => next.handle(token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req)),
    );
  }

  private isOwnApi(url: string): boolean {
    if (url.startsWith('/')) {
      return true;
    }
    const api = environment.apiUrl;
    return /^https?:/.test(api) ? url.startsWith(api) : url.startsWith(window.location.origin);
  }
}
