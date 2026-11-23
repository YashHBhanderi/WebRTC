import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Injector, NgZone } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { Subject, of } from 'rxjs';
import { NewChatDialogComponent } from './chat/new-chat-dialog.component';
import { ContactService } from 'src/app/core/services/contact.service';
import { UserService } from 'src/app/core/services/user.service';
import { OrganizationService } from 'src/app/core/services/organization.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { WorkspaceSyncService, workspaceNavigation } from 'src/app/core/services/workspace-sync.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { PageRoutingModule } from './pages-routing.module';

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const text = (el: HTMLElement) => el.textContent || '';

describe('New chat (people list filtered as you type; anyone else by exact email)', () => {
  const directory = [{ _id: 'u1', username: 'Ann Lee', avatar: '' }, { _id: 'u2', username: 'Bob Stone', avatar: '' }];
  function setup(contacts: Partial<Record<keyof ContactService, jasmine.Spy>>, inOrganization = false, externalPeople: any[] = []) {
    const router = { navigate: jasmine.createSpy().and.resolveTo(true) };
    const modal = jasmine.createSpyObj<NgbActiveModal>('NgbActiveModal', ['close', 'dismiss']);
    const users = { getAllUsersExceptCurrentUser: jasmine.createSpy().and.returnValue(of({ data: directory })) };
    TestBed.configureTestingModule({
      imports: [FormsModule],
      declarations: [NewChatDialogComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [{ provide: ContactService, useValue: contacts }, { provide: UserService, useValue: users }, { provide: Router, useValue: router }, { provide: NgbActiveModal, useValue: modal }],
    });
    const fixture = TestBed.createComponent(NewChatDialogComponent);
    fixture.componentInstance.inOrganization = inOrganization;
    fixture.componentInstance.externalPeople = externalPeople;
    fixture.detectChanges();
    return { fixture, cmp: fixture.componentInstance, router, modal, el: fixture.nativeElement as HTMLElement };
  }

  it('has no scope buttons and no Find button: one search box', async () => {
    const { fixture, el } = setup({}, true);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(text(el)).not.toContain('In this organization');
    expect(text(el)).not.toContain('Find');
    expect(el.querySelectorAll('input[type="search"]').length).toBe(1);
  });

  it('lists people with their pictures and filters as you type; External people are labelled', async () => {
    const { cmp, fixture, el } = setup({ lookup: jasmine.createSpy() }, true, [{ _id: 'x9', username: 'Partner Pat', avatar: '' }]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelectorAll('.person-row').length).toBe(3);
    expect(el.querySelectorAll('app-avatar').length).toBe(3);
    expect(text(el)).toContain('External');
    cmp.onQuery('bo');
    fixture.detectChanges();
    expect(Array.from(el.querySelectorAll<HTMLElement>('.person-row')).map(text).join()).toContain('Bob Stone');
    expect(el.querySelectorAll('.person-row').length).toBe(1);
  });

  it('choosing someone from the list opens the chat with them', async () => {
    const { cmp, fixture, router, modal } = setup({});
    await fixture.whenStable();
    cmp.open(cmp.people[0]);
    expect(modal.close).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/chat'], { queryParams: { user: 'u1' } });
  });

  it('a complete email is looked up after typing pauses (no request for partial text)', fakeAsync(() => {
    const lookup = jasmine.createSpy().and.resolveTo({ found: false, message: 'No eligible account found for this email.' });
    const { cmp } = setup({ lookup });
    cmp.onQuery('ann@exa');
    tick(1000);
    expect(lookup).not.toHaveBeenCalled();
    cmp.onQuery('ann@example.com');
    tick(200);
    expect(lookup).not.toHaveBeenCalled();
    tick(400);
    flushMicrotasks();
    expect(lookup).toHaveBeenCalledOnceWith('ann@example.com', undefined);
  }));

  it('shows the found person and opens the chat by id (personal context: no scope sent)', async () => {
    const lookup = jasmine.createSpy().and.resolveTo({ found: true, user: { _id: 'u7', username: 'Cara', avatar: '' }, external: false, conversationId: null });
    const start = jasmine.createSpy().and.resolveTo({ conversationId: 'c9', external: false });
    const { cmp, fixture, el, router, modal } = setup({ lookup, start });
    cmp.query = 'cara@example.com';
    await cmp.find();
    fixture.detectChanges();
    expect(text(el)).toContain('Cara');
    await cmp.start();
    expect(start).toHaveBeenCalledWith('cara@example.com', undefined);
    expect(modal.close).toHaveBeenCalledWith('c9');
    expect(router.navigate).toHaveBeenCalledWith(['/chat'], { queryParams: { c: 'c9', user: 'u7' } });
  });

  it('organization context: members first, then people outside it (labelled External, started with that scope)', async () => {
    const lookup = jasmine.createSpy().and.returnValues(
      Promise.resolve({ found: false, message: 'No eligible account found for this email.' }),
      Promise.resolve({ found: true, user: { _id: 'x', username: 'Out', avatar: '' }, external: true, conversationId: null }),
    );
    const start = jasmine.createSpy().and.resolveTo({ conversationId: 'c1', external: true });
    const { cmp, fixture, el } = setup({ lookup, start }, true);
    cmp.query = 'out@else.com';
    await cmp.find();
    fixture.detectChanges();
    expect(lookup.calls.allArgs()).toEqual([['out@else.com', 'member'], ['out@else.com', 'external']]);
    expect(text(el)).toContain('External');
    await cmp.start();
    expect(start).toHaveBeenCalledWith('out@else.com', 'external');
  });

  it("shows the server's policy refusal and the rate-limit explanation", async () => {
    const lookup = jasmine.createSpy().and.returnValues(
      Promise.reject({ status: 403, error: { error: { message: "This organization's policy does not permit starting external conversations." } } }),
      Promise.reject({ status: 429, error: { error: { message: 'Too many lookups. Please wait a few minutes and try again.' } } }),
    );
    const { cmp, fixture, el } = setup({ lookup });
    cmp.query = 'a@b.co';
    await cmp.find();
    fixture.detectChanges();
    expect(text(el)).toContain('policy does not permit');
    await cmp.find();
    fixture.detectChanges();
    expect(text(el)).toContain('Too many lookups');
  });
});

/** A Clerk session token with the given subject (user) and organization claims (unsigned; parsing only). */
const token = (sub: string, org: string | null = null) => `h.${btoa(JSON.stringify({ sub, ...(org ? { o: { id: org } } : {}) })).replace(/=+$/, '')}.s`;

describe('Accounts on this browser (Clerk multi-session)', () => {
  /** ClerkService around a stand-in for Clerk's browser SDK (the real one needs a live Clerk instance). */
  function setup(opts: { single?: boolean; sessions?: { id: string; user: string; name: string }[]; current?: string } = {}) {
    const sessions = (opts.sessions || [{ id: 'sess_a', user: 'user_a', name: 'Ann' }]).map((x) => ({
      id: x.id,
      user: { id: x.user, fullName: x.name, primaryEmailAddress: { emailAddress: `${x.name.toLowerCase()}@example.com` }, imageUrl: '' },
      getToken: jasmine.createSpy().and.resolveTo(token(x.user)),
    }));
    const current = sessions.find((x) => x.id === (opts.current || sessions[0].id))!;
    const fake: any = {
      loaded: true,
      isSignedIn: true,
      session: current,
      user: current.user,
      client: { signedInSessions: sessions },
      __internal_environment: { authConfig: { singleSessionMode: opts.single ?? false } },
      setActive: jasmine.createSpy().and.callFake(async ({ session }: { session: string }) => {
        fake.session = sessions.find((x) => x.id === session);
        fake.user = fake.session?.user;
      }),
      signOut: jasmine.createSpy().and.resolveTo(undefined),
      openSignIn: jasmine.createSpy(),
    };
    const clerk = new ClerkService(TestBed.inject(NgZone), TestBed.inject(Injector));
    Object.assign(clerk as any, { clerk: fake, pinnedOrganizationId: null, pinnedUserId: current.user.id, hadSession: true });
    return { clerk, fake, sessions };
  }

  it('lists the accounts signed in here, the current one first', () => {
    const { clerk } = setup({ sessions: [{ id: 's1', user: 'u1', name: 'Ann' }, { id: 's2', user: 'u2', name: 'Bob' }], current: 's2' });
    expect(clerk.accounts().map((x) => [x.name, x.email, x.current])).toEqual([['Bob', 'bob@example.com', true], ['Ann', 'ann@example.com', false]]);
  });

  it('adding an account opens Clerk\'s sign-in only when the instance allows several accounts', () => {
    expect(setup({ single: true }).clerk.multiAccountEnabled).toBeFalse();
    const { clerk, fake } = setup({ single: false });
    expect(clerk.multiAccountEnabled).toBeTrue();
    clerk.addAccount();
    expect(fake.openSignIn).toHaveBeenCalled();
  });

  it('switching account activates that session', async () => {
    const { clerk, fake } = setup({ sessions: [{ id: 's1', user: 'u1', name: 'Ann' }, { id: 's2', user: 'u2', name: 'Bob' }] });
    await clerk.switchAccount('s2');
    expect(fake.setActive).toHaveBeenCalledWith({ session: 's2' });
  });

  it('signing out keeps the other accounts: the next one becomes active; the last one signs out completely', async () => {
    const two = setup({ sessions: [{ id: 's1', user: 'u1', name: 'Ann' }, { id: 's2', user: 'u2', name: 'Bob' }] });
    expect(await two.clerk.signOut()).toBeTrue();
    expect(two.fake.signOut).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(two.fake.setActive).toHaveBeenCalledWith({ session: 's2' });
    const one = setup();
    expect(await one.clerk.signOut()).toBeFalse();
    expect(one.fake.signOut).toHaveBeenCalledWith();
  });

  it('never hands out another account\'s token in a tab loaded for this account (switched in another tab)', async () => {
    const { clerk, fake } = setup();
    const changed = jasmine.createSpy();
    clerk.accountChanged$.subscribe(changed);
    expect(await clerk.getToken()).toBe(token('user_a'));
    fake.session = { id: 'sess_b', getToken: jasmine.createSpy().and.resolveTo(token('user_b')) };
    expect(await clerk.getToken()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(clerk.workspaceMismatch).toBeTrue();
  });
});

describe('Canonical organization navigation', () => {
  it('the former Account page redirects; create / join organization and member / invitation links resolve', () => {
    // Read the route table from the module's RouterModule.forChild configuration
    TestBed.configureTestingModule({ imports: [PageRoutingModule] });
    const config = TestBed.inject(Router).config;
    const flat: Routes = [];
    const walk = (rs: Routes) => rs.forEach((r) => { flat.push(r); if (r.children) walk(r.children); });
    walk(config);
    const byPath = (p: string) => flat.find((r) => r.path === p);
    expect(byPath('account')?.redirectTo).toBe('profile');
    expect(byPath('organizations/new')?.component).toBeTruthy();
    expect(byPath('organizations/join')?.component).toBeTruthy();
    expect(byPath('organization/members')?.redirectTo).toBe('organization/settings?tab=members');
    expect(byPath('organization/invitations')?.redirectTo).toBe('organization/settings?tab=members&invite=1');
    expect(byPath('organization/settings')).toBeTruthy();
    expect(byPath('organization')).toBeTruthy();
  });
});
