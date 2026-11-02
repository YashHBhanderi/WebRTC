import { ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpreeWeClient } from '@spreewe/chat-sdk';
import { SpwChatAppComponent } from '@spreewe/chat-angular';

/**
 * A separate "third-party" Angular app ("Acme Support") embedding SpreeWe chat + calling.
 *
 * 1. Sign-in: Clerk (the SpreeWe instance; publishable key read from the backend's public GET /config).
 * 2. SDK: @spreewe/chat-sdk with the signed-in user's session token. No app secret in the browser.
 * 3. UI: <spw-chat-app> from @spreewe/chat-angular.
 * 4. Workspace: switching the Clerk active organization (personal ↔ organization) reconnects the SDK;
 *    the backend enforces which conversations each context may see.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, SpwChatAppComponent],
  template: `
    <header>
      <b>Acme Support</b>
      <span class="sub">powered by SpreeWe</span>
      <span class="spacer"></span>
      <ng-container *ngIf="signedIn">
        <label>Workspace
          <select (change)="switchWorkspace($any($event.target).value)" [value]="orgId || ''">
            <option value="">Personal</option>
            <option *ngFor="let o of orgs" [value]="o.id">{{ o.name }}</option>
          </select>
        </label>
        <button type="button" (click)="signOut()">Sign out</button>
      </ng-container>
    </header>
    <main>
      <p class="status" *ngIf="status">{{ status }}</p>
      <div #signIn [hidden]="signedIn"></div>
      <spw-chat-app *ngIf="client && ready" [client]="client"></spw-chat-app>
    </main>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #d9dee3; flex-wrap: wrap; }
    .sub { color: #66737f; font-size: 13px; }
    .spacer { flex: 1; }
    main { flex: 1; min-height: 0; padding: 16px; display: flex; flex-direction: column; }
    spw-chat-app { flex: 1; min-height: 0; }
    .status { margin: 0 0 8px; }
    /* Host theming of the SpreeWe components through their CSS custom properties */
    spw-chat-app { --spw-brand: #3949ab; --spw-accent: #7986cb; }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('signIn', { static: true }) signInEl!: ElementRef<HTMLDivElement>;
  client: SpreeWeClient | null = null;
  ready = false;
  signedIn = false;
  status = 'Loading…';
  orgId: string | null = null;
  orgs: { id: string; name: string }[] = [];
  private clerk: any = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    try {
      const config = await (await fetch('/api/config')).json();
      const publishableKey = config?.data?.clerkPublishableKey;
      if (!publishableKey) throw new Error('The SpreeWe backend has no Clerk publishable key configured');
      const { Clerk } = await import('@clerk/clerk-js');
      this.clerk = new Clerk(publishableKey);
      await loadClerkUi(this.clerk.frontendApi);
      await this.clerk.load({ ui: { ClerkUI: (window as any).__internal_ClerkUICtor } });
      this.unsubscribe = this.clerk.addListener(() => this.zone.run(() => void this.sync()));
      await this.sync();
    } catch (e: any) {
      this.status = `Could not start: ${e?.message || e}`;
    }
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.client?.disconnect();
  }

  async switchWorkspace(orgId: string): Promise<void> {
    await this.clerk.setActive({ organization: orgId || null });
  }

  async signOut(): Promise<void> {
    this.client?.disconnect();
    await this.clerk.signOut();
  }

  /** (Re)connect the SDK when the user or the active workspace changes. */
  private async sync(): Promise<void> {
    const user = this.clerk.user;
    this.signedIn = !!user;
    if (!user) {
      this.client?.disconnect();
      this.client = null;
      this.ready = false;
      this.status = '';
      this.clerk.mountSignIn(this.signInEl.nativeElement);
      this.cdr.detectChanges();
      return;
    }
    const orgId = this.clerk.organization?.id ?? null;
    if (this.client && this.ready && orgId === this.orgId) return;
    this.orgId = orgId;
    this.orgs = (user.organizationMemberships || []).map((m: any) => ({ id: m.organization.id, name: m.organization.name }));
    this.client?.disconnect();
    this.ready = false;
    this.status = 'Connecting to SpreeWe…';
    this.cdr.detectChanges();
    const origin = window.location.origin;
    this.client = new SpreeWeClient({
      apiUrl: `${origin}/api`,
      socketUrl: origin,
      getToken: () => this.clerk.session?.getToken({ skipCache: true }) ?? Promise.resolve(null),
      wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
      deviceLabel: 'Acme Support (example)',
    });
    try {
      await this.client.connect();
      this.ready = true;
      this.status = '';
    } catch (e: any) {
      this.status = `Could not connect to SpreeWe: ${e?.message || e}`;
    }
    this.cdr.detectChanges();
  }
}

/** Clerk's prebuilt sign-in UI (same loader as the SpreeWe web app). */
function loadClerkUi(frontendApi: string): Promise<void> {
  if ((window as any).__internal_ClerkUICtor) return Promise.resolve();
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
