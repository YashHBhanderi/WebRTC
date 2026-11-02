import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { DeveloperService, ScopeInfo, WebhookEventType } from 'src/app/core/services/developer.service';
import { environment } from 'src/environments/environment';

interface Snippet { id: string; title: string; code: string }

/**
 * /developer/docs — integration guide inside the portal: registration, credentials, consent, user
 * tokens, calling the API, realtime, webhooks, errors and limits. The permission and webhook-event
 * lists are loaded live from the server, so they always match what it enforces.
 * Full reference: docs/developer (REST v1 and session endpoints, realtime events, OpenAPI).
 */
@Component({
  selector: 'app-developer-docs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', './developer.scss'],
  template: `
    <section class="page">
      <p class="mb-2"><a routerLink="/developer">← Developer portal</a></p>
      <header class="page__header">
        <h1 class="page__title">SpreeWe API documentation</h1>
        <p class="dev-muted mb-0">How to connect your application to SpreeWe. API base URL: <span class="dev-mono">{{ base }}</span> (all paths also work under <code>/api</code>).</p>
      </header>

      <nav class="card-section dev-row" aria-label="Contents">
        <a *ngFor="let s of toc" [href]="'#' + s.id" (click)="jump($event, s.id)">{{ s.label }}</a>
      </nav>

      <article class="card-section dev-grid" id="overview">
        <h2 class="h5 mb-0">1. How it works</h2>
        <ol class="mb-0">
          <li><strong>Register</strong> an application in this portal and generate a <strong>client ID and secret</strong>. The secret is shown once; keep it on your server.</li>
          <li><strong>Ask each user for consent.</strong> Your server creates a consent request; the user approves the permissions they want in SpreeWe and is sent back to your redirect URL.</li>
          <li><strong>Exchange for a user token.</strong> Your server trades its credentials for a short-lived, scoped token for that user.</li>
          <li><strong>Call the API</strong> with <code>Authorization: Bearer &lt;user token&gt;</code>, open a realtime socket, and receive <strong>webhooks</strong>.</li>
        </ol>
        <div class="dev-warn">Messages are end-to-end encrypted on users' own devices. Application tokens can read conversation and message <em>metadata</em> but never message content, and cannot send messages.</div>
      </article>

      <article class="card-section dev-grid" id="credentials">
        <h2 class="h5 mb-0">2. Credentials</h2>
        <p class="mb-0">Your server authenticates with HTTP Basic: <code>base64(clientId:clientSecret)</code>. Client IDs start with <code>swk_test_</code> (development) or <code>swk_live_</code> (production); secrets with <code>sws_</code>.
          Regenerating a secret keeps the old one valid for a grace period (default one hour). Never send the secret to a browser or a mobile app.</p>
        <ng-container *ngTemplateOutlet="code; context: { $implicit: snippet('basic') }"></ng-container>
      </article>

      <article class="card-section dev-grid" id="consent">
        <h2 class="h5 mb-0">3. User consent</h2>
        <p class="mb-0"><code>redirectUri</code> must exactly match one of your application's redirect URLs. The request expires after 10 minutes and works once. Send the user's browser to <code>consentUrl</code>.</p>
        <ng-container *ngTemplateOutlet="code; context: { $implicit: snippet('consent') }"></ng-container>
        <p class="mb-0">SpreeWe then redirects the browser to your <code>redirectUri</code> with <code>?state=…&amp;result=approved&amp;grant=…</code>, or <code>?state=…&amp;error=access_denied</code>. Check that <code>state</code> is the value you sent.</p>
      </article>

      <article class="card-section dev-grid" id="tokens">
        <h2 class="h5 mb-0">4. User tokens</h2>
        <p class="mb-0">Exchange for the user by <code>externalUserRef</code> (your own id, linked during consent) or by <code>userId</code>. Tokens last 600 seconds by default (at most 900). There is no refresh token: request a new one before <code>expiresAt</code>.
          A token carries only the permissions present in your application, the user's approval and your request.</p>
        <ng-container *ngTemplateOutlet="code; context: { $implicit: snippet('token') }"></ng-container>
      </article>

      <article class="card-section dev-grid" id="calls">
        <h2 class="h5 mb-0">5. Calling the API</h2>
        <ng-container *ngTemplateOutlet="code; context: { $implicit: snippet('call') }"></ng-container>
        <table class="dev-table">
          <thead><tr><th>Endpoint</th><th>Permission</th></tr></thead>
          <tbody>
            <tr><td><code>GET /v1/me</code></td><td><code>profile:read</code></td></tr>
            <tr><td><code>GET /v1/directory</code></td><td><code>directory:read</code></td></tr>
            <tr><td><code>GET /v1/conversations</code></td><td><code>conversations:read</code></td></tr>
            <tr><td><code>GET /v1/conversations/{{ '{' }}id{{ '}' }}/messages</code> (metadata; content removed)</td><td><code>messages:read</code></td></tr>
            <tr><td><code>GET /v1/calls</code></td><td><code>calls:read</code></td></tr>
            <tr><td><code>GET /v1/recordings/{{ '{' }}id{{ '}' }}</code></td><td><code>recordings:read</code></td></tr>
          </tbody>
        </table>
        <p class="dev-muted small mb-0">Successful responses are <code>{{ '{' }} "data": … {{ '}' }}</code> (lists add <code>"page": {{ '{' }} "nextCursor" {{ '}' }}</code>; pass it back as <code>?cursor=</code>). Errors are <code>{{ '{' }} "error": {{ '{' }} "code", "message", "details" {{ '}' }} {{ '}' }}</code>.</p>
      </article>

      <article class="card-section dev-grid" id="permissions">
        <h2 class="h5 mb-0">6. Permissions</h2>
        <p class="dev-muted small mb-0">Loaded from the server. Sensitive permissions are highlighted to users on the consent screen.</p>
        <table class="dev-table" *ngIf="scopes.length">
          <thead><tr><th>Permission</th><th>What it allows</th></tr></thead>
          <tbody><tr *ngFor="let s of scopes"><td><code>{{ s.scope }}</code>
            <span class="dev-chip dev-chip--warn" *ngIf="s.sensitive">sensitive</span>
            <span class="dev-chip dev-chip--bad" *ngIf="!s.available">not available</span></td><td>{{ s.description }}</td></tr></tbody>
        </table>
      </article>

      <article class="card-section dev-grid" id="realtime">
        <h2 class="h5 mb-0">7. Realtime (Socket.IO)</h2>
        <p class="mb-0">Needs <code>realtime:connect</code>. Pass the user token in the handshake; from a browser, its origin must be one of your application's allowed origins. The server disconnects the socket when the token expires: reconnect with a new token.
          Application sockets receive presence and, with <code>messages:read</code>, <code>receiveMessage</code> / <code>message:updated</code> / <code>message:deleted</code> without content. They can't send events.</p>
        <ng-container *ngTemplateOutlet="code; context: { $implicit: snippet('socket') }"></ng-container>
      </article>

      <article class="card-section dev-grid" id="webhooks">
        <h2 class="h5 mb-0">8. Webhooks</h2>
        <p class="mb-0">Add an endpoint on your application's Webhooks tab, then <strong>Verify</strong> it: SpreeWe posts a <code>webhook.verification</code> event and your endpoint must answer 2xx with <code>{{ '{' }}"challenge": "&lt;data.challenge&gt;"{{ '}' }}</code>.
          Delivery is at least once; de-duplicate on <code>SpreeWe-Webhook-Id</code>. After 15 consecutive failures an endpoint is disabled.</p>
        <ng-container *ngTemplateOutlet="code; context: { $implicit: snippet('webhook') }"></ng-container>
        <table class="dev-table" *ngIf="events.length">
          <thead><tr><th>Event</th><th>Needs</th><th>Description</th></tr></thead>
          <tbody><tr *ngFor="let e of events"><td><code>{{ e.type }}</code></td><td><code>{{ e.scope }}</code></td><td>{{ e.description }}</td></tr></tbody>
        </table>
      </article>

      <article class="card-section dev-grid" id="errors">
        <h2 class="h5 mb-0">9. Errors and limits</h2>
        <table class="dev-table">
          <thead><tr><th>Status</th><th>Code</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>400</td><td><code>VALIDATION_ERROR</code></td><td>Invalid parameters or body (see <code>details</code>)</td></tr>
            <tr><td>401</td><td><code>AUTHENTICATION_ERROR</code></td><td>Missing, invalid or expired token or credential, or the application is disabled or deleted</td></tr>
            <tr><td>403</td><td><code>PERMISSION_ERROR</code></td><td>The token lacks the permission for this endpoint</td></tr>
            <tr><td>404</td><td><code>NOT_FOUND_ERROR</code></td><td>Doesn't exist or isn't visible to this user</td></tr>
            <tr><td>429</td><td><code>RATE_LIMIT_ERROR</code></td><td>Too many requests; slow down and retry</td></tr>
          </tbody>
        </table>
        <p class="dev-muted small mb-0">Your application's limits and daily usage (requests, errors, tokens, sockets) are on its Usage and Configuration tabs.</p>
      </article>

      <article class="card-section dev-grid" id="more">
        <h2 class="h5 mb-0">10. Full reference</h2>
        <p class="mb-0">The complete REST reference (including end-user session endpoints), the realtime event reference and the machine-readable OpenAPI specification are in the SpreeWe repository under <code>docs/developer</code> and <code>docs/api/openapi.yaml</code>.</p>
      </article>

      <ng-template #code let-s>
        <div class="dev-code">
          <div class="dev-row dev-row--between"><span class="dev-muted small">{{ s.title }}</span>
            <button type="button" class="btn btn-sm btn-link" (click)="copy(s)">{{ copied === s.id ? 'Copied' : 'Copy' }}</button></div>
          <pre class="dev-mono mb-0">{{ s.code }}</pre>
        </div>
      </ng-template>
    </section>
  `,
  styles: [`.dev-code { border: 1px solid var(--app-border); border-radius: 8px; padding: 8px 12px; background: var(--app-surface-2); overflow-x: auto; }
            .dev-code pre { white-space: pre; }`],
})
export class DeveloperDocsComponent implements OnInit {
  readonly base = environment.apiUrl;
  readonly toc = [
    { id: 'overview', label: 'How it works' }, { id: 'credentials', label: 'Credentials' }, { id: 'consent', label: 'Consent' },
    { id: 'tokens', label: 'User tokens' }, { id: 'calls', label: 'Calling the API' }, { id: 'permissions', label: 'Permissions' },
    { id: 'realtime', label: 'Realtime' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'errors', label: 'Errors and limits' },
  ];
  scopes: ScopeInfo[] = [];
  events: WebhookEventType[] = [];
  copied = '';
  private readonly snippets: Snippet[];

