import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  AuditEntry, Credential, DevApp, DeveloperService, ScopeInfo, UsageDay, WebhookDelivery, WebhookEndpoint, WebhookEventType,
} from 'src/app/core/services/developer.service';
import { errorText } from 'src/app/core/services/organization.service';

type Tab = 'overview' | 'credentials' | 'permissions' | 'configuration' | 'webhooks' | 'usage' | 'activity';

/**
 * /developer/apps/:appId — one application: details and status, credentials (secret shown once),
 * permissions, origins and redirect URLs, webhooks with deliveries, usage, audit trail.
 * Irreversible actions ask for the application's exact name (the server checks it too).
 */
@Component({
  selector: 'app-developer-app',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', './developer.scss'],
  template: `
    <section class="page">
      <p class="mb-2"><a routerLink="/developer">← All applications</a></p>
      <p class="dev-muted" *ngIf="loading">Loading…</p>
      <p class="text-danger" *ngIf="loadError" role="alert">{{ loadError }}</p>

      <ng-container *ngIf="app">
        <header class="page__header dev-row dev-row--between">
          <div>
            <h1 class="page__title">{{ app.name }}</h1>
            <p class="dev-muted mb-0">{{ app.environment }} · <span class="dev-chip" [ngClass]="statusClass">{{ statusLabel }}</span>
              <span *ngIf="app.tenantId"> · workspace application</span></p>
          </div>
        </header>

        <div class="dev-warn mb-3" *ngIf="app.status === 'suspended'">This application is disabled. Its credentials and tokens are refused until you enable it.</div>
        <div class="dev-warn mb-3" *ngIf="app.status === 'revoked'">This application is deleted. Its credentials and tokens no longer work, and it can't be changed.</div>

        <nav class="dev-tabs" aria-label="Application sections">
          <button type="button" *ngFor="let t of tabs" [class.on]="tab === t.id" (click)="select(t.id)" [attr.aria-current]="tab === t.id ? 'page' : null">{{ t.label }}</button>
        </nav>

        <p class="text-danger small" *ngIf="error" role="alert">{{ error }}</p>
        <p class="text-success small" *ngIf="notice" role="status">{{ notice }}</p>

        <!-- ============================================================ overview -->
        <div class="dev-grid" *ngIf="tab === 'overview'">
          <div class="card-section dev-grid">
            <h2 class="h6 mb-0">Identifiers</h2>
            <div><span class="dev-muted">Application ID</span><div class="dev-row"><span class="dev-mono">{{ app._id }}</span><button type="button" class="btn btn-sm btn-link" (click)="copy(app._id)">Copy</button></div></div>
            <div><span class="dev-muted">Client ID (key id)</span> <span class="dev-muted small">: listed on the Credentials tab; each credential has its own.</span></div>
            <div class="dev-muted small">Created {{ app.createdAt | date: 'medium' }} · updated {{ app.updatedAt | date: 'medium' }}</div>
          </div>
          <form class="card-section dev-grid" (ngSubmit)="saveDetails()">
            <h2 class="h6 mb-0">Details</h2>
            <label>Name<input class="form-control" name="name" [(ngModel)]="details.name" minlength="2" maxlength="80" [disabled]="readOnly" /></label>
            <label>Description<textarea class="form-control" name="description" rows="2" maxlength="500" [(ngModel)]="details.description" [disabled]="readOnly"></textarea></label>
            <label>Website URL<input class="form-control" name="websiteUrl" type="url" placeholder="https://example.com" [(ngModel)]="details.websiteUrl" maxlength="300" [disabled]="readOnly" /></label>
            <div><button type="submit" class="btn btn-primary" [disabled]="busy || readOnly || details.name.trim().length < 2">Save</button></div>
          </form>
          <div class="card-section dev-grid" *ngIf="app.status !== 'revoked'">
            <h2 class="h6 mb-0">Status</h2>
            <div class="dev-row" *ngIf="app.status === 'active'">
              <button type="button" class="btn btn-outline-warning" (click)="setEnabled(false)" [disabled]="busy">Disable application</button>
              <span class="dev-muted small">Credentials and tokens stop working until you enable it again.</span>
            </div>
            <div class="dev-row" *ngIf="app.status === 'suspended'">
              <button type="button" class="btn btn-primary" (click)="setEnabled(true)" [disabled]="busy">Enable application</button>
            </div>
            <div class="dev-confirm">
              <input class="form-control" [(ngModel)]="confirmName" name="confirmTokens" [placeholder]="'Type ' + app.name" aria-label="Application name to confirm" />
              <button type="button" class="btn btn-outline-danger" (click)="revokeTokens()" [disabled]="busy || confirmName !== app.name">Revoke all issued user tokens</button>
              <button type="button" class="btn btn-danger" (click)="deleteApp()" [disabled]="busy || confirmName !== app.name">Delete application</button>
            </div>
            <span class="dev-muted small">Deleting is permanent: credentials, tokens and webhooks stop working. The record and audit trail are kept.</span>
          </div>
        </div>

        <!-- ============================================================ credentials -->
        <div class="dev-grid" *ngIf="tab === 'credentials'">
          <div class="dev-secret" *ngIf="secret" role="alert">
            <strong>Copy your client secret now. It will not be shown again.</strong>
            <div class="mt-2"><span class="dev-muted">Client ID</span><div class="dev-row"><span class="dev-mono">{{ secret.keyId }}</span><button type="button" class="btn btn-sm btn-link" (click)="copy(secret.keyId)">Copy</button></div></div>
            <div><span class="dev-muted">Client secret</span><div class="dev-row"><span class="dev-mono">{{ secret.value }}</span><button type="button" class="btn btn-sm btn-link" (click)="copy(secret.value)">Copy</button></div></div>
            <p class="dev-muted small mb-2">Keep it on your server only (a secret manager or environment variable). Never put it in a browser or mobile app.</p>
            <button type="button" class="btn btn-sm btn-outline-secondary" (click)="secret = null">I have stored it</button>
          </div>
          <div class="card-section dev-grid">
            <div class="dev-row dev-row--between">
              <h2 class="h6 mb-0">Credentials</h2>
            </div>
            <p class="dev-muted small mb-0">Your server authenticates with <code>Authorization: Basic base64(clientId:clientSecret)</code>. Secrets are stored hashed; SpreeWe can't show them again.</p>
            <table class="dev-table" *ngIf="credentials.length">
              <thead><tr><th>Client ID</th><th>Status</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                <tr *ngFor="let c of credentials">
                  <td><span class="dev-mono">{{ c.keyId }}</span><span class="d-block dev-muted">secret …{{ c.hint }}</span></td>
                  <td><span class="dev-chip" [ngClass]="c.status === 'active' ? 'dev-chip--ok' : c.status === 'rotated' ? 'dev-chip--warn' : 'dev-chip--bad'">{{ c.status }}</span>
                    <span class="d-block dev-muted" *ngIf="c.graceUntil">valid until {{ c.graceUntil | date: 'short' }}</span></td>
                  <td>{{ c.createdAt | date: 'mediumDate' }}</td>
                  <td>{{ c.expiresAt ? (c.expiresAt | date: 'mediumDate') : '—' }}</td>
                  <td>{{ c.lastUsedAt ? (c.lastUsedAt | date: 'short') : 'never' }}</td>
                  <td class="text-nowrap" *ngIf="c.status === 'active' && !readOnly">
                    <button type="button" class="btn btn-sm btn-outline-secondary" (click)="rotate(c)" [disabled]="busy || confirmName !== app.name">Regenerate</button>
                    <button type="button" class="btn btn-sm btn-outline-danger ms-1" (click)="revokeCredential(c)" [disabled]="busy || confirmName !== app.name">Revoke</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="dev-muted mb-0" *ngIf="!credentials.length">No credentials yet.</p>
            <div class="dev-confirm" *ngIf="!readOnly">
              <input class="form-control" [(ngModel)]="confirmName" name="confirmCred" [placeholder]="'Type ' + app.name" aria-label="Application name to confirm" />
              <button type="button" class="btn btn-primary" (click)="createCredential()" [disabled]="busy || confirmName !== app.name">Generate client secret</button>
            </div>
            <span class="dev-muted small" *ngIf="!readOnly">Regenerating keeps the old secret working for a short grace period so you can redeploy; revoking stops it immediately.</span>
          </div>
        </div>

        <!-- ============================================================ permissions -->
        <form class="card-section dev-grid" *ngIf="tab === 'permissions'" (ngSubmit)="savePermissions()">
          <h2 class="h6 mb-0">Permissions (scopes)</h2>
          <p class="dev-muted small mb-0">The most your application can ask for. Each user approves a subset; tokens carry only what the user approved and what is still enabled here. Removing a permission takes effect on existing tokens immediately.</p>
          <label class="dev-scope" *ngFor="let s of scopes">
            <input type="checkbox" class="form-check-input mt-1" [checked]="picked.has(s.scope)" [disabled]="readOnly || (!s.available && !picked.has(s.scope))" (change)="togglePick(s.scope)" />
            <span><code>{{ s.scope }}</code>
              <span class="dev-chip dev-chip--warn" *ngIf="s.sensitive">sensitive</span>
              <span class="dev-chip dev-chip--bad" *ngIf="!s.available">not available</span>
              <span class="d-block dev-muted">{{ s.description }}</span></span>
          </label>
          <div class="dev-warn">Application tokens can't send or decrypt messages: messages are end-to-end encrypted on users' own devices.</div>
          <div><button type="submit" class="btn btn-primary" [disabled]="busy || readOnly">Save permissions</button></div>
        </form>

        <!-- ============================================================ configuration -->
        <form class="card-section dev-grid" *ngIf="tab === 'configuration'" (ngSubmit)="saveConfiguration()">
          <h2 class="h6 mb-0">Allowed origins</h2>
          <p class="dev-muted small mb-0">Browser origins allowed to use your application's user tokens, one per line (scheme, host and port; no path). {{ app.environment === 'production' ? 'Production requires https.' : 'Development also allows http://localhost.' }}</p>
          <textarea class="form-control dev-mono" name="origins" rows="3" [(ngModel)]="originsText" [disabled]="readOnly" placeholder="https://app.example.com"></textarea>
          <h2 class="h6 mb-0 mt-2">Redirect URLs</h2>
          <p class="dev-muted small mb-0">Where SpreeWe sends users back after they approve or deny your application (the <code>redirectUri</code> of a consent request must match one exactly). One per line.</p>
          <textarea class="form-control dev-mono" name="callbacks" rows="3" [(ngModel)]="callbacksText" [disabled]="readOnly" placeholder="https://app.example.com/spreewe/callback"></textarea>
          <h2 class="h6 mb-0 mt-2">Limits</h2>
          <p class="dev-muted small mb-0">{{ app.quotas.rateLimitPerMinute }} requests per minute · {{ app.quotas.maxConnections }} concurrent socket connections · {{ app.quotas.messagesPerDay }} messages per day.</p>
          <div><button type="submit" class="btn btn-primary" [disabled]="busy || readOnly">Save configuration</button></div>
        </form>

        <!-- ============================================================ webhooks -->
        <div class="dev-grid" *ngIf="tab === 'webhooks'">
          <div class="dev-secret" *ngIf="webhookSecret" role="alert">
            <strong>Copy the signing secret now. It will not be shown again.</strong>
            <div class="dev-row mt-2"><span class="dev-mono">{{ webhookSecret }}</span><button type="button" class="btn btn-sm btn-link" (click)="copy(webhookSecret)">Copy</button></div>
            <p class="dev-muted small mb-2">Use it to verify the <code>SpreeWe-Webhook-Signature</code> header on every delivery.</p>
            <button type="button" class="btn btn-sm btn-outline-secondary" (click)="webhookSecret = ''">I have stored it</button>
          </div>
          <div class="card-section dev-grid" *ngFor="let w of webhooks">
            <div class="dev-row dev-row--between">
              <div><span class="dev-mono">{{ w.url }}</span>
                <span class="dev-chip ms-1" [ngClass]="w.status === 'active' ? 'dev-chip--ok' : w.status === 'disabled' ? 'dev-chip--bad' : 'dev-chip--warn'">{{ w.status.replace('_', ' ') }}</span>
                <span class="d-block dev-muted small" *ngIf="w.description">{{ w.description }}</span>
                <span class="d-block dev-muted small" *ngIf="w.disabledReason">Disabled: {{ w.disabledReason }}</span>
                <span class="d-block dev-muted small" *ngIf="w.consecutiveFailures">{{ w.consecutiveFailures }} consecutive failed deliveries</span></div>
              <div class="dev-row" *ngIf="!readOnly">
                <button type="button" class="btn btn-sm btn-outline-secondary" *ngIf="w.status === 'pending_verification'" (click)="webhookAction(w, 'verify')" [disabled]="busy">Verify</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" *ngIf="w.status === 'active'" (click)="webhookAction(w, 'disable')" [disabled]="busy">Disable</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" *ngIf="w.status === 'disabled'" (click)="webhookAction(w, 'enable')" [disabled]="busy">Enable</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" (click)="showDeliveries(w)" [disabled]="busy">Deliveries</button>
              </div>
            </div>
            <div class="dev-muted small">Events: <code *ngFor="let e of w.events; let last = last">{{ e }}{{ last ? '' : ', ' }}</code></div>
            <div class="dev-confirm" *ngIf="!readOnly">
              <button type="button" class="btn btn-sm btn-outline-secondary" (click)="rotateWebhook(w)" [disabled]="busy || confirmName !== app.name">Regenerate signing secret</button>
              <button type="button" class="btn btn-sm btn-outline-danger" (click)="deleteWebhook(w)" [disabled]="busy || confirmName !== app.name">Delete</button>
              <span class="dev-muted small">(type the application name below to enable)</span>
            </div>
            <table class="dev-table" *ngIf="deliveriesFor === w._id">
              <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>Delivered</th><th></th></tr></thead>
              <tbody>
                <tr *ngFor="let d of deliveries">
                  <td><code>{{ d.eventType }}</code></td>
                  <td>{{ d.status }}</td>
                  <td>{{ d.attempts }}</td>
                  <td>{{ d.lastStatusCode ?? '—' }} <span class="dev-muted" *ngIf="d.lastError">{{ d.lastError }}</span></td>
                  <td>{{ d.deliveredAt ? (d.deliveredAt | date: 'short') : (d.nextAttemptAt ? 'next ' + (d.nextAttemptAt | date: 'short') : '—') }}</td>
                  <td><button type="button" class="btn btn-sm btn-link" *ngIf="d.status === 'dead' && !readOnly" (click)="retry(w, d)" [disabled]="busy">Retry</button></td>
                </tr>
                <tr *ngIf="!deliveries.length"><td colspan="6" class="dev-muted">No deliveries yet.</td></tr>
              </tbody>
            </table>
          </div>
          <p class="dev-muted" *ngIf="!webhooks.length">No webhook endpoints yet.</p>
          <form class="card-section dev-grid" *ngIf="!readOnly" (ngSubmit)="createWebhook()">
            <h2 class="h6 mb-0">Add a webhook endpoint</h2>
            <label>URL (https)<input class="form-control" name="whUrl" type="url" [(ngModel)]="newWebhook.url" placeholder="https://api.example.com/spreewe/webhooks" /></label>
            <label>Description (optional)<input class="form-control" name="whDesc" maxlength="200" [(ngModel)]="newWebhook.description" /></label>
            <fieldset>
              <legend class="setting-row__label">Events</legend>
              <label class="dev-scope" *ngFor="let e of events">
                <input type="checkbox" class="form-check-input mt-1" [checked]="newWebhook.events.has(e.type)" (change)="toggleEvent(e.type)" />
                <span><code>{{ e.type }}</code> <span class="dev-muted small">needs <code>{{ e.scope }}</code></span><span class="d-block dev-muted">{{ e.description }}</span></span>
              </label>
            </fieldset>
            <div class="dev-confirm">
              <input class="form-control" [(ngModel)]="confirmName" name="confirmWh" [placeholder]="'Type ' + app.name" aria-label="Application name to confirm" />
              <button type="submit" class="btn btn-primary" [disabled]="busy || confirmName !== app.name || !newWebhook.url || !newWebhook.events.size">Add endpoint</button>
            </div>
          </form>
        </div>

        <!-- ============================================================ usage -->
        <div class="card-section dev-grid" *ngIf="tab === 'usage'">
          <h2 class="h6 mb-0">Usage, last 30 days</h2>
          <div class="dev-row">
            <span><strong>{{ totals.apiRequests }}</strong> <span class="dev-muted">API requests</span></span>
            <span><strong>{{ totals.apiErrors }}</strong> <span class="dev-muted">errors</span></span>
            <span><strong>{{ totals.tokensIssued }}</strong> <span class="dev-muted">user tokens issued</span></span>
            <span><strong>{{ totals.socketConnections }}</strong> <span class="dev-muted">socket connections</span></span>
          </div>
          <p class="dev-muted small mb-0">Errors are authenticated requests answered with status 400 or higher. Requests with an invalid or expired token can't be attributed to an application and aren't counted.
            Limits: {{ app.quotas.rateLimitPerMinute }} requests/minute, {{ app.quotas.maxConnections }} socket connections.</p>
          <table class="dev-table" *ngIf="usage.length">
            <thead><tr><th>Day (UTC)</th><th>Requests</th><th>Errors</th><th>Tokens issued</th><th>Socket connections</th></tr></thead>
            <tbody><tr *ngFor="let u of usage"><td>{{ u.day }}</td><td>{{ u.apiRequests }}</td><td>{{ u.apiErrors }}</td><td>{{ u.tokensIssued }}</td><td>{{ u.socketConnections }}</td></tr></tbody>
          </table>
          <p class="dev-muted mb-0" *ngIf="!usage.length">No usage recorded yet.</p>
        </div>

        <!-- ============================================================ activity -->
        <div class="card-section" *ngIf="tab === 'activity'">
          <h2 class="h6">Activity</h2>
          <table class="dev-table" *ngIf="audit.length">
            <thead><tr><th>When</th><th>Action</th><th>By</th></tr></thead>
            <tbody><tr *ngFor="let a of audit"><td>{{ a.at | date: 'medium' }}</td><td><code>{{ a.action }}</code></td><td>{{ a.actorKind }}</td></tr></tbody>
          </table>
          <p class="dev-muted mb-0" *ngIf="!audit.length">No activity yet.</p>
        </div>

        <div class="dev-confirm mt-3" *ngIf="!readOnly && (tab === 'credentials' || tab === 'webhooks')">
          <input class="form-control" [(ngModel)]="confirmName" name="confirmFoot" [placeholder]="'Type ' + app.name + ' to confirm'" aria-label="Application name to confirm" />
          <span class="dev-muted small">Regenerating and revoking secrets, and deleting endpoints, need the application's exact name.</span>
        </div>
      </ng-container>
    </section>
  `,
})
export class DeveloperAppComponent implements OnInit {
  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' }, { id: 'credentials', label: 'Credentials' }, { id: 'permissions', label: 'Permissions' },
    { id: 'configuration', label: 'Configuration' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'usage', label: 'Usage' }, { id: 'activity', label: 'Activity' },
  ];
  tab: Tab = 'overview';
  app: DevApp | null = null;
  loading = true;
  loadError = '';
  busy = false;
  error = '';
  notice = '';
  confirmName = '';
  details = { name: '', description: '', websiteUrl: '' };
  credentials: Credential[] = [];
  secret: { keyId: string; value: string } | null = null;
  scopes: ScopeInfo[] = [];
  picked = new Set<string>();
  originsText = '';
  callbacksText = '';
  webhooks: WebhookEndpoint[] = [];
  events: WebhookEventType[] = [];
  newWebhook = { url: '', description: '', events: new Set<string>() };
  webhookSecret = '';
  deliveriesFor = '';
  deliveries: WebhookDelivery[] = [];
  usage: UsageDay[] = [];
  totals = { apiRequests: 0, apiErrors: 0, tokensIssued: 0, socketConnections: 0 };
  audit: AuditEntry[] = [];
  private appId = '';

  constructor(private dev: DeveloperService, private route: ActivatedRoute, private router: Router, private cdr: ChangeDetectorRef) {}

  get readOnly(): boolean { return this.app?.status === 'revoked'; }
  get statusLabel(): string { return this.app?.status === 'active' ? 'Enabled' : this.app?.status === 'suspended' ? 'Disabled' : 'Deleted'; }
  get statusClass(): string { return this.app?.status === 'active' ? 'dev-chip--ok' : this.app?.status === 'suspended' ? 'dev-chip--warn' : 'dev-chip--bad'; }

  async ngOnInit(): Promise<void> {
    this.appId = this.route.snapshot.paramMap.get('appId') || '';
    const tab = this.route.snapshot.queryParamMap.get('tab') as Tab | null;
    if (this.route.snapshot.queryParamMap.get('created')) this.notice = 'Application registered. Generate a client secret to start calling the API.';
    try {
      this.setApp(await this.dev.getApp(this.appId));
    } catch (e) {
      this.loadError = errorText(e, 'This application was not found.');
    }
    this.loading = false;
    if (this.app) await this.select(tab && this.tabs.some((t) => t.id === tab) ? tab : 'overview');
    this.cdr.markForCheck();
  }

  async select(tab: Tab): Promise<void> {
    this.tab = tab;
    this.error = '';
    void this.router.navigate([], { queryParams: { tab }, replaceUrl: true });
    await this.run(async () => {
      if (tab === 'credentials') this.credentials = await this.dev.credentials(this.appId);
      if (tab === 'permissions' && !this.scopes.length) this.scopes = await this.dev.scopes();
      if (tab === 'webhooks') {
        [this.webhooks, this.events] = await Promise.all([this.dev.webhooks(this.appId), this.events.length ? Promise.resolve(this.events) : this.dev.webhookEvents()]);
      }
      if (tab === 'usage') {
        this.usage = await this.dev.usage(this.appId, 30);
        this.totals = this.usage.reduce((t, u) => ({
          apiRequests: t.apiRequests + u.apiRequests, apiErrors: t.apiErrors + (u.apiErrors || 0),
          tokensIssued: t.tokensIssued + u.tokensIssued, socketConnections: t.socketConnections + u.socketConnections,
        }), { apiRequests: 0, apiErrors: 0, tokensIssued: 0, socketConnections: 0 });
      }
      if (tab === 'activity') this.audit = await this.dev.audit(this.appId);
    }, false);
  }

  // ------------------------------------------------------------------ overview
  saveDetails(): Promise<void> {
    return this.run(async () => {
      this.setApp(await this.dev.updateApp(this.appId, { name: this.details.name.trim(), description: this.details.description.trim(), websiteUrl: this.details.websiteUrl.trim() }));
      this.notice = 'Details saved.';
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.run(async () => {
      this.setApp(enabled ? await this.dev.reactivate(this.appId) : await this.dev.suspend(this.appId));
      this.notice = enabled ? 'Application enabled.' : 'Application disabled.';
    });
  }

  revokeTokens(): Promise<void> {
    return this.run(async () => {
      await this.dev.revokeAllTokens(this.appId, this.confirmName);
      this.notice = 'Every user token issued so far is revoked. Your server must request new ones.';
    });
  }

  deleteApp(): Promise<void> {
    return this.run(async () => {
      this.setApp(await this.dev.revoke(this.appId, this.confirmName));
      this.notice = 'Application deleted.';
    });
  }

  // ------------------------------------------------------------------ credentials
  createCredential(): Promise<void> {
    return this.run(async () => {
      const res = await this.dev.createCredential(this.appId, this.confirmName);
      this.secret = { keyId: res.credential.keyId, value: res.secret };
      this.credentials = await this.dev.credentials(this.appId);
    });
  }

  rotate(c: Credential): Promise<void> {
    return this.run(async () => {
      const res = await this.dev.rotateCredential(this.appId, c._id, this.confirmName);
      this.secret = { keyId: res.credential?.keyId || c.keyId, value: res.secret };
      this.credentials = await this.dev.credentials(this.appId);
    });
  }

  revokeCredential(c: Credential): Promise<void> {
    return this.run(async () => {
      await this.dev.revokeCredential(this.appId, c._id, this.confirmName);
      this.credentials = await this.dev.credentials(this.appId);
      this.notice = `Credential ${c.keyId} revoked.`;
    });
  }

  // ------------------------------------------------------------------ permissions + configuration
  togglePick(scope: string): void {
    this.picked.has(scope) ? this.picked.delete(scope) : this.picked.add(scope);
  }

  savePermissions(): Promise<void> {
    return this.run(async () => {
      this.setApp(await this.dev.updateApp(this.appId, { scopes: [...this.picked] }));
      this.notice = 'Permissions saved.';
    });
  }

  saveConfiguration(): Promise<void> {
    const lines = (t: string) => t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return this.run(async () => {
      this.setApp(await this.dev.updateApp(this.appId, { allowedOrigins: lines(this.originsText), callbackUrls: lines(this.callbacksText) }));
      this.notice = 'Configuration saved.';
    });
  }

  // ------------------------------------------------------------------ webhooks
  toggleEvent(type: string): void {
    this.newWebhook.events.has(type) ? this.newWebhook.events.delete(type) : this.newWebhook.events.add(type);
  }

  createWebhook(): Promise<void> {
    return this.run(async () => {
      const res = await this.dev.createWebhook(this.appId, {
        url: this.newWebhook.url.trim(), events: [...this.newWebhook.events], description: this.newWebhook.description.trim() || undefined,
      }, this.confirmName);
      this.webhookSecret = res.secret;
      this.newWebhook = { url: '', description: '', events: new Set() };
      this.webhooks = await this.dev.webhooks(this.appId);
      this.notice = 'Endpoint added. Verify it to start receiving deliveries.';
    });
  }

  webhookAction(w: WebhookEndpoint, action: 'verify' | 'disable' | 'enable'): Promise<void> {
    return this.run(async () => {
      if (action === 'verify') await this.dev.verifyWebhook(this.appId, w._id);
      if (action === 'disable') await this.dev.disableWebhook(this.appId, w._id);
      if (action === 'enable') await this.dev.enableWebhook(this.appId, w._id);
      this.webhooks = await this.dev.webhooks(this.appId);
      this.notice = action === 'verify' ? 'Verification sent.' : action === 'disable' ? 'Endpoint disabled.' : 'Endpoint enabled.';
    });
  }

  rotateWebhook(w: WebhookEndpoint): Promise<void> {
    return this.run(async () => {
      this.webhookSecret = (await this.dev.rotateWebhookSecret(this.appId, w._id, this.confirmName)).secret;
      this.webhooks = await this.dev.webhooks(this.appId);
    });
  }

  deleteWebhook(w: WebhookEndpoint): Promise<void> {
    return this.run(async () => {
      await this.dev.deleteWebhook(this.appId, w._id, this.confirmName);
      this.webhooks = await this.dev.webhooks(this.appId);
      this.notice = 'Endpoint deleted.';
    });
  }

  showDeliveries(w: WebhookEndpoint): Promise<void> {
    return this.run(async () => {
      this.deliveries = await this.dev.deliveries(this.appId, w._id);
      this.deliveriesFor = w._id;
    }, false);
  }

  retry(w: WebhookEndpoint, d: WebhookDelivery): Promise<void> {
    return this.run(async () => {
      await this.dev.retryDelivery(this.appId, w._id, d._id);
      this.deliveries = await this.dev.deliveries(this.appId, w._id);
      this.notice = 'Delivery queued again.';
    });
  }

  // ------------------------------------------------------------------ helpers
  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => { this.notice = 'Copied.'; this.cdr.markForCheck(); });
  }

  private setApp(app: DevApp): void {
    this.app = app;
    this.details = { name: app.name, description: app.description || '', websiteUrl: app.websiteUrl || '' };
    this.picked = new Set(app.scopes);
    this.originsText = app.allowedOrigins.join('\n');
    this.callbacksText = app.callbackUrls.join('\n');
  }

  private async run(fn: () => Promise<void>, clearNotice = true): Promise<void> {
    this.busy = true;
    this.error = '';
    if (clearNotice) this.notice = '';
    this.cdr.markForCheck();
    try {
      await fn();
    } catch (e) {
      this.error = errorText(e);
    }
    this.busy = false;
    this.cdr.markForCheck();
  }
}
