import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { environment } from 'src/environments/environment';
import { DeveloperService } from './developer.service';

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
});
