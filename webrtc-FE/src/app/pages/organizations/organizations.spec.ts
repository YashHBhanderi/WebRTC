import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { CreateOrganizationComponent } from './create-organization.component';
import { InvitationAcceptComponent } from './invitation-accept.component';
import { OrganizationSettingsComponent } from './organization-settings.component';
import { JoinOrganizationComponent } from './join-organization.component';
import { TeamPageComponent } from './team-page.component';
import { pageNavigation } from './org-navigation';
import { OrganizationService, OrgOverview } from 'src/app/core/services/organization.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { Subject, of } from 'rxjs';
import { WorkspaceSyncService } from 'src/app/core/services/workspace-sync.service';

/** Organization screens: what users can do, and that the UI never assumes rights the server didn't report. */
const flush = () => new Promise((r) => setTimeout(r));
const alert = () => {
  const a = jasmine.createSpyObj<AlertService>('AlertService', ['success', 'error', 'info', 'warning', 'confirm']);
  a.confirm.and.resolveTo(true);
  return a;
};
/** Server change signals, driven by the test */
const syncStub = () => ({ changes$: new Subject<string>(), activeOrganizationId: null as string | null, leaveWorkspace: jasmine.createSpy().and.resolveTo(undefined) });
const route = (query: Record<string, string> = {}, params: Record<string, string> = {}) => ({ snapshot: { queryParamMap: convertToParamMap(query), paramMap: convertToParamMap(params) }, paramMap: of(convertToParamMap(params)) });
const text = (f: ComponentFixture<unknown>) => (f.nativeElement as HTMLElement).textContent || '';

function setup<T>(component: new (...a: any[]) => T, orgs: Partial<Record<keyof OrganizationService, jasmine.Spy>>, extra: unknown[] = []) {
  const clerk = { activateNewOrganization: jasmine.createSpy().and.resolveTo(undefined), activeOrganizationId: 'org_1', pinnedOrganization: 'org_1' };
  const sync = syncStub();
  const router = { navigate: jasmine.createSpy().and.resolveTo(true) };
  TestBed.configureTestingModule({
    imports: [FormsModule],
    declarations: [component],
    schemas: [NO_ERRORS_SCHEMA],
    providers: [
      { provide: OrganizationService, useValue: orgs },
      { provide: ClerkService, useValue: clerk },
      { provide: Router, useValue: router },
      { provide: AlertService, useValue: alert() },
      { provide: AuthService, useValue: { getLoggedInUser: () => ({ _id: 'me' }) } },
      { provide: WorkspaceSyncService, useValue: sync },
      ...(extra as any[]),
    ],
  });
  const fixture = TestBed.createComponent(component);
  return { fixture, clerk, router, sync, cmp: fixture.componentInstance as any };
}

