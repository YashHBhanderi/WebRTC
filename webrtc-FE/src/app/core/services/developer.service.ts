import { Injectable } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';

/**
 * Developer Portal: the signed-in user's developer applications on the SpreeWe /v1 developer API.
 * Every rule (ownership, confirmation, scopes, status) is enforced by the server; this service only
 * calls it. Secrets are returned by the server exactly once (create / regenerate) and are never stored
 * here. See docs/developer/authentication.md.
 */
export type AppEnvironment = 'development' | 'production';
export type AppStatus = 'active' | 'suspended' | 'revoked';

export interface DevApp {
  _id: string;
  name: string;
  description: string;
  websiteUrl: string;
  environment: AppEnvironment;
  status: AppStatus;
  /** The only tenant the application acts in (null: a legacy application linked to SpreeWe accounts by consent) */
  tenantId: string | null;
  /** true: the application has its own tenant and registers its own users (no consent / OAuth) */
  dedicatedTenant?: boolean;
  scopes: string[];
  allowedOrigins: string[];
  callbackUrls: string[];
  quotas: { rateLimitPerMinute: number; maxConnections: number; messagesPerDay: number };
  createdAt: string;
  updatedAt: string;
}

export interface NewApp {
  name: string;
  description?: string;
  websiteUrl?: string;
  environment: AppEnvironment;
  tenantBound?: boolean;
  scopes?: string[];
  allowedOrigins?: string[];
  callbackUrls?: string[];
}

export type AppPatch = Partial<Pick<DevApp, 'name' | 'description' | 'websiteUrl' | 'scopes' | 'allowedOrigins' | 'callbackUrls'>>;

export interface Credential {
  _id: string;
  keyId: string;
  hint: string;
  status: 'active' | 'rotated' | 'revoked';
  graceUntil: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** A user the application registered in its own tenant */
export interface AppUser {
  _id: string;
  externalUserId: string;
  name: string;
  email: string | null;
  avatarUrl: string;
  status: 'active' | 'deactivated';
  tenantId: string;
  createdAt: string;
  deactivatedAt: string | null;
}
export interface NewAppUser { externalUserId: string; name: string; email?: string }
export interface AppUserPatch { name?: string; email?: string; active?: boolean }
export interface AppUserPage { items: AppUser[]; nextCursor: string | null }
export type AppKind = 'dedicated' | 'workspace' | 'legacy';

/** How an application gets its users: its own tenant, an organization's members, or (legacy) SpreeWe accounts by consent */
export function appKind(app: Pick<DevApp, 'tenantId' | 'dedicatedTenant'> | null | undefined): AppKind {
  if (app?.dedicatedTenant) return 'dedicated';
  return app?.tenantId ? 'workspace' : 'legacy';
}

export interface ScopeInfo { scope: string; description: string; sensitive: boolean; available: boolean }
export interface UsageDay { day: string; apiRequests: number; apiErrors: number; tokensIssued: number; messagesSent: number; socketConnections: number }
export interface AuditEntry { action: string; actorKind: string; actorUserId: string | null; at: string }
export interface WebhookEventType { type: string; scope: string; description: string }

export interface WebhookEndpoint {
  _id: string;
  url: string;
  description: string;
  events: string[];
  status: 'pending_verification' | 'active' | 'disabled';
  consecutiveFailures: number;
  disabledReason: string | null;
  verifiedAt: string | null;
  secrets: { id: string; hint: string; expiresAt: string | null }[];
}

export interface WebhookDelivery {
  _id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'delivering' | 'retrying' | 'succeeded' | 'dead' | 'cancelled';
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

export interface ConsentView {
  requestId: string;
  app: { _id: string; name: string; description: string; websiteUrl: string; environment: AppEnvironment; ownerName: string; tenantBound: boolean; tenantId: string | null };
  scopes: (ScopeInfo & { available: boolean })[];
  redirectHost: string;
  expiresAt: string;
}

@Injectable({ providedIn: 'root' })
export class DeveloperService {
  private readonly api = `${environment.apiUrl}/v1`;
  /** Errors are shown inline by the portal screens (no global toast) */
  private readonly quiet = { context: new HttpContext().set(SKIP_ERROR_TOAST, true) };

  constructor(private http: HttpClient) {}

  private async get<T>(path: string): Promise<T> {
    return (await firstValueFrom(this.http.get<{ data: T }>(`${this.api}${path}`, this.quiet))).data;
  }

  private async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await firstValueFrom(this.http.post<{ data: T }>(`${this.api}${path}`, body, this.quiet))).data;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    return (await firstValueFrom(this.http.patch<{ data: T }>(`${this.api}${path}`, body, this.quiet))).data;
  }

  // ------------------------------------------------------------------ catalogues
  scopes(): Promise<ScopeInfo[]> { return this.get('/scopes'); }
  webhookEvents(): Promise<WebhookEventType[]> { return this.get('/webhook-events'); }

