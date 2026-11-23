import { Injectable } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { ClerkService } from './clerk.service';
import { RAW_ERRORS } from '../interceptors/error.interceptor';
import { clearPortal, portalHome } from './portal';

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
  /** Set when sign-in had to leave an organization the server refused (shown once by the shell). */
  workspaceFallback = false;

  async ensureAppUser(): Promise<void> {
    if (!this.clerk.isSignedIn) {
      throw new Error('Not signed in');
    }
    if (this.loggedIn()) {
      await this.checkWorkspaceOnce();
      return;
    }
    this.workspaceChecked = true;
    let res: any;
    try {
      res = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/web/user/me`, { headers: { skipInterceptorToast: 'true' } }));
    } catch (error) {
      // Clerk restores the last active organization at sign-in. If the server refuses it (removed from
      // it, organization deleted / suspended), continue in the personal workspace instead of being
      // locked out of the app. The server still refuses the organization itself.
      if (!this.clerk.activeOrganizationId) throw error;
      await this.clerk.setActiveOrganization(null);
      res = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/web/user/me`, { headers: { skipInterceptorToast: 'true' } }));
      this.workspaceFallback = true;
    }
    if (!res?.data?._id) {
      throw new Error('Could not load your account');
    }
    localStorage.setItem(USER_KEY, JSON.stringify(res.data));
    localStorage.setItem(USER_CLERK_KEY, this.clerk.userId || '');
  }

  private workspaceChecked = false;

  /**
   * With a cached app user the request above is skipped, so an organization the server no longer
   * accepts (removed, deleted) would stay selected after a reload. Ask once per app load.
   */
  private async checkWorkspaceOnce(): Promise<void> {
    if (this.workspaceChecked || !this.clerk.activeOrganizationId) {
      this.workspaceChecked = true;
      return;
    }
    this.workspaceChecked = true;
    try {
      await firstValueFrom(this.http.get(`${environment.apiUrl}/v1/workspace`, { context: new HttpContext().set(RAW_ERRORS, true) }));
    } catch (error: any) {
      // Only a refusal of the organization; network or server errors are left to the pages
      if (error?.status === 403 || error?.status === 404) {
        await this.clerk.setActiveOrganization(null);
        this.workspaceFallback = true;
      }
    }
  }

  /**
   * Sign out of this account. When another account is still signed in on this browser, the app
   * restarts as that account (full reload: nothing of this account stays in memory).
   */
  async logout(navigate = true): Promise<void> {
    clearStoredSession();
    const continued = await this.clerk.signOut();
    if (continued) {
      window.location.assign(portalHome());
      return;
    }
    // The next person on this browser chooses their portal again on the landing page
    clearPortal();
    if (navigate) {
      this.router.navigate(['/']);
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
