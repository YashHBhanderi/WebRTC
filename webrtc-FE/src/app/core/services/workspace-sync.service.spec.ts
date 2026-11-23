import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { HTTP_INTERCEPTORS, HttpClient } from '@angular/common/http';
import { RouterTestingModule } from '@angular/router/testing';
import { Subject, firstValueFrom } from 'rxjs';
import { WorkspaceSyncService, ViewRefresher, NOTICE_KEY, workspaceNavigation, takeNotice } from './workspace-sync.service';
import { SocketService } from './socket.service';
import { ClerkService, WORKSPACE_KEY, WorkspaceChangedError, tokenOrganizationId } from './clerk.service';
import { AuthInterceptor } from '../interceptors/auth.interceptor';
import { ErrorInterceptor } from '../interceptors/error.interceptor';
import { AlertService } from 'src/app/_shared/alert/alert.service';

/** A fake Clerk session token: only the payload matters here (signature is never checked client-side). */
const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`;
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('WorkspaceSyncService', () => {
  let events: Map<string, Subject<any>>;
  let socket: { onEvent: jasmine.Spy; onConnect: jasmine.Spy; onDisconnect: jasmine.Spy; connectWithToken: jasmine.Spy };
  let clerk: { pinnedOrganization: string | null; workspaceChanged$: Subject<string | null>; accountChanged$: Subject<void>; setActiveOrganization: jasmine.Spy };
  let service: WorkspaceSyncService;
  let http: HttpTestingController;
  let assign: jasmine.Spy;
  const subject = (name: string) => {
    if (!events.has(name)) events.set(name, new Subject());
    return events.get(name)!;
  };

  beforeEach(() => {
    events = new Map();
    socket = {
      onEvent: jasmine.createSpy().and.callFake((name: string) => subject(name)),
      onConnect: jasmine.createSpy().and.callFake(() => subject('connect')),
      onDisconnect: jasmine.createSpy().and.callFake(() => subject('disconnect')),
      connectWithToken: jasmine.createSpy(),
    };
    clerk = { pinnedOrganization: 'org_A', workspaceChanged$: new Subject(), accountChanged$: new Subject<void>(), setActiveOrganization: jasmine.createSpy().and.resolveTo(undefined) };
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [{ provide: SocketService, useValue: socket }, { provide: ClerkService, useValue: clerk }],
    });
    service = TestBed.inject(WorkspaceSyncService);
    http = TestBed.inject(HttpTestingController);
    assign = spyOn(workspaceNavigation, 'assign');
    sessionStorage.removeItem(NOTICE_KEY);
    service.activeOrganizationId = 't_A';
    service.start();
  });

  afterEach(() => service.ngOnDestroy());

  it('subscribes once, however often start() is called (no duplicate listeners)', () => {
    const calls = socket.onEvent.calls.count();
    service.start();
    expect(socket.onEvent.calls.count()).toBe(calls);
  });

  it('turns server events into view topics', () => {
    const seen: string[] = [];
    service.changes$.subscribe((t) => seen.push(t));
    subject('org:members-changed').next({ organizationId: 't_A' });
    subject('team:channels-changed').next({ teamId: 'T1' });
    expect(seen).toEqual(['members', 'org', 'channels:T1']);
  });

  it('ignores a workspace event naming another organization (never updates another tenant\'s views)', () => {
    const seen: string[] = [];
    service.changes$.subscribe((t) => seen.push(t));
    subject('org:members-changed').next({ organizationId: 't_OTHER' });
    subject('org:updated').next({ organizationId: 't_OTHER' });
    expect(seen).toEqual([]);
  });

  it('removed from the organization this tab shows: personal workspace, full reload, notice', async () => {
    subject('org:removed').next({ organizationId: 't_A', reason: 'removed' });
    await wait();
    expect(clerk.setActiveOrganization).toHaveBeenCalledWith(null);
    expect(assign).toHaveBeenCalledWith('/chat');
    expect(takeNotice()).toContain('removed from the organization');
  });

  it('removed from ANOTHER organization: only the workspace list refreshes', async () => {
    const seen: string[] = [];
    service.changes$.subscribe((t) => seen.push(t));
    subject('org:removed').next({ organizationId: 't_OTHER', reason: 'removed' });
    await wait();
    expect(seen).toEqual(['mine']);
    expect(assign).not.toHaveBeenCalled();
  });

  it('server closed the socket and refuses the workspace: leave it', async () => {
    subject('disconnect').next('io server disconnect');
    http.expectOne((r) => r.url.endsWith('/v1/workspace')).flush({ error: { message: 'You are not a member of this organization' } }, { status: 403, statusText: 'Forbidden' });
    await wait();
    expect(assign).toHaveBeenCalledWith('/chat');
    expect(socket.connectWithToken).not.toHaveBeenCalled();
  });

  it('server closed the socket but the workspace is still fine: reconnect (no reload)', async () => {
    subject('disconnect').next('io server disconnect');
    http.expectOne((r) => r.url.endsWith('/v1/workspace')).flush({ data: {} });
    await wait();
    expect(socket.connectWithToken).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('after a reconnect every open view refetches (events may have been missed)', () => {
    const seen: string[] = [];
    service.changes$.subscribe((t) => seen.push(t));
    subject('connect').next(undefined);
    subject('connect').next(undefined);
    expect(seen).toEqual(['*']);
  });

  it('another tab switched workspace: this tab reloads into it and says why', () => {
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_KEY, newValue: JSON.stringify({ organizationId: 'org_B', at: 1 }) }));
    expect(assign).toHaveBeenCalledWith('/');
    expect(sessionStorage.getItem(NOTICE_KEY)).toContain('another tab');
  });

  it('another tab announcing the workspace this tab already shows changes nothing', () => {
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_KEY, newValue: JSON.stringify({ organizationId: 'org_A', at: 1 }) }));
    expect(assign).not.toHaveBeenCalled();
  });

  it('a token for another workspace (session changed elsewhere) reloads the tab', () => {
    clerk.workspaceChanged$.next('org_B');
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('another account became active (added / switched, here or in another tab): forget this one and restart', () => {
    localStorage.setItem('user', JSON.stringify({ _id: 'u1' }));
    clerk.accountChanged$.next();
    expect(localStorage.getItem('user')).toBeNull();
    expect(assign).toHaveBeenCalledWith('/chat');
  });
});

describe('ViewRefresher', () => {
  const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  it('coalesces a burst of signals into one load', async () => {
    const load = jasmine.createSpy().and.resolveTo(undefined);
    const r = new ViewRefresher(load, 20);
    r.notify('members');
    r.notify('members');
    r.notify('org');
    await wait();
    expect(load).toHaveBeenCalledTimes(1);
    expect([...load.calls.argsFor(0)[0]].sort()).toEqual(['members', 'org']);
  });

  it('a mutation plus the signals it causes = one load, after the mutation', async () => {
    const order: string[] = [];
    const load = jasmine.createSpy().and.callFake(async () => { order.push('load'); });
    const r = new ViewRefresher(load, 20);
    await r.mutate(async () => {
      r.notify('members'); // echo of my own change, while it is in flight
      order.push('mutation');
    }, ['members']);
    await wait();
    expect(order).toEqual(['mutation', 'load']);
  });

  it('a failed mutation still reloads (the view shows the real state) and rethrows', async () => {
    const load = jasmine.createSpy().and.resolveTo(undefined);
    const r = new ViewRefresher(load, 20);
    await expectAsync(r.mutate(() => Promise.reject('refused'), ['members'])).toBeRejectedWith('refused');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does nothing after destroy (a destroyed page makes no requests)', async () => {
    const load = jasmine.createSpy().and.resolveTo(undefined);
    const r = new ViewRefresher(load, 20);
    r.notify('members');
    r.destroy();
    await wait();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('Workspace guard (tokens must match the workspace this tab shows)', () => {
  it('reads the organization from Clerk session tokens (v2 and v1 claims)', () => {
    expect(tokenOrganizationId(token({ o: { id: 'org_A' } }))).toBe('org_A');
    expect(tokenOrganizationId(token({ org_id: 'org_B' }))).toBe('org_B');
    expect(tokenOrganizationId(token({ sub: 'user_1' }))).toBeNull();
  });

  function clerkWith(sessionToken: string, pinned: string | null): ClerkService {
    const svc = TestBed.inject(ClerkService);
    (svc as any).clerk = { session: { getToken: () => Promise.resolve(sessionToken) } };
    (svc as any).pinnedOrganizationId = pinned;
    return svc;
  }

  beforeEach(() => TestBed.configureTestingModule({
    imports: [HttpClientTestingModule, RouterTestingModule],
    providers: [
      { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
      { provide: HTTP_INTERCEPTORS, useClass: ErrorInterceptor, multi: true },
      { provide: AlertService, useValue: jasmine.createSpyObj('AlertService', ['error', 'warning', 'info', 'success']) },
    ],
  }));

  it('passes a token for the workspace this tab shows', async () => {
    const clerk = clerkWith(token({ o: { id: 'org_A' } }), 'org_A');
    expect(await clerk.getToken()).toBeTruthy();
    expect(clerk.workspaceMismatch).toBeFalse();
  });

  it('refuses a token for another workspace, once and for good, and says so', async () => {
    const clerk = clerkWith(token({ o: { id: 'org_B' } }), 'org_A');
    const changed = firstValueFrom(clerk.workspaceChanged$);
    expect(await clerk.getToken()).toBeNull();
    expect(await changed).toBe('org_B');
    expect(clerk.workspaceMismatch).toBeTrue();
  });

  it('a personal tab refuses an organization token', async () => {
    const clerk = clerkWith(token({ o: { id: 'org_B' } }), null);
    expect(await clerk.getToken()).toBeNull();
  });

  it('after a mismatch no request is sent, and the user is NOT signed out', async () => {
    const clerk = clerkWith(token({ o: { id: 'org_B' } }), 'org_A');
    Object.defineProperty(clerk, 'isSignedIn', { get: () => true });
    const signOut = spyOn(clerk, 'signOut').and.resolveTo(undefined);
    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);
    let error: unknown;
    await firstValueFrom(http.get('/v1/workspace')).catch((e) => (error = e));
    expect(error).toEqual(jasmine.any(WorkspaceChangedError));
    backend.expectNone('/v1/workspace');
    expect(signOut).not.toHaveBeenCalled();
  });
});
