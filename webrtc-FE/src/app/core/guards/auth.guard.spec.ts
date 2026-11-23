import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { AuthGuard } from './auth.guard';
import { AuthService } from 'src/app/core/services/auth.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

/** App pages need a Clerk session AND a usable app account; anything else goes to sign-in. */
describe('AuthGuard', () => {
  let clerk: { waitForSession: jasmine.Spy };
  let auth: jasmine.SpyObj<AuthService>;
  let socket: jasmine.SpyObj<SocketService>;
  let alert: jasmine.SpyObj<AlertService>;
  let guard: AuthGuard;
  let router: Router;

  beforeEach(() => {
    clerk = { waitForSession: jasmine.createSpy() };
    auth = jasmine.createSpyObj<AuthService>('AuthService', ['ensureAppUser', 'logout']);
    socket = jasmine.createSpyObj<SocketService>('SocketService', ['ensureConnected']);
    alert = jasmine.createSpyObj<AlertService>('AlertService', ['error']);
    TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      providers: [
        { provide: ClerkService, useValue: clerk },
        { provide: AuthService, useValue: auth },
        { provide: SocketService, useValue: socket },
        { provide: AlertService, useValue: alert },
      ],
    });
    guard = TestBed.inject(AuthGuard);
    router = TestBed.inject(Router);
  });

  it('no session: sign-in, keeping a deep link to return to', async () => {
    clerk.waitForSession.and.resolveTo(false);
    const result = await guard.canActivate(undefined, { url: '/meet/abc' } as any);
    expect(router.serializeUrl(result as UrlTree)).toBe('/auth/login?returnUrl=%2Fmeet%2Fabc');
    expect(socket.ensureConnected).not.toHaveBeenCalled();
  });

  it('session + app account: allowed, socket connected', async () => {
    clerk.waitForSession.and.resolveTo(true);
    auth.ensureAppUser.and.resolveTo(undefined as any);
    expect(await guard.canActivate(undefined, { url: '/chat' } as any)).toBeTrue();
    expect(socket.ensureConnected).toHaveBeenCalled();
  });

  it('developer portal (realtime: false): allowed without opening the chat socket', async () => {
    clerk.waitForSession.and.resolveTo(true);
    auth.ensureAppUser.and.resolveTo(undefined as any);
    expect(await guard.canActivate({ data: { realtime: false } } as any, { url: '/developer' } as any)).toBeTrue();
    expect(socket.ensureConnected).not.toHaveBeenCalled();
  });

  it('session but no usable app account: signed out and sent to sign-in (no bounce loop)', async () => {
    clerk.waitForSession.and.resolveTo(true);
    auth.ensureAppUser.and.rejectWith({ error: { message: 'Verify your email first' } });
    auth.logout.and.resolveTo(undefined as any);
    const result = await guard.canActivate(undefined, { url: '/chat' } as any);
    expect(router.serializeUrl(result as UrlTree)).toBe('/auth/login');
    expect(auth.logout).toHaveBeenCalledWith(false);
    expect(alert.error).toHaveBeenCalledWith('Verify your email first');
    expect(socket.ensureConnected).not.toHaveBeenCalled();
  });
});
