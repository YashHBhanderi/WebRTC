import { Injectable, Injector, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import type { Clerk } from '@clerk/clerk-js';
import { Subject } from 'rxjs';

const LOAD_TIMEOUT_MS = 15000;

/** Organization a Clerk session token is for (v2 "o.id" or v1 "org_id" claim), null for the personal context. */
export function tokenOrganizationId(token: string): string | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
    return claims?.o?.id ?? claims?.org_id ?? null;
  } catch {
    return null;
  }
}

/** User a Clerk session token is for (the "sub" claim). */
export function tokenUserId(token: string): string | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "===".slice((part.length + 3) % 4)))?.sub ?? null;
  } catch {
    return null;
  }
}

/** An account signed in on this browser (Clerk multi-session). */
export interface SignedInAccount {
  sessionId: string;
  userId: string;
  name: string;
  email: string;
  avatar: string;
  /** The account this tab is using */
  current: boolean;
}

/** A request was stopped because the session now belongs to a different workspace than this tab shows. */
export class WorkspaceChangedError extends Error {
  constructor() {
    super("Your workspace changed. Reloading…");
    this.name = "WorkspaceChangedError";
  }
}

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

  /**
   * Emits once when a session token turns out to be for another workspace than the one this tab was
   * loaded in (switched in another tab or app). Requests are refused from then on (fail closed).
   */
  readonly workspaceChanged$ = new Subject<string | null>();
  /** Set once a token for another workspace was seen: no further request may use the session. */
  workspaceMismatch = false;
  /**
   * Emits once when the active Clerk session now belongs to ANOTHER account than this tab loaded with
   * (account added or switched, here or in another tab). The app restarts for that account.
   */
  readonly accountChanged$ = new Subject<void>();

  private clerk: Clerk | null = null;
  private hadSession = false;
  /** Workspace this tab shows (undefined until Clerk loaded). Changed only by this tab's own switches. */
  private pinnedOrganizationId: string | null | undefined;
  /** Account (Clerk user) this tab was loaded with; null before sign-in. */
  private pinnedUserId: string | null = null;
  private accountChangeSent = false;

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
      this.pinnedOrganizationId = (clerk as any).organization?.id ?? null;
      this.pinnedUserId = clerk.user?.id ?? null;
      clerk.addListener(({ session }: { session?: any }) => {
        if (session) {
          this.hadSession = true;
          const userId = session.user?.id ?? null;
          if (!this.pinnedUserId) {
            this.pinnedUserId = userId; // first sign-in in this tab
          } else if (userId && userId !== this.pinnedUserId) {
            this.announceAccountChange();
          }
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
    if (this.workspaceMismatch) {
      return null;
    }
    let token: string | null;
    try {
      token = (await this.clerk?.session?.getToken(opts)) ?? null;
    } catch {
      return null;
    }
    // Never use another account's token in a tab showing this account (switched in another tab)
    if (token && this.pinnedUserId && tokenUserId(token) !== this.pinnedUserId) {
      this.workspaceMismatch = true;
      this.announceAccountChange();
      return null;
    }
    // Never use a token for a workspace this tab is not showing: its data would mix with this page
    if (token && this.pinnedOrganizationId !== undefined) {
      const org = tokenOrganizationId(token);
      if (org !== this.pinnedOrganizationId) {
        this.workspaceMismatch = true;
        this.zone.run(() => this.workspaceChanged$.next(org));
        return null;
      }
    }
    return token;
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

  /**
   * Sign out of the account this tab uses. Other accounts signed in on this browser stay signed in;
   * returns true when one of them is now active (the caller restarts the app for it).
   */
  async signOut(): Promise<boolean> {
    const current = this.clerk?.session?.id;
    const next = this.accounts().find((a) => !a.current);
    this.hadSession = false;
    try {
      if (current && next && this.clerk) {
        this.accountChangeSent = true; // the caller restarts the app itself
        await this.clerk.signOut({ sessionId: current });
        await this.clerk.setActive({ session: next.sessionId });
        return true;
      }
      await this.clerk?.signOut();
    } catch {
      // already signed out / offline: the local session is cleared by the caller anyway
    }
    return false;
  }

  // ------------------------------------------------------------------ accounts (Clerk multi-session)

  /**
   * Several accounts can be signed in on one browser only when the Clerk instance allows it
   * (Clerk Dashboard → Sessions → multi-session). Read from Clerk's environment (an internal accessor
   * in clerk-js 6.x); unknown counts as single-session, so nothing is attempted that Clerk would refuse.
   */
  get multiAccountEnabled(): boolean {
    const mode = (this.clerk as any)?.__internal_environment?.authConfig?.singleSessionMode;
    return mode === false;
  }

  /** Accounts signed in on this browser, the one this tab uses first. */
  accounts(): SignedInAccount[] {
    const sessions: any[] = (this.clerk as any)?.client?.signedInSessions ?? [];
    const currentId = this.clerk?.session?.id;
    return sessions
      .map((s) => ({
        sessionId: s.id,
        userId: s.user?.id ?? s.publicUserData?.userId ?? '',
        name: s.user?.fullName || s.user?.username || s.publicUserData?.identifier || 'Account',
        email: s.user?.primaryEmailAddress?.emailAddress || s.publicUserData?.identifier || '',
        avatar: s.user?.imageUrl || s.publicUserData?.imageUrl || '',
        current: s.id === currentId,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /** Clerk's sign-in screen for one more account; when it completes, the app restarts as that account. */
  addAccount(): void {
    this.clerk?.openSignIn({ fallbackRedirectUrl: '/chat', signUpFallbackRedirectUrl: '/chat' } as any);
  }

  /** Use another signed-in account in this tab (the app restarts as that account). */
  async switchAccount(sessionId: string): Promise<void> {
    if (!this.clerk || sessionId === this.clerk.session?.id) return;
    this.accountChangeSent = true; // the caller restarts the app itself
    await this.clerk.setActive({ session: sessionId });
  }

  private announceAccountChange(): void {
    if (this.accountChangeSent) return;
    this.accountChangeSent = true;
    this.zone.run(() => this.accountChanged$.next());
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

  // ------------------------------------------------------------------ workspaces (Clerk Organizations)

  /** Active organization id, or null for the personal (global) context. */
  get activeOrganizationId(): string | null {
    return (this.clerk as any)?.organization?.id ?? null;
  }

  /**
   * Organizations the user belongs to. Uses the user's memberships as loaded by Clerk.
   * NOTE: verified only against Clerk's TypeScript types in this repo, not a live Clerk instance.
   */
  async organizations(): Promise<{ id: string; name: string; role: string }[]> {
    const user: any = (this.clerk as any)?.user;
    if (!user) return [];
    try {
      const list = typeof user.getOrganizationMemberships === 'function'
        ? (await user.getOrganizationMemberships())?.data ?? []
        : user.organizationMemberships ?? [];
      return list.map((m: any) => ({ id: m.organization?.id, name: m.organization?.name || m.organization?.slug || 'Workspace', role: m.role || '' }))
        .filter((o: { id?: string }) => !!o.id);
    } catch {
      return [];
    }
  }

  /** Switch the active workspace (null = personal). The session token changes accordingly. */
  /**
   * Switch to an organization the server has just added me to (created, invitation, join): Clerk's
   * cached user doesn't know the new membership yet, so reload it before selecting the organization.
   */
  async activateNewOrganization(organizationId: string): Promise<void> {
    await (this.clerk as any)?.user?.reload?.();
    await this.setActiveOrganization(organizationId);
  }

  /** This tab switches workspace on purpose: the pin follows, and other tabs are told. */
  async setActiveOrganization(organizationId: string | null): Promise<void> {
    const previous = this.pinnedOrganizationId;
    this.pinnedOrganizationId = organizationId;
    try {
      await (this.clerk as any)?.setActive({ organization: organizationId });
    } catch (error) {
      this.pinnedOrganizationId = previous;
      throw error;
    }
    announceWorkspace(organizationId);
  }

  /** The workspace this tab shows (null = personal). */
  get pinnedOrganization(): string | null {
    return this.pinnedOrganizationId ?? null;
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

/** Cross-tab: other SpreeWe tabs listen for this key (storage event) and follow the switch. */
export const WORKSPACE_KEY = "spreewe.workspace";

function announceWorkspace(organizationId: string | null): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ organizationId, at: Date.now() }));
  } catch {
    // storage unavailable: other tabs still detect the change on their next token
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
