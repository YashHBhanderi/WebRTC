import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { AppUser, AppUserPage, DevApp, DeveloperService } from 'src/app/core/services/developer.service';
import { DeveloperAppComponent } from './developer-app.component';

/**
 * Application page: the Users tab (register, list, details, deactivate / reactivate) exists only for
 * applications with their own tenant, which also lose the consent / OAuth settings; workspace and
 * legacy applications keep theirs.
 */
const baseApp: DevApp = {
  _id: 'a1', name: 'Acme', description: '', websiteUrl: '', environment: 'development', status: 'active', tenantId: 't1', dedicatedTenant: true,
  scopes: ['profile:read'], allowedOrigins: ['https://app.example'], callbackUrls: [], quotas: { rateLimitPerMinute: 60, maxConnections: 20, messagesPerDay: 1000 },
  createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
};
const user = (n: number, over: Partial<AppUser> = {}): AppUser => ({
  _id: `u${n}`, externalUserId: `x-${n}`, name: `User ${n}`, email: n === 1 ? 'one@example.com' : null, avatarUrl: '', status: 'active', tenantId: 't1',
  createdAt: '2026-11-16T00:00:00.000Z', deactivatedAt: null, ...over,
});

/** Records every call so tests can check what reached the API client */
class FakeDeveloperService {
  calls: { name: string; args: unknown[] }[] = [];
  app: DevApp = { ...baseApp };
  pages: AppUserPage[] = [{ items: [user(1), user(2)], nextCursor: null }];
  failRegister: unknown = null;
  private log<T>(name: string, args: unknown[], value: T): Promise<T> { this.calls.push({ name, args }); return Promise.resolve(value); }
  getApp(id: string) { return this.log('getApp', [id], this.app); }
  appUsers(id: string, options: unknown) { return this.log('appUsers', [id, options], this.pages.length > 1 ? this.pages.shift()! : this.pages[0]); }
  registerAppUser(id: string, input: { externalUserId: string; name: string; email?: string }) {
    this.calls.push({ name: 'registerAppUser', args: [id, input] });
    if (this.failRegister) return Promise.reject(this.failRegister);
    const created = user(9, { externalUserId: input.externalUserId, name: input.name, email: input.email || null });
    this.pages = [{ items: [...this.pages[0].items, created], nextCursor: null }];
    return Promise.resolve(created);
  }
  updateAppUser(id: string, externalUserId: string, patch: { name?: string; email?: string; active?: boolean }) {
    const current = this.pages[0].items.find((u) => u.externalUserId === externalUserId) || user(1);
    return this.log('updateAppUser', [id, externalUserId, patch], {
      ...current, ...(patch.name ? { name: patch.name } : {}), ...(patch.email !== undefined ? { email: patch.email || null } : {}),
      ...(patch.active === undefined ? {} : { status: patch.active ? 'active' as const : 'deactivated' as const, deactivatedAt: patch.active ? null : '2026-11-16T01:00:00.000Z' }),
    });
  }
  updateApp(id: string, patch: Partial<DevApp>) { this.app = { ...this.app, ...patch }; return this.log('updateApp', [id, patch], this.app); }
  credentials() { return this.log('credentials', [], []); }
  scopes() { return this.log('scopes', [], []); }
  webhooks() { return this.log('webhooks', [], []); }
  webhookEvents() { return this.log('webhookEvents', [], []); }
  usage() { return this.log('usage', [], []); }
  audit() { return this.log('audit', [], []); }
  named(name: string) { return this.calls.filter((c) => c.name === name); }
}

