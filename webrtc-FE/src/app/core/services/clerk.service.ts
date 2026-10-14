import { Injectable, Injector, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import type { Clerk } from '@clerk/clerk-js';
import { Subject } from 'rxjs';

const LOAD_TIMEOUT_MS = 15000;

/**
 * Clerk (clerk.com) in the browser: session state, session tokens for the API and sockets, and
 * the prebuilt sign-in / sign-up screens. The publishable key comes from the backend (GET /config),
 * so builds carry no keys. The UI bundle is loaded from the Clerk instance's own domain, as in
 * Clerk's JavaScript quickstart.
 */
@Injectable({ providedIn: 'root' })
export class ClerkService {
  /** Emits when the Clerk session ends (signed out here, in another tab, or revoked). */
  readonly signedOut$ = new Subject<void>();
  /** Why Clerk is unavailable ('' when it loaded). Shown on the sign-in page. */
  loadError = '';

  private clerk: Clerk | null = null;
  private hadSession = false;

  // Router is looked up lazily: this service runs during APP_INITIALIZER, before routing exists
  constructor(private zone: NgZone, private injector: Injector) {}

  private get router(): Router {
    return this.injector.get(Router);
  }

  get loaded(): boolean {
    return !!this.clerk?.loaded;
  }

  get isSignedIn(): boolean {
    return !!this.clerk?.isSignedIn;
  }

  get userId(): string | null {
    return this.clerk?.user?.id ?? null;
  }

  /** Called once at startup (APP_INITIALIZER). Never throws: failures are kept in loadError. */
  async init(publishableKey: string | undefined): Promise<void> {
    if (!publishableKey) {
      this.loadError = 'Sign-in is not configured on the server.';
      return;
    }
    try {
      // Separate chunk: Clerk's SDK is large and only needed once, at startup
      const { Clerk: ClerkCtor } = await import('@clerk/clerk-js');
      const clerk = new ClerkCtor(publishableKey);
      await withTimeout(this.loadUi(clerk.frontendApi), 'Could not load the sign-in screens');
      await withTimeout(
        clerk.load({
          ui: { ClerkUI: (window as any).__internal_ClerkUICtor },
          signInUrl: '/auth/login',
          signUpUrl: '/auth/register',
          signInFallbackRedirectUrl: '/chat',
          signUpFallbackRedirectUrl: '/chat',
          // In-app navigation through the Angular router (no full page reloads). Not awaited: Clerk
          // activates a new session only after this resolves, and the /chat guard waits for it.
          routerPush: (to: string) => { this.zone.run(() => void this.router.navigateByUrl(to)); return Promise.resolve(); },
          routerReplace: (to: string) => { this.zone.run(() => void this.router.navigateByUrl(to, { replaceUrl: true })); return Promise.resolve(); },
        } as any),
        'Could not reach the sign-in service',
      );
      this.clerk = clerk;
      this.hadSession = !!clerk.session;
      clerk.addListener(({ session }: { session?: unknown }) => {
        if (session) {
          this.hadSession = true;
        } else if (session === null && this.hadSession) {
          this.hadSession = false;
          this.zone.run(() => this.signedOut$.next());
        }
      });
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : 'Sign-in is unavailable right now.';
      console.error('[auth] Clerk failed to load:', error);
    }
  }

  /** Short-lived session token for the API / sockets (cached by Clerk; skipCache forces a new one). */
  async getToken(opts?: { skipCache?: boolean }): Promise<string | null> {
    try {
      return (await this.clerk?.session?.getToken(opts)) ?? null;
    } catch {
      return null;
    }
  }

  /** Right after sign-in Clerk can navigate a moment before the session is active: wait briefly. */
  waitForSession(timeoutMs = 3000): Promise<boolean> {
    if (this.isSignedIn || !this.clerk) {
      return Promise.resolve(this.isSignedIn);
    }
    return new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null;
      const finish = (value: boolean) => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(value);
      };
      const timer = setTimeout(() => finish(this.isSignedIn), timeoutMs);
      unsubscribe = this.clerk!.addListener(({ session }: { session?: unknown }) => {
        if (session) {
          finish(true);
        }
      });
    });
  }

  async signOut(): Promise<void> {
    this.hadSession = false;
    try {
      await this.clerk?.signOut();
    } catch {
      // already signed out / offline: the local session is cleared by the caller anyway
    }
  }

  mountSignIn(el: HTMLDivElement, returnUrl = '/chat'): void {
    this.clerk?.mountSignIn(el, { routing: 'hash', signUpUrl: '/auth/register', fallbackRedirectUrl: returnUrl });
  }

  mountSignUp(el: HTMLDivElement): void {
    this.clerk?.mountSignUp(el, { routing: 'hash', signInUrl: '/auth/login', fallbackRedirectUrl: '/chat' });
  }

  unmount(el: HTMLDivElement, kind: 'signIn' | 'signUp'): void {
    if (!this.clerk) {
      return;
    }
    if (kind === 'signIn') {
      this.clerk.unmountSignIn(el);
    } else {
      this.clerk.unmountSignUp(el);
    }
  }

  /** Clerk's account screen: email addresses, password, connected accounts, sessions, MFA. */
  openAccount(): void {
    this.clerk?.openUserProfile();
  }

  private loadUi(frontendApi: string): Promise<void> {
    if ((window as any).__internal_ClerkUICtor) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load the sign-in screens'));
      document.head.appendChild(script);
    });
  }
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), LOAD_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
