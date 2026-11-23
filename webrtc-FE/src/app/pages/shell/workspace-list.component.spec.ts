import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject } from 'rxjs';
import { WorkspaceListComponent } from './workspace-list.component';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { OrganizationService } from 'src/app/core/services/organization.service';
import { WorkspaceSyncService, workspaceNavigation } from 'src/app/core/services/workspace-sync.service';

/** The profile menu's organization list shows SpreeWe's list, stays current, and never leaves a tab half-switched. */
describe('WorkspaceListComponent', () => {
  const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
  const entry = (organizationId: string, clerkOrgId: string, name: string, role = 'member', managedBy = 'spreewe') =>
    ({ organizationId, clerkOrgId, name, slug: name.toLowerCase(), description: '', avatar: '', discoverable: false, joinPolicy: 'invite', role, managedBy, status: 'active', active: false });

  async function setup(pinned: string | null, mine: jasmine.Spy) {
    const clerk = {
      pinnedOrganization: pinned,
      organizations: jasmine.createSpy().and.resolveTo([{ id: 'org_legacy', name: 'Old Co', role: 'org:member' }]),
      setActiveOrganization: jasmine.createSpy().and.callFake(async (id: string | null) => { clerk.pinnedOrganization = id; }),
    };
    const sync = { changes$: new Subject<string>(), activeOrganizationId: null as string | null };
    await TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, NgbModule],
      declarations: [WorkspaceListComponent],
      providers: [{ provide: ClerkService, useValue: clerk }, { provide: OrganizationService, useValue: { mine } }, { provide: WorkspaceSyncService, useValue: sync }],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkspaceListComponent);
    fixture.componentInstance.ngOnInit();
    await wait();
    return { fixture, cmp: fixture.componentInstance, clerk, sync, http: TestBed.inject(HttpTestingController) };
  }

  it('lists SpreeWe\'s workspaces (real names and roles) plus Clerk-managed ones not opened yet, and labels the active one', async () => {
    const { fixture, cmp, sync } = await setup('org_a', jasmine.createSpy().and.resolveTo([entry('t_a', 'org_a', 'Acme', 'owner'), entry('t_b', 'org_b', 'Beta')]));
    expect(cmp.orgs.map((o) => [o.name, cmp.roleLabel(o.role), o.clerkManaged])).toEqual([['Acme', 'Owner', false], ['Beta', 'Member', false], ['Old Co', 'Member', true]]);
    // The active scope is marked (aria-current + check)
    fixture.detectChanges();
    const active = (fixture.nativeElement as HTMLElement).querySelectorAll('[aria-current="true"]');
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain('Acme');
    // The sync service learns which organization this tab shows (to ignore events about others)
    expect(sync.activeOrganizationId).toBe('t_a');
  });

  it('updates live when my memberships change (no reload)', async () => {
    const mine = jasmine.createSpy().and.returnValues(Promise.resolve([entry('t_a', 'org_a', 'Acme')]), Promise.resolve([entry('t_a', 'org_a', 'Acme'), entry('t_n', 'org_n', 'New Org')]));
    const { cmp, sync } = await setup(null, mine);
    expect(cmp.orgs.some((o) => o.name === 'New Org')).toBeFalse();
    sync.changes$.next('mine');
    await wait();
    expect(cmp.orgs.some((o) => o.name === 'New Org')).toBeTrue();
  });

  it('a refused switch restores the workspace the tab was in and shows the server\'s reason', async () => {
    const assign = spyOn(workspaceNavigation, 'assign');
    const { cmp, clerk, http } = await setup('org_a', jasmine.createSpy().and.resolveTo([entry('t_a', 'org_a', 'Acme'), entry('t_b', 'org_b', 'Beta')]));
    const switching = cmp.switchTo('org_b');
    expect(cmp.switching).toBeTrue();
    await wait(20);
    http.expectOne((req) => req.url.endsWith('/v1/workspace')).flush({ error: { message: 'You are not a member of this organization' } }, { status: 403, statusText: 'Forbidden' });
    await switching;
    expect(clerk.setActiveOrganization.calls.allArgs()).toEqual([['org_b'], ['org_a']]);
    expect(clerk.pinnedOrganization).toBe('org_a');
    expect(cmp.listError).toBe('You are not a member of this organization');
    expect(cmp.switching).toBeFalse();
    expect(assign).not.toHaveBeenCalled();
  });

  it('an accepted switch restarts the app in the new workspace (full page load)', async () => {
    const assign = spyOn(workspaceNavigation, 'assign');
    const { cmp, http } = await setup(null, jasmine.createSpy().and.resolveTo([entry('t_a', 'org_a', 'Acme')]));
    const switching = cmp.switchTo('org_a');
    await wait(20);
    http.expectOne((req) => req.url.endsWith('/v1/workspace')).flush({ data: {} });
    await switching;
    expect(assign).toHaveBeenCalledWith('/organization');
  });
});