  constructor(private dev: DeveloperService, private cdr: ChangeDetectorRef) {
    const b = this.base;
    this.snippets = [
      { id: 'basic', title: 'Server environment', code: `SPREEWE_API=${b}\nSPREEWE_CLIENT_ID=swk_test_...\nSPREEWE_CLIENT_SECRET=sws_...   # server only\n\n# Authorization header for server-to-server calls\nAuthorization: Basic $(printf '%s:%s' "$SPREEWE_CLIENT_ID" "$SPREEWE_CLIENT_SECRET" | base64)` },
      { id: 'consent', title: 'Your server: create a consent request', code: `curl -X POST "$SPREEWE_API/v1/consent-requests" \\\n  -u "$SPREEWE_CLIENT_ID:$SPREEWE_CLIENT_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"redirectUri":"https://app.example.com/spreewe/callback",\n       "scopes":["profile:read","conversations:read","realtime:connect"],\n       "state":"<random, at least 8 characters>",\n       "externalUserRef":"your-user-42"}'\n\n# → { "data": { "requestId": "…", "consentUrl": "…/consent?request=…", "expiresAt": "…" } }` },
      { id: 'token', title: 'Your server: get a user token', code: `curl -X POST "$SPREEWE_API/v1/app-tokens" \\\n  -u "$SPREEWE_CLIENT_ID:$SPREEWE_CLIENT_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"externalUserRef":"your-user-42","scopes":["profile:read","conversations:read"]}'\n\n# → { "data": { "accessToken": "…", "tokenType": "Bearer", "expiresIn": 600,\n#              "expiresAt": "…", "scopes": [ … ], "tokenId": "…", "tenantId": null } }` },
      { id: 'call', title: 'Call the API as the user', code: `curl "$SPREEWE_API/v1/me" -H "Authorization: Bearer $USER_TOKEN"\n\ncurl "$SPREEWE_API/v1/conversations?limit=20" -H "Authorization: Bearer $USER_TOKEN"` },
      { id: 'socket', title: 'Realtime (socket.io-client)', code: `import { io } from 'socket.io-client';\n\nconst socket = io('${b}', {\n  auth: async (cb) => cb({ token: await getUserTokenFromYourServer() }),\n});\nsocket.on('receiveMessage', (m) => console.log('new message in', m.conversationId)); // no content\nsocket.on('user:presence', (p) => console.log(p.userId, p.status));\nsocket.on('connect_error', (e) => console.warn(e.message));` },
      { id: 'webhook', title: 'Verify a webhook delivery (Node.js)', code: `import crypto from 'crypto';\n\n// id = SpreeWe-Webhook-Id, ts = SpreeWe-Webhook-Timestamp, sig = SpreeWe-Webhook-Signature, raw = raw body\nfunction verify(secret, id, ts, sig, raw) {\n  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;\n  const expected = crypto.createHmac('sha256', secret).update(\`\${id}.\${ts}.\${raw}\`).digest();\n  return sig.split(' ').some((part) => {\n    const got = Buffer.from(part.startsWith('v1=') ? part.slice(3) : '', 'hex');\n    return got.length === expected.length && crypto.timingSafeEqual(got, expected);\n  });\n}` },
    ];
  }

  async ngOnInit(): Promise<void> {
    try {
      [this.scopes, this.events] = await Promise.all([this.dev.scopes(), this.dev.webhookEvents()]);
    } catch { /* the lists are optional on this page */ }
    this.cdr.markForCheck();
  }

  snippet(id: string): Snippet {
    return this.snippets.find((s) => s.id === id)!;
  }

  copy(s: Snippet): void {
    void navigator.clipboard?.writeText(s.code).then(() => { this.copied = s.id; this.cdr.markForCheck(); });
  }

  jump(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }
}