describe('CreateOrganizationComponent', () => {
  let assign: jasmine.Spy;
  beforeEach(() => { assign = spyOn(pageNavigation, 'assign'); });

  it('suggests a URL name, validates it, creates the organization and enters it (full reload)', async () => {
    const create = jasmine.createSpy().and.resolveTo({ organizationId: 'o1', clerkOrgId: 'org_new', name: 'Acme Co', slug: 'acme-co' });
    const { cmp, clerk } = setup(CreateOrganizationComponent, { create });
    cmp.form.name = 'Acme Co!';
    cmp.nameChanged();
    expect(cmp.form.slug).toBe('acme-co');
    cmp.form.slug = 'Bad Slug';
    expect(cmp.detailsValid).toBeFalse();
    cmp.form.slug = 'acme-co';
    expect(cmp.detailsValid).toBeTrue();
    cmp.form.discoverable = true;
    cmp.form.joinPolicy = 'request';
    await cmp.create();
    expect(create).toHaveBeenCalledOnceWith(jasmine.objectContaining({ name: 'Acme Co!', slug: 'acme-co', discoverable: true, joinPolicy: 'request', allowExternalChat: false }));
    expect(clerk.activateNewOrganization).toHaveBeenCalledWith('org_new');
    expect(assign).toHaveBeenCalledWith('/organization');
  });

  it('shows the server message and goes back to the details step when the URL name is taken', async () => {
    const { cmp, fixture } = setup(CreateOrganizationComponent, { create: jasmine.createSpy().and.rejectWith('That URL name is taken') });
    Object.assign(cmp.form, { name: 'Acme', slug: 'acme' });
    cmp.step = 'review';
    await cmp.create();
    fixture.detectChanges();
    expect(cmp.step).toBe('details');
    expect(text(fixture)).toContain('That URL name is taken');
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('InvitationAcceptComponent', () => {
  it('removes the secret token from the address bar, previews and accepts', async () => {
    const preview = jasmine.createSpy().and.resolveTo({ name: 'Acme', description: '', role: 'member', expiresAt: new Date().toISOString() });
    const accept = jasmine.createSpy().and.resolveTo({ clerkOrgId: 'org_a' });
    const assign = spyOn(pageNavigation, 'assign');
    const { cmp, router, fixture } = setup(InvitationAcceptComponent, { previewInvitation: preview, acceptInvitation: accept }, [{ provide: ActivatedRoute, useValue: route({ token: 'inv_secret' }) }]);
    await cmp.ngOnInit();
    expect(router.navigate).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { token: null }, replaceUrl: true }));
    expect(preview).toHaveBeenCalledWith({ token: 'inv_secret' });
    fixture.detectChanges();
    expect(text(fixture)).toContain('Acme');
    await cmp.accept();
    expect(accept).toHaveBeenCalledWith({ token: 'inv_secret' });
    expect(assign).toHaveBeenCalledWith('/organization');
  });

  it('an invalid / foreign invitation shows the same generic message (no details)', async () => {
    const { cmp, fixture } = setup(InvitationAcceptComponent, { previewInvitation: jasmine.createSpy().and.rejectWith('This invitation is invalid, expired or not for this account') }, [{ provide: ActivatedRoute, useValue: route({ token: 'inv_x' }) }]);
    await cmp.ngOnInit();
    fixture.detectChanges();
    expect(text(fixture)).toContain('invalid, expired or not for this account');
    expect(cmp.preview).toBeNull();
  });
});

describe('OrganizationSettingsComponent', () => {
  const overview = (role: string, permissions: Record<string, boolean>): OrgOverview => ({
    organizationId: 'o', clerkOrgId: 'org_o', name: 'Acme', slug: 'acme', description: '', avatar: '', discoverable: false, joinPolicy: 'invite',
    role: role as any, memberCount: 2, policies: {}, permissions, invitableRoles: role === 'owner' ? ['admin', 'member'] : [],
    ...(permissions['org:update'] ? { settings: { discoverable: false, joinPolicy: 'invite', allowedEmailDomains: [], membersCanInvite: false, membersCanCreateTeams: true, guestAccess: false, joinCodeEnabled: false } } : {}),
  });
  const services = (o: OrgOverview) => ({
    overview: jasmine.createSpy().and.resolveTo(o),
    members: jasmine.createSpy().and.resolveTo([{ userId: 'me', username: 'Me', avatar: '', role: o.role, status: 'active', joinedAt: '', source: null }, { userId: 'u2', username: 'Bob', avatar: '', role: 'member', status: 'active', joinedAt: '', source: null }]),
    joinRequests: jasmine.createSpy().and.resolveTo([]),
    invitations: jasmine.createSpy().and.resolveTo([]),
    invite: jasmine.createSpy().and.resolveTo({ results: [{ email: 'a@b.co', status: 'invited', link: 'https://x/organizations/invitation?token=inv_1' }] }),
  });

  it('a plain member sees only General and Members, with no admin controls', async () => {
    const { cmp, fixture } = setup(OrganizationSettingsComponent, services(overview('member', {})), [{ provide: ActivatedRoute, useValue: route() }]);
    await cmp.ngOnInit();
    fixture.detectChanges();
    expect(cmp.visibleTabs).toEqual(['general', 'members', 'teams']);
    cmp.tab = 'members';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('select').length).toBe(0);
    expect(text(fixture)).not.toContain('Remove');
  });

  it('an owner sees every tab; inviting shows each link once to share', async () => {
    const perms = { 'org:update': true, 'org:delete': true, 'org:audit': true, 'members:invite': true, 'members:remove': true, 'members:role': true, 'requests:decide': true };
    const svc = services(overview('owner', perms));
    const { cmp, fixture } = setup(OrganizationSettingsComponent, svc, [{ provide: ActivatedRoute, useValue: route({ tab: 'invitations' }) }]);
    await cmp.ngOnInit();
    expect(cmp.visibleTabs).toEqual(['general', 'members', 'teams', 'external', 'privacy', 'admin']);
    // An old ?tab=invitations link opens Members, where inviting now lives
    expect(cmp.tab).toBe('members');
    cmp.inviteForm.emails = 'a@b.co';
    await cmp.invite();
    fixture.detectChanges();
    expect(svc.invite).toHaveBeenCalledWith(['a@b.co'], 'member', 7);
    expect(text(fixture)).toContain('inv_1');
    // The owner can't pick their own row's role (server refuses self-changes too)
    cmp.tab = 'members';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('select[aria-label^="Role of"]').length).toBe(1);
  });
});

