import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { clearPortal, getPortal, portalOfUrl, setPortal } from 'src/app/core/services/portal';
import { choosePortal, safeReturnUrl } from 'src/app/authentication/login/login.component';
import { landingGuard, requirePortal } from './portal.guard';
import { guestGuard } from './guest.guard';

/** Personal app and Developer Portal stay apart; the landing page is for signed-out visitors only. */
describe('portals', () => {
  let clerk: { isSignedIn: boolean };
  let router: Router;
  const run = (guard: any, route: any = {}) => TestBed.runInInjectionContext(() => guard(route, {} as any));
  const url = (r: unknown) => router.serializeUrl(r as UrlTree);

  beforeEach(() => {
    clearPortal();
    clerk = { isSignedIn: false };
    TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      providers: [{ provide: ClerkService, useValue: clerk }],
    });
    router = TestBed.inject(Router);
  });

  afterEach(() => clearPortal());

  it('defaults to the personal portal', () => {
    expect(getPortal()).toBe('personal');
    expect(safeReturnUrl(null)).toBe('/chat');
  });

  it('classifies URLs by portal', () => {
    expect(portalOfUrl('/developer')).toBe('developer');
    expect(portalOfUrl('/developer/apps/1?tab=webhooks')).toBe('developer');
    expect(portalOfUrl('/developers-team')).toBe('personal');
    expect(portalOfUrl('/meet/abc')).toBe('personal');
    expect(portalOfUrl('/consent?request=1')).toBeNull();
    expect(portalOfUrl('/')).toBeNull();
    expect(portalOfUrl('https://evil.com')).toBeNull();
  });

  it('sign-in picks the portal from the link, then the deep link, then the last one used', () => {
    expect(choosePortal('developer', '/meet/abc')).toBe('developer');
    expect(choosePortal(null, '/meet/abc')).toBe('personal');
    expect(choosePortal(null, '/developer/docs')).toBe('developer');
    expect(choosePortal('bogus', null)).toBe('developer');
    expect(safeReturnUrl(null)).toBe('/developer');
    expect(safeReturnUrl('//evil.com')).toBe('/developer');
  });

  it('a developer session cannot open personal pages, and vice versa', () => {
    setPortal('developer');
    expect(url(run(requirePortal('personal')))).toBe('/developer');
    expect(run(requirePortal('developer'))).toBeTrue();
    setPortal('personal');
    expect(url(run(requirePortal('developer')))).toBe('/chat');
    expect(run(requirePortal('personal'))).toBeTrue();
  });

  it('landing page: shown when signed out, skipped to the portal when signed in', () => {
    expect(run(landingGuard)).toBeTrue();
    clerk.isSignedIn = true;
    setPortal('developer');
    expect(url(run(landingGuard))).toBe('/developer');
  });

  it('sign-in page while signed in: honours ?portal= and goes to that portal', () => {
    clerk.isSignedIn = true;
    const route = (params: Record<string, string>) => ({ queryParamMap: { get: (k: string) => params[k] ?? null } });
    expect(url(run(guestGuard, route({ portal: 'developer' })))).toBe('/developer');
    expect(getPortal()).toBe('developer');
    expect(url(run(guestGuard, route({ portal: 'personal' })))).toBe('/chat');
  });
});
