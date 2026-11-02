import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppEnvironment, DevApp, DeveloperService, ScopeInfo } from 'src/app/core/services/developer.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { errorText } from 'src/app/core/services/organization.service';

/**
 * /developer — Developer Portal home: the signed-in developer's applications in the active context,
 * and registration of a new one. Developers sign in with their normal SpreeWe account.
 */
@Component({
  selector: 'app-developer-apps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', './developer.scss'],
  template: `
    <section class="page">
      <header class="page__header dev-row dev-row--between">
        <div>
          <h1 class="page__title">Developer portal</h1>
          <p class="dev-muted mb-0">Register applications, get API credentials, choose permissions and connect webhooks.
            Applications here belong to {{ contextLabel }}.</p>
        </div>
        <div class="dev-row">
          <a class="btn btn-outline-secondary" routerLink="/developer/docs">API documentation</a>
          <button type="button" class="btn btn-primary" (click)="openCreate()" *ngIf="!creating">Register application</button>
        </div>
      </header>

      <form class="card-section dev-grid" *ngIf="creating" (ngSubmit)="create()" aria-label="Register an application">
        <h2 class="h6 mb-0">Register an application</h2>
        <label>Application name
          <input class="form-control" name="name" [(ngModel)]="form.name" required minlength="2" maxlength="80" />
        </label>
        <label>Description (optional)
          <textarea class="form-control" name="description" rows="2" maxlength="500" [(ngModel)]="form.description"></textarea>
        </label>
        <label>Website URL (optional)
          <input class="form-control" name="websiteUrl" type="url" placeholder="https://example.com" [(ngModel)]="form.websiteUrl" maxlength="300" />
        </label>
        <fieldset>
          <legend class="setting-row__label">Environment</legend>
          <label class="dev-scope"><input type="radio" class="form-check-input mt-1" name="env" [checked]="form.environment === 'development'" (change)="form.environment = 'development'" />
            <span><strong>Development</strong><span class="d-block dev-muted">Test keys (<code>swk_test_…</code>), lower quotas, <code>http://localhost</code> origins allowed.</span></span></label>
          <label class="dev-scope"><input type="radio" class="form-check-input mt-1" name="env" [checked]="form.environment === 'production'" (change)="form.environment = 'production'" />
            <span><strong>Production</strong><span class="d-block dev-muted">Live keys (<code>swk_live_…</code>), <code>https</code> origins only.</span></span></label>
        </fieldset>
        <label class="dev-scope" *ngIf="canBindWorkspace">
          <input type="checkbox" class="form-check-input mt-1" name="tenantBound" [(ngModel)]="form.tenantBound" />
          <span><strong>Workspace application</strong><span class="d-block dev-muted">Acts only inside this organization. Only owners and admins can register one.</span></span>
        </label>
        <fieldset>
          <legend class="setting-row__label">Permissions</legend>
          <p class="dev-muted small mb-1">Request only what you use. Users approve permissions individually; you can change them later.</p>
          <label class="dev-scope" *ngFor="let s of scopes">
            <input type="checkbox" class="form-check-input mt-1" [checked]="form.scopes.has(s.scope)" [disabled]="!s.available" (change)="toggle(s.scope)" />
            <span><code>{{ s.scope }}</code>
              <span class="dev-chip dev-chip--warn" *ngIf="s.sensitive">sensitive</span>
              <span class="dev-chip dev-chip--bad" *ngIf="!s.available">not available</span>
              <span class="d-block dev-muted">{{ s.description }}</span></span>
          </label>
        </fieldset>
        <p class="text-danger small mb-0" *ngIf="error" role="alert">{{ error }}</p>
        <div class="dev-row">
          <button type="submit" class="btn btn-primary" [disabled]="busy || form.name.trim().length < 2">Register</button>
          <button type="button" class="btn btn-link" (click)="creating = false">Cancel</button>
        </div>
      </form>

      <div class="card-section">
        <p class="dev-muted" *ngIf="loading">Loading…</p>
        <p class="text-danger small" *ngIf="loadError" role="alert">{{ loadError }}</p>
        <p class="dev-muted mb-0" *ngIf="!loading && !loadError && !apps.length">No applications yet. Register one to get API credentials.</p>
        <table class="dev-table" *ngIf="apps.length">
          <thead><tr><th>Application</th><th>Environment</th><th>Status</th><th>Permissions</th><th>Created</th></tr></thead>
          <tbody>
            <tr *ngFor="let a of apps">
              <td><a [routerLink]="['/developer/apps', a._id]"><strong>{{ a.name }}</strong></a>
                <span class="d-block dev-muted" *ngIf="a.description">{{ a.description }}</span></td>
              <td>{{ a.environment }}</td>
              <td><span class="dev-chip" [ngClass]="statusClass(a.status)">{{ statusLabel(a.status) }}</span></td>
              <td>{{ a.scopes.length }}</td>
              <td>{{ a.createdAt | date: 'mediumDate' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class DeveloperAppsComponent implements OnInit {
  apps: DevApp[] = [];
  scopes: ScopeInfo[] = [];
  loading = true;
  loadError = '';
  creating = false;
  busy = false;
  error = '';
  form = this.blank();

  constructor(private dev: DeveloperService, private clerk: ClerkService, private router: Router, private cdr: ChangeDetectorRef) {}

  get contextLabel(): string {
    return this.clerk.activeOrganizationId ? 'the active organization' : 'your personal account';
  }

  /** Workspace apps are created from inside a workspace (owner / admin; the server checks the role) */
  get canBindWorkspace(): boolean {
    return !!this.clerk.activeOrganizationId;
  }

  async ngOnInit(): Promise<void> {
    try {
      [this.apps, this.scopes] = await Promise.all([this.dev.listApps(), this.dev.scopes()]);
    } catch (e) {
      this.loadError = errorText(e, 'Could not load your applications.');
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  openCreate(): void {
    this.form = this.blank();
    this.error = '';
    this.creating = true;
  }

  toggle(scope: string): void {
    this.form.scopes.has(scope) ? this.form.scopes.delete(scope) : this.form.scopes.add(scope);
  }

  async create(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const app = await this.dev.createApp({
        name: this.form.name.trim(),
        description: this.form.description.trim() || undefined,
        websiteUrl: this.form.websiteUrl.trim() || undefined,
        environment: this.form.environment,
        tenantBound: this.canBindWorkspace && this.form.tenantBound ? true : undefined,
        scopes: [...this.form.scopes],
      });
      // Credentials are created on the application page (the secret is shown there once)
      await this.router.navigate(['/developer/apps', app._id], { queryParams: { tab: 'credentials', created: 1 } });
    } catch (e) {
      this.error = errorText(e, 'Could not register the application.');
    }
    this.busy = false;
    this.cdr.markForCheck();
  }

  statusLabel(s: string): string {
    return s === 'active' ? 'Enabled' : s === 'suspended' ? 'Disabled' : 'Deleted';
  }

  statusClass(s: string): string {
    return s === 'active' ? 'dev-chip--ok' : s === 'suspended' ? 'dev-chip--warn' : 'dev-chip--bad';
  }

  private blank() {
    return { name: '', description: '', websiteUrl: '', environment: 'development' as AppEnvironment, tenantBound: false, scopes: new Set<string>() };
  }
}
