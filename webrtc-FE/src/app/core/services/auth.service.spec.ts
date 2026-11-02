import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { AuthService } from './auth.service';
import { ClerkService } from './clerk.service';

describe('AuthService', () => {
  let clerk: { getToken: jasmine.Spy; isSignedIn: boolean; userId: string; activeOrganizationId: string | null; setActiveOrganization: jasmine.Spy };
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    clerk = {
      getToken: jasmine.createSpy().and.resolveTo('fresh'), isSignedIn: true, userId: 'user_1', activeOrganizationId: null,
      setActiveOrganization: jasmine.createSpy().and.callFake(async (id: string | null) => { clerk.activeOrganizationId = id; }),
    };
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule, RouterTestingModule], providers: [{ provide: ClerkService, useValue: clerk }] });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it('asks Clerk for tokens (never a stored copy)', async () => {
    expect(await service.getToken({ skipCache: true })).toBe('fresh');
    expect(clerk.getToken).toHaveBeenCalledWith({ skipCache: true });
  });

  it('sign-in into an organization the server refuses falls back to the personal workspace instead of locking the user out', async () => {
    clerk.activeOrganizationId = 'org_removed';
    const done = service.ensureAppUser();
    http.expectOne((r) => r.url.endsWith('/web/user/me')).flush({ message: 'You are not a member of this organization' }, { status: 403, statusText: 'Forbidden' });
    await new Promise((r) => setTimeout(r));
    expect(clerk.setActiveOrganization).toHaveBeenCalledOnceWith(null);
    http.expectOne((r) => r.url.endsWith('/web/user/me')).flush({ data: { _id: 'u1', username: 'me' } });
    await done;
    expect(service.getLoggedInUser()._id).toBe('u1');
    expect(service.workspaceFallback).toBeTrue();
  });

  it('without an active organization a refusal is still an error (nothing to fall back from)', async () => {
    const done = service.ensureAppUser();
    http.expectOne((r) => r.url.endsWith('/web/user/me')).flush({ message: 'Verify your email' }, { status: 403, statusText: 'Forbidden' });
    await expectAsync(done).toBeRejected();
    expect(clerk.setActiveOrganization).not.toHaveBeenCalled();
  });
});