describe('JoinOrganizationComponent', () => {
  it('offers only what each organization\'s policy allows', async () => {
    const discover = jasmine.createSpy().and.resolveTo([
      { organizationId: 'a', name: 'Open Co', slug: 'open', description: '', joinPolicy: 'open', myStatus: 'none' },
      { organizationId: 'b', name: 'Ask Co', slug: 'ask', description: '', joinPolicy: 'request', myStatus: 'none' },
      { organizationId: 'c', name: 'Pending Co', slug: 'pend', description: '', joinPolicy: 'request', myStatus: 'requested' },
    ]);
    const { cmp, fixture } = setup(JoinOrganizationComponent, { discover, myInvitations: jasmine.createSpy().and.resolveTo([]), myRequests: jasmine.createSpy().and.resolveTo([]) }, [{ provide: ActivatedRoute, useValue: route() }]);
    await cmp.ngOnInit();
    fixture.detectChanges();
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent!.trim());
    expect(buttons).toContain('Join');
    expect(buttons).toContain('Ask to join');
    expect(text(fixture)).toContain('Requested');
  });
});

describe('TeamPageComponent', () => {
  it('"Leave team" removes ME — not another member who happens to share my role', async () => {
    const removeTeamMember = jasmine.createSpy().and.resolveTo({});
    const svc = {
      team: jasmine.createSpy().and.resolveTo({ teamId: 't', name: 'Ops', description: '', avatar: '', visibility: 'public', myRole: 'member', canManage: false }),
      channels: jasmine.createSpy().and.resolveTo([]),
      teamMembers: jasmine.createSpy().and.resolveTo([{ userId: 'other', username: 'Other', avatar: '', role: 'member' }, { userId: 'me', username: 'Me', avatar: '', role: 'member' }]),
      removeTeamMember,
    };
    const { cmp } = setup(TeamPageComponent, svc, [{ provide: ActivatedRoute, useValue: route({}, { teamId: 't' }) }]);
    await cmp.ngOnInit();
    await cmp.leave();
    expect(removeTeamMember).toHaveBeenCalledOnceWith('t', 'me');
    expect(cmp.others.map((m: any) => m.userId)).toEqual(['other']);
  });
});

