import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, HttpContext } from '@angular/common/http';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { ErrorInterceptor, SKIP_ERROR_TOAST } from './error.interceptor';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ClerkService } from 'src/app/core/services/clerk.service';

/** Error toasts must never show server internals; 401 retries once with a fresh token, then signs out. */
describe('ErrorInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let alert: jasmine.SpyObj<AlertService>;
  let clerk: { isSignedIn: boolean; getToken: jasmine.Spy; signOut: jasmine.Spy };
  let router: { url: string; navigate: jasmine.Spy };

  beforeEach(() => {
    alert = jasmine.createSpyObj<AlertService>('AlertService', ['error', 'warning', 'success', 'info']);
    clerk = { isSignedIn: true, getToken: jasmine.createSpy().and.resolveTo('fresh-token'), signOut: jasmine.createSpy().and.resolveTo(undefined) };
    router = { url: '/chat', navigate: jasmine.createSpy() };
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: HTTP_INTERCEPTORS, useClass: ErrorInterceptor, multi: true },
        { provide: AlertService, useValue: alert },
        { provide: ClerkService, useValue: clerk },
        { provide: Router, useValue: router },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });
  afterEach(() => backend.verify());

  it('never shows a 5xx body (stack traces, internals): a generic message instead', (done) => {
    http.get('/x').subscribe({ error: (msg) => {
      expect(msg).not.toContain('MongoServerError');
      expect(alert.error).toHaveBeenCalledTimes(1);
      expect(alert.error.calls.mostRecent().args[0]).not.toContain('MongoServerError');
      done();
    } });
    backend.expectOne('/x').flush({ message: 'MongoServerError: E11000 dup key { email: "a@b.c" } at /srv/app.js:10' }, { status: 500, statusText: 'Server Error' });
  });

  it('shows the user-facing 4xx message and respects SKIP_ERROR_TOAST', (done) => {
    http.get('/y', { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }).subscribe({ error: (msg) => {
      expect(msg).toBe('Choose at least one permission');
      expect(alert.error).not.toHaveBeenCalled();
      done();
    } });
    backend.expectOne('/y').flush({ message: 'Choose at least one permission' }, { status: 400, statusText: 'Bad Request' });
  });

  it('401: retries once with a fresh token; a second 401 signs out', (done) => {
    http.get('/z').subscribe({ error: () => {
      expect(clerk.getToken).toHaveBeenCalledOnceWith({ skipCache: true });
      expect(clerk.signOut).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/auth/login']);
      done();
    } });
    backend.expectOne('/z').flush({}, { status: 401, statusText: 'Unauthorized' });
    setTimeout(() => {
      const retry = backend.expectOne('/z');
      expect(retry.request.headers.get('Authorization')).toBe('Bearer fresh-token');
      retry.flush({}, { status: 401, statusText: 'Unauthorized' });
    });
  });
});
