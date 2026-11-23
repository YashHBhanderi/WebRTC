import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { OrganizationService, errorText } from 'src/app/core/services/organization.service';
import { ROLE_LABEL, enterOrganization } from './org-navigation';

/**
 * /organizations/invitation?token=… — the link from an invitation. The server only describes it if it
 * is addressed to one of my verified email addresses; otherwise it looks exactly like an invalid link.
 * Signing in (or up) with the invited address first is handled by the auth guard (returnUrl).
 */
@Component({
  selector: 'app-invitation-accept',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', '../developer/developer.scss'],
  template: `
    <section class="page page--narrow">
      <header class="page__header"><h1 class="page__title">Organization invitation</h1></header>
      <div class="empty" *ngIf="error">
        <i class="ti ti-mail-off empty__icon" aria-hidden="true"></i>
        <h2 class="empty__title">{{ error }}</h2>
        <p class="empty__text">Make sure you're signed in with the email address the invitation was sent to, or ask for a new invitation.</p>
      </div>
      <div class="card-section" *ngIf="preview as p">
        <h2 class="card-section__title mb-1">{{ p.name }}</h2>
        <p class="dev-muted">{{ p.description || 'You were invited to join this organization.' }}</p>
        <p>You'll join as <strong>{{ roleLabel[p.role] }}</strong>. The invitation expires {{ p.expiresAt | date: 'medium' }}.</p>
        <p class="dev-muted small">Joining doesn't move any of your personal chats into the organization.</p>
        <div class="dev-row">
          <button type="button" class="btn btn-primary" [disabled]="busy" (click)="accept()">{{ busy ? 'Joining…' : 'Accept and open' }}</button>
          <button type="button" class="btn btn-light" [disabled]="busy" (click)="decline()">Not now</button>
        </div>
      </div>
    </section>
  `,
})
export class InvitationAcceptComponent implements OnInit {
  readonly roleLabel = ROLE_LABEL;
  preview: Awaited<ReturnType<OrganizationService['previewInvitation']>> | null = null;
  error = '';
  busy = false;
  private token = '';

  constructor(private orgs: OrganizationService, private clerk: ClerkService, private route: ActivatedRoute, private router: Router, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    this.token = this.route.snapshot.queryParamMap.get('token') || '';
    // Don't keep the secret in the address bar / history
    void this.router.navigate([], { queryParams: { token: null }, queryParamsHandling: 'merge', replaceUrl: true });
    try {
      this.preview = await this.orgs.previewInvitation({ token: this.token });
    } catch (e) {
      this.error = errorText(e, 'This invitation is invalid or has expired');
    }
    this.cdr.markForCheck();
  }

  async accept(): Promise<void> {
    this.busy = true;
    this.cdr.markForCheck();
    try {
      const org = await this.orgs.acceptInvitation({ token: this.token });
      await enterOrganization(this.clerk, org.clerkOrgId);
    } catch (e) {
      this.error = errorText(e, "We couldn't accept the invitation.");
      this.preview = null;
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  decline(): void {
    void this.router.navigate(['/chat']);
  }
}