describe('Live updates (server change signals, no reload)', () => {
  const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
  const ownerOverview = (): OrgOverview => ({
    organizationId: 'o', clerkOrgId: 'org_o', name: 'Acme', slug: 'acme', description: '', avatar: '', discoverable: false, joinPolicy: 'invite',
    role: 'owner', memberCount: 1, policies: {}, invitableRoles: ['admin', 'member'],
    permissions: { 'org:update': true, 'members:invite': true, 'members:remove': true, 'members:role': true, 'requests:decide': true },
    settings: { discoverable: false, joinPolicy: 'invite', allowedEmailDomains: [], membersCanInvite: false, membersCanCreateTeams: true, guestAccess: false, joinCodeEnabled: false },
  });
  const member = (userId: string, role = 'member') => ({ userId, username: userId, avatar: '', role, status: 'active', joinedAt: '', source: null });

  it('a member added by someone else appears without a reload; the list is replaced, never duplicated', async () => {
    const members = jasmine.createSpy().and.returnValues(Promise.resolve([member('me', 'owner')]), Promise.resolve([member('me', 'owner'), member('carol')]), Promise.resolve([member('me', 'owner'), member('carol')]));
    const svc = { overview: jasmine.createSpy().and.resolveTo(ownerOverview()), members, joinRequests: jasmine.createSpy().and.resolveTo([]) };
    const { cmp, sync } = setup(OrganizationSettingsComponent, svc, [{ provide: ActivatedRoute, useValue: route() }]);
    await cmp.ngOnInit();
    expect(cmp.members.map((m: any) => m.userId)).toEqual(['me']);
    sync.changes$.next('members');
    sync.changes$.next('members'); // a burst of signals = one request
    await wait();
    expect(cmp.members.map((m: any) => m.userId)).toEqual(['me', 'carol']);
    expect(members).toHaveBeenCalledTimes(2);
    expect(sync.activeOrganizationId).toBe('o');
  });

  it('my own role change and its echoing server signal cost ONE refetch', async () => {
    const members = jasmine.createSpy().and.resolveTo([member('me', 'owner'), member('bob')]);
    let resolveRole!: () => void;
    const setRole = jasmine.createSpy().and.returnValue(new Promise<void>((r) => (resolveRole = r)));
    const svc = { overview: jasmine.createSpy().and.resolveTo(ownerOverview()), members, joinRequests: jasmine.createSpy().and.resolveTo([]), setRole };
    const { cmp, sync } = setup(OrganizationSettingsComponent, svc, [{ provide: ActivatedRoute, useValue: route() }]);
    await cmp.ngOnInit();
    members.calls.reset();
    const done = cmp.setRole(member('bob'), 'admin');
    sync.changes$.next('members'); // the server's event arrives while the request is in flight
    resolveRole();
    await done;
    await wait();
    expect(members).toHaveBeenCalledTimes(1);
  });

  it('a failed change shows the error and reloads the real state (no stale row left behind)', async () => {
    const members = jasmine.createSpy().and.returnValues(Promise.resolve([member('me', 'owner'), member('bob')]), Promise.resolve([member('me', 'owner')]));
    const svc = { overview: jasmine.createSpy().and.resolveTo(ownerOverview()), members, joinRequests: jasmine.createSpy().and.resolveTo([]), removeMember: jasmine.createSpy().and.rejectWith('Member not found') };
    const { cmp } = setup(OrganizationSettingsComponent, svc, [{ provide: ActivatedRoute, useValue: route() }]);
    await cmp.ngOnInit();
    await cmp.removeMember(member('bob'));
    const alerts = TestBed.inject(AlertService) as jasmine.SpyObj<AlertService>;
    expect(alerts.error).toHaveBeenCalledWith('Member not found');
    expect(cmp.members.map((m: any) => m.userId)).toEqual(['me']);
  });

  it('leaving clears the active organization before the reload (no refused workspace left selected)', async () => {
    const svc = { overview: jasmine.createSpy().and.resolveTo({ ...ownerOverview(), role: 'member', permissions: {} }), members: jasmine.createSpy().and.resolveTo([]), leave: jasmine.createSpy().and.resolveTo({ left: true }) };
    const { cmp, sync } = setup(OrganizationSettingsComponent, svc, [{ provide: ActivatedRoute, useValue: route() }]);
    await cmp.ngOnInit();
    await cmp.leave();
    expect(sync.leaveWorkspace).toHaveBeenCalled();
  });

  it('team page: channel changes appear live; an archived team shows nothing stale', async () => {
    const channels = jasmine.createSpy().and.returnValues(Promise.resolve([]), Promise.resolve([{ channelId: 'c1', name: 'design', description: '', type: 'standard', external: false, memberCount: 2, isMember: true }]));
    let archived = false;
    const team = jasmine.createSpy().and.callFake(() => archived
      ? Promise.reject('Team not found')
      : Promise.resolve({ teamId: 't', name: 'Ops', description: '', avatar: '', visibility: 'public', myRole: 'member', canManage: false }));
    const svc = { team, channels, teamMembers: jasmine.createSpy().and.resolveTo([member('me')]) };
    const { cmp, sync } = setup(TeamPageComponent, svc, [{ provide: ActivatedRoute, useValue: route({}, { teamId: 't' }) }]);
    await cmp.ngOnInit();
    sync.changes$.next('channels:t');
    await wait();
    expect(cmp.channels.map((c: any) => c.name)).toEqual(['design']);
    archived = true;
    sync.changes$.next('team:t'); // archived elsewhere: the server now refuses it
    await wait();
    expect(cmp.team).toBeNull();
    expect(cmp.channels).toEqual([]);
  });
});
