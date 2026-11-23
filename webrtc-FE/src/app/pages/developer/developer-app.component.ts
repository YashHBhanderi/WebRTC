import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  AppKind, AppUser, AuditEntry, Credential, DevApp, DeveloperService, ScopeInfo, UsageDay, WebhookDelivery, WebhookEndpoint, WebhookEventType, appKind,
} from 'src/app/core/services/developer.service';
import { errorText } from 'src/app/core/services/organization.service';

type Tab = 'overview' | 'users' | 'credentials' | 'permissions' | 'configuration' | 'webhooks' | 'usage' | 'activity';

/**
 * /developer/apps/:appId — one application: details and status, credentials (secret shown once),
 * permissions, origins and redirect URLs, webhooks with deliveries, usage, audit trail.
 * Applications with their own tenant also get a Users tab (register, list, inspect, deactivate the
 * application's users) and no consent / OAuth settings; workspace and legacy applications keep theirs.
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
              <span *ngIf="kind === 'workspace'"> · workspace application</span>
              <span *ngIf="kind === 'dedicated'"> · own tenant</span>
              <span *ngIf="kind === 'legacy'"> · consent-based (legacy)</span></p>
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
            <div *ngIf="kind === 'dedicated'"><span class="dev-muted">Tenant ID</span><div class="dev-row"><span class="dev-mono">{{ app.tenantId }}</span><button type="button" class="btn btn-sm btn-link" (click)="copy(app.tenantId || '')">Copy</button></div></div>
            <div class="dev-muted small">Created {{ app.createdAt | date: 'medium' }} · updated {{ app.updatedAt | date: 'medium' }}</div>
          </div>
          <div class="card-section dev-grid" *ngIf="kind === 'dedicated'" data-test="kind-dedicated">
            <h2 class="h6 mb-0">Users</h2>
            <p class="mb-0">This application has its own tenant. Its users are the ones you register (on the Users tab, or from your server with <code>POST /v1/app-users</code>), and they can only find and talk to each other. SpreeWe accounts and other applications' users are never visible to them.</p>
            <div><button type="button" class="btn btn-outline-secondary btn-sm" (click)="select('users')">Manage users</button></div>
          </div>
          <div class="card-section dev-grid" *ngIf="kind === 'legacy'" data-test="kind-legacy">
            <h2 class="h6 mb-0">Users</h2>
            <p class="mb-0">This application was created before applications had their own tenant. SpreeWe account holders link to it by consent or OAuth, and it acts in their personal context. It keeps working as it is; to register your own users, register a new application.</p>
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

        <!-- ============================================================ users -->
        <div class="dev-grid" *ngIf="tab === 'users' && kind === 'dedicated'">
          <form class="card-section dev-grid" *ngIf="!readOnly" (ngSubmit)="registerUser()" aria-label="Register a user">
            <h2 class="h6 mb-0">Register a user</h2>
            <p class="dev-muted small mb-0">The user is created in this application's tenant only. Your server can do the same with <code>POST /v1/app-users</code> and then get tokens for them by their external ID.</p>
            <label>External user ID
              <input class="form-control dev-mono" name="newExternalId" [(ngModel)]="newUser.externalUserId" maxlength="200" placeholder="yourapp-user-42" autocomplete="off" />
              <span class="dev-muted small">Your own ID for this person. Unique in this application; letters, digits and . _ : &#64; | -</span>
            </label>
            <label>Display name
              <input class="form-control" name="newName" [(ngModel)]="newUser.name" minlength="3" maxlength="30" autocomplete="off" />
            </label>
            <label>Email (optional)
              <input class="form-control" name="newEmail" type="email" [(ngModel)]="newUser.email" maxlength="254" autocomplete="off" />
            </label>
            <div><button type="submit" class="btn btn-primary" [disabled]="busy || !canRegisterUser">Register user</button></div>
          </form>

          <div class="card-section dev-grid">
            <div class="dev-row dev-row--between">
              <h2 class="h6 mb-0">Registered users</h2>
              <label class="dev-row mb-0"><span class="dev-muted">Show</span>
                <select class="form-select form-select-sm" name="userStatus" [ngModel]="userStatus" (ngModelChange)="filterUsers($event)" aria-label="Filter by status">
                  <option value="">All</option><option value="active">Active</option><option value="deactivated">Deactivated</option>
                </select>
              </label>
            </div>
            <table class="dev-table" *ngIf="users.length">
              <thead><tr><th>Name</th><th>External ID</th><th>Email</th><th>Status</th><th>Registered</th><th></th></tr></thead>
              <tbody>
                <ng-container *ngFor="let u of users; trackBy: trackUser">
                  <tr>
                    <td>{{ u.name }}</td>
                    <td class="dev-mono">{{ u.externalUserId }}</td>
                    <td>{{ u.email || '—' }}</td>
                    <td><span class="dev-chip" [ngClass]="u.status === 'active' ? 'dev-chip--ok' : 'dev-chip--warn'">{{ u.status === 'active' ? 'Active' : 'Deactivated' }}</span></td>
                    <td>{{ u.createdAt | date: 'mediumDate' }}</td>
                    <td class="dev-row">
                      <button type="button" class="btn btn-sm btn-link" (click)="toggleUser(u)" [attr.aria-expanded]="openUser === u.externalUserId">{{ openUser === u.externalUserId ? 'Hide' : 'Details' }}</button>
                      <ng-container *ngIf="!readOnly">
                        <button type="button" class="btn btn-sm btn-outline-danger" *ngIf="u.status === 'active'" [disabled]="busy" (click)="setUserActive(u, false)">Deactivate</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" *ngIf="u.status !== 'active'" [disabled]="busy" (click)="setUserActive(u, true)">Reactivate</button>
                      </ng-container>
                    </td>
                  </tr>
                  <tr *ngIf="openUser === u.externalUserId">
                    <td colspan="6">
                      <div class="dev-grid">
                        <div><span class="dev-muted">SpreeWe user ID</span><div class="dev-row"><span class="dev-mono">{{ u._id }}</span><button type="button" class="btn btn-sm btn-link" (click)="copy(u._id)">Copy</button></div></div>
                        <div><span class="dev-muted">Tenant ID</span> <span class="dev-mono">{{ u.tenantId }}</span></div>
                        <div class="dev-muted small">Registered {{ u.createdAt | date: 'medium' }}<span *ngIf="u.deactivatedAt"> · deactivated {{ u.deactivatedAt | date: 'medium' }}</span></div>
                        <form class="dev-row" *ngIf="!readOnly" (ngSubmit)="saveUser(u)">
                          <input class="form-control" style="max-width: 220px" name="editName" [(ngModel)]="editUser.name" minlength="3" maxlength="30" aria-label="Display name" />
                          <input class="form-control" style="max-width: 260px" name="editEmail" type="email" [(ngModel)]="editUser.email" maxlength="254" placeholder="Email (optional)" aria-label="Email" />
                          <button type="submit" class="btn btn-sm btn-primary" [disabled]="busy || editUser.name.trim().length < 3">Save</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                </ng-container>
              </tbody>
            </table>
            <p class="dev-muted mb-0" *ngIf="!users.length && usersLoaded">{{ userStatus ? 'No users with this status.' : 'No users registered yet.' }}</p>
            <div *ngIf="usersCursor"><button type="button" class="btn btn-outline-secondary btn-sm" [disabled]="busy" (click)="moreUsers()">Load more</button></div>
            <p class="dev-muted small mb-0">Deactivating a user stops their tokens immediately and removes them from your directory. Their past messages stay.</p>
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
          <ng-container *ngIf="usesConsent">
            <h2 class="h6 mb-0 mt-2">Redirect URLs</h2>
            <p class="dev-muted small mb-0">Where SpreeWe sends users back after they approve or deny your application (the <code>redirectUri</code> of a consent request must match one exactly). One per line.</p>
            <textarea class="form-control dev-mono" name="callbacks" rows="3" [(ngModel)]="callbacksText" [disabled]="readOnly" placeholder="https://app.example.com/spreewe/callback"></textarea>
          </ng-container>
          <p class="dev-muted small mb-0" *ngIf="!usesConsent" data-test="no-consent">Consent and OAuth sign-in don't apply to this application: it registers its own users, so there are no redirect URLs to configure.</p>
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
  private readonly allTabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' }, { id: 'users', label: 'Users' }, { id: 'credentials', label: 'Credentials' }, { id: 'permissions', label: 'Permissions' },
    { id: 'configuration', label: 'Configuration' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'usage', label: 'Usage' }, { id: 'activity', label: 'Activity' },
  ];
  /** The Users tab exists only for applications with their own tenant */
  tabs: { id: Tab; label: string }[] = this.allTabs.filter((t) => t.id !== 'users');
  kind: AppKind = 'legacy';
  users: AppUser[] = [];
  usersCursor: string | null = null;
  usersLoaded = false;
  userStatus: '' | 'active' | 'deactivated' = '';
  newUser = { externalUserId: '', name: '', email: '' };
  openUser = '';
  editUser = { name: '', email: '' };
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
  /** Consent and OAuth (redirect URLs) exist for workspace and legacy applications only */
  get usesConsent(): boolean { return this.kind !== 'dedicated'; }
  get canRegisterUser(): boolean {
    return /^[\w.:@|-]{1,200}$/.test(this.newUser.externalUserId.trim()) && this.newUser.name.trim().length >= 3;
  }
  get statusLabel(): string { return this.app?.status === 'active' ? 'Enabled' : this.app?.status === 'suspended' ? 'Disabled' : 'Deleted'; }
  get statusClass(): string { return this.app?.status === 'active' ? 'dev-chip--ok' : this.app?.status === 'suspended' ? 'dev-chip--warn' : 'dev-chip--bad'; }

  async ngOnInit(): Promise<void> {
    this.appId = this.route.snapshot.paramMap.get('appId') || '';
    const tab = this.route.snapshot.queryParamMap.get('tab') as Tab | null;
    const created = !!this.route.snapshot.queryParamMap.get('created');
    try {
      this.setApp(await this.dev.getApp(this.appId));
    } catch (e) {
      this.loadError = errorText(e, 'This application was not found.');
    }
    this.loading = false;
    if (created) {
      this.notice = this.kind === 'dedicated'
        ? 'Application registered with its own tenant. Generate a client secret, then register your users.'
        : 'Application registered. Generate a client secret to start calling the API.';
    }
    if (this.app) await this.select(tab && this.tabs.some((t) => t.id === tab) ? tab : 'overview');
    this.cdr.markForCheck();
  }

  async select(tab: Tab): Promise<void> {
    if (!this.tabs.some((t) => t.id === tab)) tab = 'overview';
    this.tab = tab;
    this.error = '';
    void this.router.navigate([], { queryParams: { tab }, replaceUrl: true });
    await this.run(async () => {
      if (tab === 'users') await this.loadUsers(true);
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
      // Redirect URLs are not shown for applications with their own tenant, so they are not sent either
      this.setApp(await this.dev.updateApp(this.appId, { allowedOrigins: lines(this.originsText), ...(this.usesConsent ? { callbackUrls: lines(this.callbacksText) } : {}) }));
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

  // ------------------------------------------------------------------ users (applications with their own tenant)
  private async loadUsers(reset: boolean): Promise<void> {
    const page = await this.dev.appUsers(this.appId, { cursor: reset ? null : this.usersCursor, status: this.userStatus });
    this.users = reset ? page.items : [...this.users, ...page.items];
    this.usersCursor = page.nextCursor;
    this.usersLoaded = true;
  }

  filterUsers(status: '' | 'active' | 'deactivated'): Promise<void> {
    this.userStatus = status;
    this.openUser = '';
    return this.run(() => this.loadUsers(true), false);
  }

  moreUsers(): Promise<void> {
    return this.run(() => this.loadUsers(false), false);
  }

  registerUser(): Promise<void> {
    if (!this.canRegisterUser) return Promise.resolve();
    return this.run(async () => {
      const email = this.newUser.email.trim();
      const user = await this.dev.registerAppUser(this.appId, { externalUserId: this.newUser.externalUserId.trim(), name: this.newUser.name.trim(), ...(email ? { email } : {}) });
      this.newUser = { externalUserId: '', name: '', email: '' };
      await this.loadUsers(true);
      this.notice = `${user.name} is registered.`;
    });
  }

  toggleUser(u: AppUser): void {
    this.openUser = this.openUser === u.externalUserId ? '' : u.externalUserId;
    this.editUser = { name: u.name, email: u.email || '' };
  }

  saveUser(u: AppUser): Promise<void> {
    return this.run(async () => {
      this.replaceUser(await this.dev.updateAppUser(this.appId, u.externalUserId, { name: this.editUser.name.trim(), email: this.editUser.email.trim() }));
      this.notice = 'User updated.';
    });
  }

  setUserActive(u: AppUser, active: boolean): Promise<void> {
    return this.run(async () => {
      const updated = await this.dev.updateAppUser(this.appId, u.externalUserId, { active });
      // A status filter no longer matches the changed user: drop it from the list
      if (this.userStatus && updated.status !== this.userStatus) this.users = this.users.filter((x) => x.externalUserId !== u.externalUserId);
      else this.replaceUser(updated);
      this.notice = active ? `${updated.name} is active again.` : `${updated.name} is deactivated. Their tokens no longer work.`;
    });
  }

  trackUser(_i: number, u: AppUser): string { return u._id; }

  private replaceUser(updated: AppUser): void {
    this.users = this.users.map((x) => (x.externalUserId === updated.externalUserId ? updated : x));
  }

  // ------------------------------------------------------------------ helpers
  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => { this.notice = 'Copied.'; this.cdr.markForCheck(); });
  }

  private setApp(app: DevApp): void {
    this.app = app;
    this.kind = appKind(app);
    this.tabs = this.allTabs.filter((t) => t.id !== 'users' || this.kind === 'dedicated');
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
