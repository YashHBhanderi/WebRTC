import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ViewRefresher, WorkspaceSyncService, touches } from 'src/app/core/services/workspace-sync.service';
import { ActivatedRoute } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { OrgCard, OrganizationService, errorText } from 'src/app/core/services/organization.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { JOIN_POLICY_LABEL, ROLE_LABEL, enterOrganization } from './org-navigation';

/**
 * /organizations/join — invitations addressed to me, organizations that chose to be discoverable, my
 * pending requests, and joining with a code / link (?org=…&code=…). Private organizations never appear
 * here; the server decides what is possible and this page explains it.
 */
@Component({
  selector: 'app-join-organization',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', '../developer/developer.scss'],
  template: `
    <section class="page page--narrow">
      <header class="page__header"><h1 class="page__title">Join an organization</h1></header>

      <div class="card-section" *ngIf="invitations.length">
        <h2 class="card-section__title">Invitations for you</h2>
        <div class="dev-scope" *ngFor="let i of invitations">
          <div class="flex-grow-1"><strong>{{ i.name }}</strong> <span class="dev-chip">{{ roleLabel[i.role] }}</span>
            <div class="dev-muted">Expires {{ i.expiresAt | date: 'mediumDate' }}</div></div>
          <button type="button" class="btn btn-primary btn-sm" [disabled]="busy" (click)="accept(i.invitationId, i.name)">Accept and open</button>
        </div>
      </div>

      <form class="card-section dev-grid" (ngSubmit)="joinWithCode()">
        <h2 class="card-section__title">Have a join code?</h2>
        <p class="dev-muted mb-0">Codes come from an organization's owners or admins. Joining with a code works even for private organizations.</p>
        <div class="dev-row">
          <input class="form-control" name="org" [(ngModel)]="code.org" placeholder="Organization id (from the link)" aria-label="Organization id" />
          <input class="form-control dev-mono" name="code" [(ngModel)]="code.value" placeholder="Join code" aria-label="Join code" autocomplete="off" />
          <button type="submit" class="btn btn-primary" [disabled]="busy || !code.org || code.value.length < 6">Join</button>
        </div>
        <p class="text-danger small mb-0" *ngIf="codeError" role="alert">{{ codeError }}</p>
      </form>

      <div class="card-section">
        <h2 class="card-section__title">Find an organization</h2>
        <form class="dev-row mb-2" (ngSubmit)="search()" role="search">
          <input class="form-control" name="q" [(ngModel)]="q" placeholder="Search by name" aria-label="Search organizations" />
          <button type="submit" class="btn btn-light" [disabled]="busy">Search</button>
        </form>
        <p class="dev-muted" *ngIf="searched && !results.length">No discoverable organizations match. Private organizations are never listed — ask for an invitation.</p>
        <div class="dev-scope" *ngFor="let o of results">
          <div class="flex-grow-1">
            <strong>{{ o.name }}</strong> <span class="dev-muted dev-mono">{{ o.slug }}</span>
            <div class="dev-muted">{{ o.description || policyLabel[o.joinPolicy] }}</div>
          </div>
          <ng-container [ngSwitch]="o.myStatus">
            <span *ngSwitchCase="'member'" class="dev-chip dev-chip--ok">Member</span>
            <span *ngSwitchCase="'requested'" class="dev-chip dev-chip--warn">Requested</span>
            <ng-container *ngSwitchDefault>
              <button *ngIf="o.joinPolicy === 'open'" type="button" class="btn btn-primary btn-sm" [disabled]="busy" (click)="joinOpen(o)">Join</button>
              <button *ngIf="o.joinPolicy === 'request'" type="button" class="btn btn-light btn-sm" [disabled]="busy" (click)="request(o)">Ask to join</button>
              <span *ngIf="o.joinPolicy === 'invite'" class="dev-muted small">Invitation only</span>
            </ng-container>
          </ng-container>
        </div>
      </div>

      <div class="card-section" *ngIf="requests.length">
        <h2 class="card-section__title">Your requests</h2>
        <div class="dev-scope" *ngFor="let r of requests">
          <div class="flex-grow-1"><strong>{{ r.organization.name }}</strong>
            <div class="dev-muted">{{ r.status }} · {{ r.createdAt | date: 'medium' }}</div></div>
          <button *ngIf="r.status === 'pending'" type="button" class="btn btn-light btn-sm" (click)="cancel(r.requestId)">Withdraw</button>
        </div>
      </div>
    </section>
  `,
})
export class JoinOrganizationComponent implements OnInit, OnDestroy {
  readonly roleLabel = ROLE_LABEL;
  readonly policyLabel = JOIN_POLICY_LABEL;
  invitations: Awaited<ReturnType<OrganizationService['myInvitations']>> = [];
  results: Awaited<ReturnType<OrganizationService['discover']>> = [];
  requests: Awaited<ReturnType<OrganizationService['myRequests']>> = [];
  q = '';
  searched = false;
  busy = false;
  code = { org: '', value: '' };
  codeError = '';
  private subs = new Subscription();
  // Invitations and request decisions arrive while the page is open (server events)
  private refresher = new ViewRefresher(async (topics) => {
    if (touches(topics, 'myInvitations')) this.invitations = await this.orgs.myInvitations().catch(() => this.invitations);
    if (touches(topics, 'myRequests', 'mine')) {
      this.requests = await this.orgs.myRequests().catch(() => this.requests);
      await this.search();
    }
    this.cdr.markForCheck();
  });

  constructor(private orgs: OrganizationService, private clerk: ClerkService, private route: ActivatedRoute, private alert: AlertService, private sync: WorkspaceSyncService, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    const p = this.route.snapshot.queryParamMap;
    this.code = { org: p.get('org') || '', value: p.get('code') || '' };
    this.subs.add(this.sync.changes$.subscribe((t) => this.refresher.notify(t)));
    await this.refresher.mutate(async () => undefined, ['myInvitations', 'myRequests']);
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.refresher.destroy();
  }

  async search(): Promise<void> {
    this.results = await this.orgs.discover(this.q.trim()).catch(() => []);
    this.searched = true;
    this.cdr.markForCheck();
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.cdr.markForCheck();
    try {
      await task();
    } catch (e) {
      this.alert.error(errorText(e));
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  accept(invitationId: string, name: string): Promise<void> {
    return this.run(async () => {
      const org = await this.orgs.acceptInvitation({ invitationId });
      this.alert.success(`You joined ${name}`);
      await enterOrganization(this.clerk, org.clerkOrgId);
    });
  }

  joinOpen(o: OrgCard): Promise<void> {
    return this.run(async () => {
      const org = await this.orgs.join(o.organizationId);
      await enterOrganization(this.clerk, org.clerkOrgId);
    });
  }

  request(o: OrgCard): Promise<void> {
    return this.run(async () => {
      await this.refresher.mutate(() => this.orgs.requestToJoin(o.organizationId), ['myRequests']);
      this.alert.success('Request sent. You\'ll be notified when an admin decides.');
    });
  }

  cancel(requestId: string): Promise<void> {
    return this.run(async () => {
      await this.refresher.mutate(() => this.orgs.cancelRequest(requestId), ['myRequests']);
    });
  }

  async joinWithCode(): Promise<void> {
    this.codeError = '';
    this.busy = true;
    this.cdr.markForCheck();
    try {
      const org = await this.orgs.join(this.code.org.trim(), this.code.value.trim());
      await enterOrganization(this.clerk, org.clerkOrgId);
    } catch (e) {
      this.codeError = errorText(e, 'That code is not valid.');
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
