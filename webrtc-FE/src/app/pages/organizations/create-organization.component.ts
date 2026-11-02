import { ChangeDetectionStrategy, ChangeDetectorRef, Component } from '@angular/core';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { JoinPolicy, OrganizationService, errorText } from 'src/app/core/services/organization.service';
import { JOIN_POLICY_LABEL, enterOrganization, slugFrom } from './org-navigation';

type Step = 'details' | 'access' | 'review';

/**
 * /organizations/new — create an organization in SpreeWe (no Clerk dashboard). You become its owner;
 * nothing from your personal chats moves into it.
 */
@Component({
  selector: 'app-create-organization',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', '../developer/developer.scss'],
  template: `
    <section class="page page--narrow">
      <header class="page__header">
        <h1 class="page__title">Create an organization</h1>
        <p class="dev-muted">A separate workspace for your team, with its own members, teams, channels and settings. Your personal chats stay personal.</p>
      </header>

      <ol class="org-steps" aria-label="Steps">
        <li *ngFor="let s of steps; let i = index" [class.on]="step === s" [attr.aria-current]="step === s ? 'step' : null">{{ i + 1 }}. {{ stepLabel[s] }}</li>
      </ol>

      <form class="card-section dev-grid" *ngIf="step === 'details'" (ngSubmit)="go('access')">
        <label>Organization name
          <input class="form-control" name="name" [(ngModel)]="form.name" (ngModelChange)="nameChanged()" required minlength="2" maxlength="80" autocomplete="organization" />
        </label>
        <label>URL name
          <input class="form-control" name="slug" [(ngModel)]="form.slug" (ngModelChange)="slugTouched = true" pattern="[a-z0-9-]{3,40}" required />
          <span class="dev-muted small">Lower-case letters, digits and hyphens (3–40). Must be unique.</span>
        </label>
        <label>Description (optional)
          <textarea class="form-control" name="description" rows="2" maxlength="500" [(ngModel)]="form.description"></textarea>
        </label>
        <p class="text-danger small mb-0" *ngIf="error" role="alert">{{ error }}</p>
        <div><button type="submit" class="btn btn-primary" [disabled]="!detailsValid">Next</button></div>
      </form>

      <form class="card-section dev-grid" *ngIf="step === 'access'" (ngSubmit)="go('review')">
        <fieldset>
          <legend class="setting-row__label">Who can find and join it</legend>
          <label class="dev-scope"><input type="radio" class="form-check-input mt-1" name="vis" [checked]="!form.discoverable" (change)="form.discoverable = false; form.joinPolicy = 'invite'" />
            <span><strong>Private</strong><span class="d-block dev-muted">Not listed. People join only through an invitation or a join link you share.</span></span></label>
          <label class="dev-scope"><input type="radio" class="form-check-input mt-1" name="vis" [checked]="form.discoverable && form.joinPolicy === 'request'" (change)="form.discoverable = true; form.joinPolicy = 'request'" />
            <span><strong>Discoverable, approval needed</strong><span class="d-block dev-muted">Listed in search. People ask to join; an owner or admin approves.</span></span></label>
          <label class="dev-scope"><input type="radio" class="form-check-input mt-1" name="vis" [checked]="form.discoverable && form.joinPolicy === 'open'" (change)="form.discoverable = true; form.joinPolicy = 'open'" />
            <span><strong>Discoverable and open</strong><span class="d-block dev-muted">Listed in search. Anyone can join (you can restrict email domains later).</span></span></label>
        </fieldset>
        <label class="pref">
          <input type="checkbox" class="form-check-input" name="ext" [(ngModel)]="form.allowExternalChat" />
          <span><span class="setting-row__label">Allow chats with people outside the organization</span>
          <span class="setting-row__hint d-block">Off by default. External people are always labelled External and never see internal teams or channels.</span></span>
        </label>
        <div class="dev-row"><button type="button" class="btn btn-light" (click)="go('details')">Back</button><button type="submit" class="btn btn-primary">Next</button></div>
      </form>

      <div class="card-section dev-grid" *ngIf="step === 'review'">
        <dl class="org-review">
          <dt>Name</dt><dd>{{ form.name }}</dd>
          <dt>URL name</dt><dd class="dev-mono">{{ form.slug }}</dd>
          <dt>Description</dt><dd>{{ form.description || '—' }}</dd>
          <dt>Joining</dt><dd>{{ form.discoverable ? 'Discoverable — ' : 'Private — ' }}{{ policyLabel[form.joinPolicy] }}</dd>
          <dt>External chat</dt><dd>{{ form.allowExternalChat ? 'Allowed' : 'Off' }}</dd>
          <dt>Your role</dt><dd>Owner</dd>
        </dl>
        <p class="text-danger small mb-0" *ngIf="error" role="alert">{{ error }}</p>
        <div class="dev-row">
          <button type="button" class="btn btn-light" (click)="go('access')" [disabled]="busy">Back</button>
          <button type="button" class="btn btn-primary" (click)="create()" [disabled]="busy">{{ busy ? 'Creating…' : 'Create organization' }}</button>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .org-steps { display: flex; gap: 16px; list-style: none; padding: 0; margin: 0 0 12px; font-size: .85rem; color: var(--app-muted); }
    .org-steps li.on { color: var(--app-text); font-weight: 600; }
    .org-review { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; margin: 0; }
    .org-review dt { color: var(--app-muted); font-weight: 500; }
    .org-review dd { margin: 0; }
  `],
})
export class CreateOrganizationComponent {
  readonly steps: Step[] = ['details', 'access', 'review'];
  readonly stepLabel: Record<Step, string> = { details: 'Details', access: 'Access', review: 'Review' };
  readonly policyLabel = JOIN_POLICY_LABEL;
  step: Step = 'details';
  form = { name: '', slug: '', description: '', discoverable: false, joinPolicy: 'invite' as JoinPolicy, allowExternalChat: false };
  slugTouched = false;
  busy = false;
  error = '';

  constructor(private orgs: OrganizationService, private clerk: ClerkService, private cdr: ChangeDetectorRef) {}

  get detailsValid(): boolean {
    return this.form.name.trim().length >= 2 && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(this.form.slug);
  }

  nameChanged(): void {
    if (!this.slugTouched) this.form.slug = slugFrom(this.form.name);
  }

  go(step: Step): void {
    this.error = '';
    this.step = step;
  }

  async create(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const org = await this.orgs.create({
        name: this.form.name.trim(), slug: this.form.slug, description: this.form.description.trim() || undefined,
        discoverable: this.form.discoverable, joinPolicy: this.form.joinPolicy, allowExternalChat: this.form.allowExternalChat,
      });
      await enterOrganization(this.clerk, org.clerkOrgId);
    } catch (e) {
      this.error = errorText(e, "We couldn't create the organization.");
      if (/URL name/.test(this.error)) this.step = 'details';
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
