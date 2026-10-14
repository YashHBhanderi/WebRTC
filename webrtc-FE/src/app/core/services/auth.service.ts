import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { ClerkService } from './clerk.service';

const USER_KEY = 'user';
const USER_CLERK_KEY = 'userClerkId';
// Pre-Clerk session token; removed on sight
const LEGACY_TOKEN_KEY = 'auth_token';

/** Forget the cached app user. Plain function so the HTTP interceptor can use it without DI cycles. */
export function clearStoredSession(): void {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(USER_CLERK_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

/**
 * Signed in = a Clerk session plus this app's own user record (MongoDB), which the backend links
 * or creates on the first request. The app user is cached so components can read it synchronously
 * (getLoggedInUser); it is refetched when the Clerk user changes (e.g. another account signs in).
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  constructor(
    private http: HttpClient,
    private router: Router,
    private clerk: ClerkService,
  ) {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }

  /** Clerk session token for the API and sockets (short-lived, refreshed by Clerk). */
  getToken(opts?: { skipCache?: boolean }): Promise<string | null> {
    return this.clerk.getToken(opts);
  }

  loggedIn(): boolean {
    return this.clerk.isSignedIn && !!localStorage.getItem(USER_KEY) && localStorage.getItem(USER_CLERK_KEY) === this.clerk.userId;
  }

  /** Make sure the app user for the current Clerk session is loaded. Throws the server's message on failure. */
  async ensureAppUser(): Promise<void> {
    if (!this.clerk.isSignedIn) {
      throw new Error('Not signed in');
    }
    if (this.loggedIn()) {
      return;
    }
    const res = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/web/user/me`, { headers: { skipInterceptorToast: 'true' } }));
    if (!res?.data?._id) {
      throw new Error('Could not load your account');
    }
    localStorage.setItem(USER_KEY, JSON.stringify(res.data));
    localStorage.setItem(USER_CLERK_KEY, this.clerk.userId || '');
  }

  async logout(navigate = true): Promise<void> {
    clearStoredSession();
    await this.clerk.signOut();
    if (navigate) {
      this.router.navigate(['/auth/login']);
    }
  }

  getLoggedInUser() {
    const loggedInUser = localStorage.getItem(USER_KEY);
    return loggedInUser ? JSON.parse(loggedInUser) : null;
  }

  /** Merge fresh profile fields (after a profile save) into the stored session user. */
  updateLoggedInUser(changes: Record<string, unknown>) {
    const current = this.getLoggedInUser();
    if (current) {
      localStorage.setItem(USER_KEY, JSON.stringify({ ...current, ...changes }));
    }
  }
}