  // ------------------------------------------------------------------ apps
  listApps(): Promise<DevApp[]> { return this.get('/apps'); }
  getApp(appId: string): Promise<DevApp> { return this.get(`/apps/${appId}`); }
  createApp(input: NewApp): Promise<DevApp> { return this.post('/apps', input); }
  updateApp(appId: string, patch: AppPatch): Promise<DevApp> { return this.patch(`/apps/${appId}`, patch); }
  /** Disable: credentials and tokens stop working until enabled again */
  suspend(appId: string): Promise<DevApp> { return this.post(`/apps/${appId}/suspend`); }
  reactivate(appId: string): Promise<DevApp> { return this.post(`/apps/${appId}/reactivate`); }
  /** Delete (permanent revoke; the record and audit trail are kept). `confirm` = the app's exact name */
  revoke(appId: string, confirm: string): Promise<DevApp> { return this.post(`/apps/${appId}/revoke`, { confirm }); }
  revokeAllTokens(appId: string, confirm: string): Promise<{ revoked: boolean }> { return this.post(`/apps/${appId}/tokens/revoke-all`, { confirm }); }
  usage(appId: string, days = 30): Promise<UsageDay[]> { return this.get(`/apps/${appId}/usage?days=${days}`); }
  audit(appId: string): Promise<AuditEntry[]> { return this.get(`/apps/${appId}/audit`); }

  // ------------------------------------------------------------------ credentials (secret returned once)
  credentials(appId: string): Promise<Credential[]> { return this.get(`/apps/${appId}/credentials`); }
  createCredential(appId: string, confirm: string, expiresInDays?: number): Promise<{ credential: Credential; secret: string }> {
    return this.post(`/apps/${appId}/credentials`, expiresInDays ? { confirm, expiresInDays } : { confirm });
  }
  rotateCredential(appId: string, credentialId: string, confirm: string): Promise<{ credential: Credential; secret: string }> {
    return this.post(`/apps/${appId}/credentials/${credentialId}/rotate`, { confirm });
  }
  revokeCredential(appId: string, credentialId: string, confirm: string): Promise<Credential> {
    return this.post(`/apps/${appId}/credentials/${credentialId}/revoke`, { confirm });
  }

  // ------------------------------------------------------------------ webhooks (signing secret returned once)
  webhooks(appId: string): Promise<WebhookEndpoint[]> { return this.get(`/apps/${appId}/webhooks`); }
  createWebhook(appId: string, input: { url: string; events: string[]; description?: string }, confirm: string): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    return this.post(`/apps/${appId}/webhooks`, { ...input, confirm });
  }
  updateWebhook(appId: string, endpointId: string, patch: { url?: string; events?: string[]; description?: string }): Promise<WebhookEndpoint> {
    return this.patch(`/apps/${appId}/webhooks/${endpointId}`, patch);
  }
  verifyWebhook(appId: string, endpointId: string): Promise<WebhookEndpoint> { return this.post(`/apps/${appId}/webhooks/${endpointId}/verify`); }
  disableWebhook(appId: string, endpointId: string): Promise<WebhookEndpoint> { return this.post(`/apps/${appId}/webhooks/${endpointId}/disable`); }
  enableWebhook(appId: string, endpointId: string): Promise<WebhookEndpoint> { return this.post(`/apps/${appId}/webhooks/${endpointId}/enable`); }
  rotateWebhookSecret(appId: string, endpointId: string, confirm: string): Promise<{ secret: string; keptSecrets: number }> {
    return this.post(`/apps/${appId}/webhooks/${endpointId}/rotate-secret`, { confirm });
  }
  deleteWebhook(appId: string, endpointId: string, confirm: string): Promise<unknown> {
    return this.post(`/apps/${appId}/webhooks/${endpointId}/delete`, { confirm });
  }
  deliveries(appId: string, endpointId: string): Promise<WebhookDelivery[]> { return this.get(`/apps/${appId}/webhooks/${endpointId}/deliveries`); }
  retryDelivery(appId: string, endpointId: string, deliveryId: string): Promise<WebhookDelivery> {
    return this.post(`/apps/${appId}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`);
  }

  // ------------------------------------------------------------------ application users (applications with their own tenant)
  /**
   * Users registered in the application's tenant. The server lists only this application's users and
   * only to its owner; the portal never holds the client secret.
   */
  async appUsers(appId: string, options: { cursor?: string | null; limit?: number; status?: 'active' | 'deactivated' | '' } = {}): Promise<AppUserPage> {
    const params: Record<string, string> = { limit: String(options.limit ?? 25) };
    if (options.cursor) params['cursor'] = options.cursor;
    if (options.status) params['status'] = options.status;
    const res = await firstValueFrom(this.http.get<{ data: AppUser[]; page?: { nextCursor: string | null } }>(`${this.api}/apps/${appId}/users`, { ...this.quiet, params }));
    return { items: res.data || [], nextCursor: res.page?.nextCursor ?? null };
  }
  appUser(appId: string, externalUserId: string): Promise<AppUser> { return this.get(`/apps/${appId}/users/${encodeURIComponent(externalUserId)}`); }
  registerAppUser(appId: string, input: NewAppUser): Promise<AppUser> { return this.post(`/apps/${appId}/users`, input); }
  /** Rename, change the email ('' clears it), or deactivate / reactivate (`active`) */
  updateAppUser(appId: string, externalUserId: string, patch: AppUserPatch): Promise<AppUser> {
    return this.patch(`/apps/${appId}/users/${encodeURIComponent(externalUserId)}`, patch);
  }

  // ------------------------------------------------------------------ consent (end user approving an app)
  consentRequest(requestId: string): Promise<ConsentView> { return this.get(`/consent-requests/${requestId}`); }
  approveConsent(requestId: string, scopes: string[]): Promise<{ redirectUrl: string; scopes: string[] }> {
    return this.post(`/consent-requests/${requestId}/approve`, { scopes });
  }
  denyConsent(requestId: string): Promise<{ redirectUrl: string }> { return this.post(`/consent-requests/${requestId}/deny`); }
}
