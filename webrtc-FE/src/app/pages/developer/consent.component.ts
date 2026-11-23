import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ConsentView, DeveloperService } from 'src/app/core/services/developer.service';
import { errorText } from 'src/app/core/services/organization.service';

/**
 * /consent?request=<id> — a signed-in SpreeWe user approves or denies an application's access
 * (the consentUrl a developer's server receives from POST /v1/consent-requests). Nothing is
 * pre-selected; the user picks each permission. The server sends the browser back to the
 * application's registered redirect URL.
 */
@Component({
  selector: 'app-consent',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', './developer.scss'],
  template: `
    <section class="page page--narrow">
      <p class="dev-muted" *ngIf="loading">Loading…</p>
      <p class="text-danger" *ngIf="loadError" role="alert">{{ loadError }}</p>

      <ng-container *ngIf="view && !done">
        <header class="page__header">
          <h1 class="page__title">Allow {{ view.app.name }} to access your SpreeWe account?</h1>
          <p class="dev-muted mb-0">Published by {{ view.app.ownerName || 'a SpreeWe developer' }}
            <span *ngIf="view.app.environment === 'development'"> · <span class="dev-chip dev-chip--warn">development application</span></span>
            <span *ngIf="view.app.tenantBound"> · works only in its organization</span></p>
        </header>
        <div class="card-section dev-grid">
          <p class="mb-0" *ngIf="view.app.description">{{ view.app.description }}</p>
          <p class="dev-muted small mb-0" *ngIf="view.app.websiteUrl">Website: {{ view.app.websiteUrl }}</p>
          <p class="dev-muted small mb-0">After you decide, you'll return to <strong>{{ view.redirectHost }}</strong>. This request expires {{ view.expiresAt | date: 'shortTime' }}.</p>
        </div>
        <form class="card-section dev-grid" (ngSubmit)="approve()">
          <h2 class="h6 mb-0">Choose what to allow</h2>
          <label class="dev-scope" *ngFor="let s of view.scopes">
            <input type="checkbox" class="form-check-input mt-1" [checked]="picked.has(s.scope)" [disabled]="!s.available" (change)="toggle(s.scope)" />
            <span><code>{{ s.scope }}</code>
              <span class="dev-chip dev-chip--warn" *ngIf="s.sensitive">sensitive</span>
              <span class="dev-chip dev-chip--bad" *ngIf="!s.available">not available</span>
              <span class="d-block dev-muted">{{ s.description }}</span></span>
          </label>
          <div class="dev-warn">Applications can't read or send the content of your messages: they're end-to-end encrypted on your devices. You can withdraw access at any time.</div>
          <p class="text-danger small mb-0" *ngIf="error" role="alert">{{ error }}</p>
          <div class="dev-row">
            <button type="submit" class="btn btn-primary" [disabled]="busy || !picked.size">Allow selected</button>
            <button type="button" class="btn btn-outline-secondary" (click)="deny()" [disabled]="busy">Deny</button>
          </div>
        </form>
      </ng-container>

      <div class="card-section" *ngIf="done" role="status">{{ done }}</div>
    </section>
  `,
})
export class ConsentComponent implements OnInit {
  view: ConsentView | null = null;
  picked = new Set<string>();
  loading = true;
  loadError = '';
  busy = false;
  error = '';
  done = '';

  constructor(private dev: DeveloperService, private route: ActivatedRoute, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.queryParamMap.get('request') || '';
    try {
      if (!id) throw new Error('This link is missing its request.');
      this.view = await this.dev.consentRequest(id);
    } catch (e) {
      this.loadError = errorText(e, e instanceof Error ? e.message : 'This request is invalid or has expired.');
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  toggle(scope: string): void {
    this.picked.has(scope) ? this.picked.delete(scope) : this.picked.add(scope);
  }

  approve(): Promise<void> {
    return this.decide(async () => (await this.dev.approveConsent(this.view!.requestId, [...this.picked])).redirectUrl);
  }

  deny(): Promise<void> {
    return this.decide(async () => (await this.dev.denyConsent(this.view!.requestId)).redirectUrl);
  }

  private async decide(fn: () => Promise<string>): Promise<void> {
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const redirect = await fn();
      this.done = 'Done. Returning you to the application…';
      this.cdr.markForCheck();
      // The server built this URL from the application's registered redirect URL (exact match)
      if (redirect) window.location.assign(redirect);
    } catch (e) {
      this.error = errorText(e, 'Could not save your decision.');
    }
    this.busy = false;
    this.cdr.markForCheck();
  }
}
