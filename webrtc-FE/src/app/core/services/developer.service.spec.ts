import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { environment } from 'src/environments/environment';
import { DeveloperService, appKind } from './developer.service';

describe('DeveloperService (Developer Portal API client)', () => {
  let service: DeveloperService;
  let http: HttpTestingController;
  const api = `${environment.apiUrl}/v1`;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(DeveloperService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('registers an application with details, environment and permissions', async () => {
    const done = service.createApp({ name: 'Acme', description: 'Desk', websiteUrl: 'https://acme.example', environment: 'development', scopes: ['profile:read'] });
    const req = http.expectOne(`${api}/apps`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Acme', description: 'Desk', websiteUrl: 'https://acme.example', environment: 'development', scopes: ['profile:read'] });
    req.flush({ data: { _id: 'a1', name: 'Acme' } });
    expect((await done)._id).toBe('a1');
  });

  it('disables and enables without confirmation; deletes and revokes tokens with the app name', async () => {
    const calls: [Promise<unknown>, string, unknown][] = [
      [service.suspend('a1'), `${api}/apps/a1/suspend`, {}],
      [service.reactivate('a1'), `${api}/apps/a1/reactivate`, {}],
      [service.revoke('a1', 'Acme'), `${api}/apps/a1/revoke`, { confirm: 'Acme' }],
      [service.revokeAllTokens('a1', 'Acme'), `${api}/apps/a1/tokens/revoke-all`, { confirm: 'Acme' }],
    ];
    for (const [, url, body] of calls) {
      const req = http.expectOne(url);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(body);
      req.flush({ data: {} });
    }
    await Promise.all(calls.map((c) => c[0]));
  });

  it('returns a new secret once from create / regenerate and keeps no copy', async () => {
    const created = service.createCredential('a1', 'Acme');
    const req = http.expectOne(`${api}/apps/a1/credentials`);
    expect(req.request.body).toEqual({ confirm: 'Acme' });
    req.flush({ data: { credential: { _id: 'c1', keyId: 'swk_test_x' }, secret: 'sws_secret' } });
    expect((await created).secret).toBe('sws_secret');

    const rotated = service.rotateCredential('a1', 'c1', 'Acme');
    const r2 = http.expectOne(`${api}/apps/a1/credentials/c1/rotate`);
    expect(r2.request.body).toEqual({ confirm: 'Acme' });
    r2.flush({ data: { credential: { _id: 'c2', keyId: 'swk_test_y' }, secret: 'sws_new' } });
    expect((await rotated).secret).toBe('sws_new');

    // Nothing secret-shaped is kept on the service instance
    expect(JSON.stringify(Object.values(service))).not.toContain('sws_');
  });

  it('updates permissions and configuration through PATCH /apps/:id', async () => {
    const done = service.updateApp('a1', { scopes: ['profile:read'], allowedOrigins: ['https://app.example'], callbackUrls: ['https://app.example/cb'] });
    const req = http.expectOne(`${api}/apps/a1`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ scopes: ['profile:read'], allowedOrigins: ['https://app.example'], callbackUrls: ['https://app.example/cb'] });
    req.flush({ data: { _id: 'a1' } });
    await done;
  });

  it('loads permission and webhook-event catalogues, usage and webhook deliveries', async () => {
    const all = Promise.all([service.scopes(), service.webhookEvents(), service.usage('a1', 7), service.deliveries('a1', 'w1')]);
    http.expectOne(`${api}/scopes`).flush({ data: [{ scope: 'profile:read', description: 'd', sensitive: false, available: true }] });
    http.expectOne(`${api}/webhook-events`).flush({ data: [] });
    http.expectOne(`${api}/apps/a1/usage?days=7`).flush({ data: [{ day: '2026-11-02', apiRequests: 3, apiErrors: 1 }] });
    http.expectOne(`${api}/apps/a1/webhooks/w1/deliveries`).flush({ data: [], page: { nextCursor: null } });
    const [scopes, , usage, deliveries] = await all;
    expect(scopes[0].scope).toBe('profile:read');
    expect(usage[0].apiErrors).toBe(1);
    expect(deliveries).toEqual([]);
  });

  it('approves consent with only the scopes the user picked', async () => {
    const done = service.approveConsent('r1', ['profile:read']);
    const req = http.expectOne(`${api}/consent-requests/r1/approve`);
    expect(req.request.body).toEqual({ scopes: ['profile:read'] });
    req.flush({ data: { redirectUrl: 'https://app.example/cb?state=s&result=approved&grant=g', scopes: ['profile:read'] } });
    expect((await done).redirectUrl).toContain('result=approved');
  });
  // ---------------------------------------------------------------- application users (own tenant)

  it('tells the three kinds of application apart', () => {
    expect(appKind({ tenantId: 't1', dedicatedTenant: true })).toBe('dedicated');
    expect(appKind({ tenantId: 't1', dedicatedTenant: false })).toBe('workspace');
    expect(appKind({ tenantId: 't1' })).toBe('workspace'); // older servers send no flag
    expect(appKind({ tenantId: null })).toBe('legacy');
    expect(appKind(null)).toBe('legacy');
  });

  it('lists one application\'s users by page, cursor and status, through the owner\'s session route', async () => {
    const first = service.appUsers('a1');
    const r1 = http.expectOne((r) => r.url === `${api}/apps/a1/users`);
    expect(r1.request.method).toBe('GET');
    expect(r1.request.params.get('limit')).toBe('25');
    expect(r1.request.params.has('cursor')).toBe(false);
    expect(r1.request.params.has('status')).toBe(false);
    // No credential travels from the browser: the session interceptor authenticates the call
    expect(r1.request.headers.has('Authorization')).toBe(false);
    r1.flush({ data: [{ _id: 'u1', externalUserId: 'x-1', name: 'Asha Rao', status: 'active' }], page: { nextCursor: 'c2' } });
    expect(await first).toEqual({ items: [{ _id: 'u1', externalUserId: 'x-1', name: 'Asha Rao', status: 'active' } as any], nextCursor: 'c2' });

    const next = service.appUsers('a1', { cursor: 'c2', status: 'deactivated', limit: 10 });
    const r2 = http.expectOne((r) => r.url === `${api}/apps/a1/users`);
    expect(r2.request.params.get('cursor')).toBe('c2');
    expect(r2.request.params.get('status')).toBe('deactivated');
    expect(r2.request.params.get('limit')).toBe('10');
    r2.flush({ data: [] });
    expect(await next).toEqual({ items: [], nextCursor: null });
  });

  it('registers, reads, updates, deactivates and reactivates a user of the application', async () => {
    const created = service.registerAppUser('a1', { externalUserId: 'x-1', name: 'Asha Rao', email: 'asha@example.com' });
    const c = http.expectOne(`${api}/apps/a1/users`);
    expect(c.request.method).toBe('POST');
    expect(c.request.body).toEqual({ externalUserId: 'x-1', name: 'Asha Rao', email: 'asha@example.com' });
    // The tenant is never sent: the server takes it from the application
    expect(Object.keys(c.request.body)).not.toContain('tenantId');
    c.flush({ data: { _id: 'u1', externalUserId: 'x-1', tenantId: 't1', status: 'active' } });
    expect((await created).tenantId).toBe('t1');

    const read = service.appUser('a1', 'org|user:42@x');
    const g = http.expectOne(`${api}/apps/a1/users/org%7Cuser%3A42%40x`);
    expect(g.request.method).toBe('GET');
    g.flush({ data: { _id: 'u2' } });
    expect((await read)._id).toBe('u2');

    const calls: [Promise<unknown>, unknown][] = [
      [service.updateAppUser('a1', 'x-1', { name: 'Asha R.', email: '' }), { name: 'Asha R.', email: '' }],
      [service.updateAppUser('a1', 'x-1', { active: false }), { active: false }],
      [service.updateAppUser('a1', 'x-1', { active: true }), { active: true }],
    ];
    const reqs = http.match(`${api}/apps/a1/users/x-1`);
    expect(reqs.length).toBe(3);
    reqs.forEach((req, i) => {
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual(calls[i][1]);
      req.flush({ data: { _id: 'u1', status: i === 1 ? 'deactivated' : 'active' } });
    });
    await Promise.all(calls.map((x) => x[0]));
  });

  it('passes server refusals through (duplicate id, not the owner, application without its own tenant)', async () => {
    for (const [status, message] of [[409, 'A user with this externalUserId is already registered'], [404, 'App not found'], [403, 'This app has no tenant of its own']] as [number, string][]) {
      const attempt = service.registerAppUser('a1', { externalUserId: 'x-1', name: 'Asha Rao' }).then(() => null, (e) => e);
      http.expectOne(`${api}/apps/a1/users`).flush({ error: { code: 'X', message } }, { status, statusText: 'Refused' });
      const error = await attempt;
      expect(error.status).toBe(status);
      expect(error.error.error.message).toBe(message);
    }
  });
});