describe('DeveloperAppComponent: application users', () => {
  let fixture: ComponentFixture<DeveloperAppComponent>;
  let component: DeveloperAppComponent;
  let dev: FakeDeveloperService;
  let query: Record<string, string>;

  /** Let pending promises finish and render the result (the component is OnPush and marks itself dirty) */
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      fixture.detectChanges();
    }
  };
  const buttons = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')) as HTMLButtonElement[];
  const click = async (label: string) => {
    const button = buttons().find((b) => (b.textContent || '').trim() === label);
    if (!button) throw new Error(`No button labelled "${label}"`);
    button.click();
    await settle();
  };
  const text = () => (fixture.nativeElement as HTMLElement).textContent || '';
  const tabLabels = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.dev-tabs button')).map((b) => (b.textContent || '').trim());
  const find = (selector: string) => (fixture.nativeElement as HTMLElement).querySelector(selector);

  async function start(app: Partial<DevApp> = {}, params: Record<string, string> = {}): Promise<void> {
    dev = new FakeDeveloperService();
    dev.app = { ...baseApp, ...app };
    query = params;
    await TestBed.configureTestingModule({
      declarations: [DeveloperAppComponent],
      imports: [FormsModule, RouterTestingModule],
      providers: [
        { provide: DeveloperService, useValue: dev },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ appId: 'a1' }), queryParamMap: convertToParamMap(query) } } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DeveloperAppComponent);
    component = fixture.componentInstance;
    // The first change detection runs ngOnInit, which loads the application and the selected tab
    fixture.detectChanges();
    await settle();
  }

  it('shows the Users tab and the tenant only for an application with its own tenant', async () => {
    await start();
    expect(component.kind).toBe('dedicated');
    expect(tabLabels()).toEqual(['Overview', 'Users', 'Credentials', 'Permissions', 'Configuration', 'Webhooks', 'Usage', 'Activity']);
    expect(text()).toContain('own tenant');
    expect(text()).toContain('t1');
    expect(find('[data-test="kind-dedicated"]')).toBeTruthy();
    expect(find('[data-test="kind-legacy"]')).toBeNull();
    expect(text()).not.toContain('workspace application');
  });

  it('keeps workspace applications as they were: no Users tab, consent settings in place', async () => {
    await start({ dedicatedTenant: false, tenantId: 'org-tenant', callbackUrls: ['https://app.example/cb'] });
    expect(component.kind).toBe('workspace');
    expect(tabLabels()).not.toContain('Users');
    expect(text()).toContain('workspace application');
    expect(find('[data-test="kind-dedicated"]')).toBeNull();
    await component.select('configuration');
    await settle();
    expect(text()).toContain('Redirect URLs');
    expect(find('[data-test="no-consent"]')).toBeNull();
    await component.saveConfiguration();
    expect(dev.named('updateApp')[0].args[1]).toEqual({ allowedOrigins: ['https://app.example'], callbackUrls: ['https://app.example/cb'] });
  });

  it('keeps legacy consent applications as they were, and says why they have no Users tab', async () => {
    await start({ dedicatedTenant: false, tenantId: null, callbackUrls: ['https://app.example/cb'] });
    expect(component.kind).toBe('legacy');
    expect(tabLabels()).not.toContain('Users');
    expect(find('[data-test="kind-legacy"]')).toBeTruthy();
    await component.select('configuration');
    await settle();
    expect(text()).toContain('Redirect URLs');
    // The Users tab can't be reached by URL either
    await component.select('users');
    await settle();
    expect(component.tab).toBe('overview');
    expect(dev.named('appUsers').length).toBe(0);
  });

  it('?tab=users on a legacy application falls back to the overview without asking for users', async () => {
    await start({ dedicatedTenant: false, tenantId: null }, { tab: 'users' });
    expect(component.tab).toBe('overview');
    expect(dev.named('appUsers').length).toBe(0);
  });

  it('removes the consent / OAuth settings from an application with its own tenant', async () => {
    await start();
    await component.select('configuration');
    await settle();
    expect(text()).not.toContain('Redirect URLs');
    expect(find('textarea[name="callbacks"]')).toBeNull();
    expect(find('[data-test="no-consent"]')).toBeTruthy();
    expect(find('textarea[name="origins"]')).toBeTruthy();
    await component.saveConfiguration();
    const patch = dev.named('updateApp')[0].args[1] as Record<string, unknown>;
    expect(patch).toEqual({ allowedOrigins: ['https://app.example'] });
    expect(Object.keys(patch)).not.toContain('callbackUrls');
  });

  it('lists only what the server returns for this application, with status and details', async () => {
    await start({}, { tab: 'users' });
    expect(component.tab).toBe('users');
    expect(dev.named('appUsers')[0].args).toEqual(['a1', { cursor: null, status: '' }]);
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.dev-table tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('User 1');
    expect(rows[0].textContent).toContain('x-1');
    expect(rows[0].textContent).toContain('one@example.com');
    expect(rows[0].textContent).toContain('Active');
    await click('Details');
    expect(component.openUser).toBe('x-1');
    expect(text()).toContain('SpreeWe user ID');
    expect(text()).toContain('u1');
    expect(component.editUser).toEqual({ name: 'User 1', email: 'one@example.com' });
  });

  it('registers a user after validating the form, then reloads the list', async () => {
    await start({}, { tab: 'users' });
    expect(component.canRegisterUser).toBe(false);
    component.newUser = { externalUserId: 'has space', name: 'Asha Rao', email: '' };
    expect(component.canRegisterUser).toBe(false);
    await component.registerUser();
    expect(dev.named('registerAppUser').length).toBe(0);
    component.newUser = { externalUserId: 'ok-1', name: 'As', email: '' };
    expect(component.canRegisterUser).toBe(false);

    component.newUser = { externalUserId: ' acme-42 ', name: ' Asha Rao ', email: ' asha@example.com ' };
    expect(component.canRegisterUser).toBe(true);
    await component.registerUser();
    await settle();
    expect(dev.named('registerAppUser')[0].args).toEqual(['a1', { externalUserId: 'acme-42', name: 'Asha Rao', email: 'asha@example.com' }]);
    expect(component.newUser).toEqual({ externalUserId: '', name: '', email: '' });
    expect(component.users.map((u) => u.externalUserId)).toContain('acme-42');
    expect(component.notice).toContain('Asha Rao is registered');
    // No email: the field is left out, not sent empty
    component.newUser = { externalUserId: 'acme-43', name: 'Ben Ortiz', email: '' };
    await component.registerUser();
    expect(dev.named('registerAppUser')[1].args[1]).toEqual({ externalUserId: 'acme-43', name: 'Ben Ortiz' });
  });

  it('shows the server message when registration is refused and keeps the form', async () => {
    await start({}, { tab: 'users' });
    dev.failRegister = { error: { error: { message: 'A user with this externalUserId is already registered' } } };
    component.newUser = { externalUserId: 'x-1', name: 'Asha Rao', email: '' };
    await component.registerUser();
    await settle();
    expect(component.error).toBe('A user with this externalUserId is already registered');
    expect(text()).toContain('already registered');
    expect(component.newUser.externalUserId).toBe('x-1');
    expect(component.users.length).toBe(2);
  });

  it('deactivates and reactivates a user, and updates name and email', async () => {
    await start({}, { tab: 'users' });
    await click('Deactivate');
    expect(dev.named('updateAppUser')[0].args).toEqual(['a1', 'x-1', { active: false }]);
    expect(component.users[0].status).toBe('deactivated');
    expect(component.notice).toContain('deactivated');
    expect(text()).toContain('Reactivate');
    await component.setUserActive(component.users[0], true);
    expect(dev.named('updateAppUser')[1].args).toEqual(['a1', 'x-1', { active: true }]);
    expect(component.users[0].status).toBe('active');

    component.toggleUser(component.users[1]);
    component.editUser = { name: ' Renamed Two ', email: '' };
    await component.saveUser(component.users[1]);
    expect(dev.named('updateAppUser')[2].args).toEqual(['a1', 'x-2', { name: 'Renamed Two', email: '' }]);
    expect(component.users[1].name).toBe('Renamed Two');
  });

  it('filters by status, drops a user that no longer matches the filter, and loads more pages', async () => {
    await start({}, { tab: 'users' });
    dev.pages = [{ items: [user(1), user(2)], nextCursor: 'c2' }, { items: [user(3)], nextCursor: null }];
    await component.filterUsers('active');
    await settle();
    expect(dev.named('appUsers')[1].args).toEqual(['a1', { cursor: null, status: 'active' }]);
    expect(text()).toContain('Load more');
    await component.moreUsers();
    await settle();
    expect(dev.named('appUsers')[2].args).toEqual(['a1', { cursor: 'c2', status: 'active' }]);
    expect(component.users.map((u) => u.externalUserId)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(component.usersCursor).toBeNull();
    await component.setUserActive(component.users[0], false);
    expect(component.users.map((u) => u.externalUserId)).toEqual(['x-2', 'x-3']);
  });

  it('a deleted application shows its users read-only', async () => {
    await start({ status: 'revoked' }, { tab: 'users' });
    await settle();
    expect(find('form[aria-label="Register a user"]')).toBeNull();
    expect(text()).toContain('User 1');
    expect(buttons().map((b) => (b.textContent || '').trim()).filter((t) => t === 'Deactivate' || t === 'Reactivate' || t === 'Save')).toEqual([]);
  });
});
