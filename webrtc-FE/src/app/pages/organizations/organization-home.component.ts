import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ViewRefresher, WorkspaceSyncService, touches } from 'src/app/core/services/workspace-sync.service';
import { Router } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { Channel, OrgMember, OrgOverview, OrganizationService, Team, errorText } from 'src/app/core/services/organization.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ROLE_LABEL } from './org-navigation';

/**
 * /organization — home of the active organization (Teams-style): teams with their channels, members
 * directory, search and quick actions. Data comes only from the active workspace; switching workspace
 * reloads the app, so nothing from another organization can remain on screen.
 */
@Component({
  selector: 'app-organization-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', './org-ui.scss'],
  template: `
    <section class="org-page">
      <div class="org-loading" *ngIf="!loaded" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Loading organization…</div>
      <div class="org-panel org-empty" *ngIf="loaded && !org">
        <i class="ti ti-building-community" aria-hidden="true"></i>
        <strong>{{ notice }}</strong>
        <div class="org-form__actions justify-content-center mt-2">
          <a class="btn btn-primary btn-sm" routerLink="/organizations/new">Create an organization</a>
          <a class="btn btn-light btn-sm" routerLink="/organizations/join">Join one</a>
        </div>
      </div>

      <ng-container *ngIf="org as o">
        <header class="org-head">
          <span class="org-avatar" aria-hidden="true">{{ (o.name.trim()[0] || '?').toUpperCase() }}</span>
          <div class="org-head__text">
            <h1 class="org-head__title">{{ o.name }}</h1>
            <div class="org-head__meta">{{ o.memberCount }} member{{ o.memberCount === 1 ? '' : 's' }} · you are <span class="org-chip org-chip--{{ o.role }}">{{ roleLabel[o.role] }}</span></div>
          </div>
          <div class="org-head__actions">
            <a class="btn btn-light btn-sm" *ngIf="o.permissions['members:invite']" routerLink="/organization/settings" [queryParams]="{ tab: 'members', invite: 1 }"><i class="ti ti-user-plus" aria-hidden="true"></i> Invite</a>
            <button type="button" class="btn btn-primary btn-sm" *ngIf="o.permissions['teams:create']" (click)="creating = !creating" [attr.aria-expanded]="creating"><i class="ti ti-plus" aria-hidden="true"></i> New team</button>
            <a class="btn btn-light btn-sm" routerLink="/organization/settings"><i class="ti ti-settings" aria-hidden="true"></i> Settings</a>
          </div>
        </header>
        <p class="org-panel__hint mb-3" *ngIf="o.description">{{ o.description }}</p>
        <div class="org-banner mb-3" *ngIf="error" role="alert"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>{{ error }}</span></div>

        <form class="org-panel org-form mb-3" *ngIf="creating" (ngSubmit)="createTeam()">
          <div><h2 class="org-panel__title">New team</h2><p class="org-panel__hint">Every team starts with a General channel for all its members.</p></div>
          <div class="org-form__row">
            <label>Name <input class="form-control" name="tname" [(ngModel)]="teamForm.name" required minlength="2" maxlength="80" /></label>
            <label>Description <input class="form-control" name="tdesc" [(ngModel)]="teamForm.description" maxlength="500" /></label>
          </div>
          <div class="d-grid gap-1">
            <div class="segmented" role="radiogroup" aria-label="Team visibility">
              <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="teamForm.visibility === 'public'" [attr.aria-checked]="teamForm.visibility === 'public'" (click)="teamForm.visibility = 'public'"><i class="ti ti-world" aria-hidden="true"></i>Public</button>
              <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="teamForm.visibility === 'private'" [attr.aria-checked]="teamForm.visibility === 'private'" (click)="teamForm.visibility = 'private'"><i class="ti ti-lock" aria-hidden="true"></i>Private</button>
            </div>
            <span class="org-panel__hint">{{ teamForm.visibility === 'public' ? 'Any member of the organization can find and join it.' : 'Only people that team owners add can see it.' }}</span>
          </div>
          <div class="org-form__actions">
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy || teamForm.name.trim().length < 2">{{ busy ? 'Creating…' : 'Create team' }}</button>
            <button type="button" class="btn btn-light btn-sm" (click)="creating = false">Cancel</button>
          </div>
        </form>

        <div class="home-grid">
          <nav class="org-panel" aria-label="Teams and channels">
            <div class="org-panel__head">
              <h2 class="org-panel__title">Teams</h2>
              <div class="org-search home-search"><i class="ti ti-search" aria-hidden="true"></i><input class="form-control form-control-sm" [(ngModel)]="q" placeholder="Search" aria-label="Search teams, channels and people" /></div>
            </div>
            <div class="org-empty" *ngIf="!filteredTeams.length">
              <i class="ti ti-users-group" aria-hidden="true"></i>
              <strong>{{ teams.length ? 'Nothing matches' : 'No teams yet' }}</strong>
              <ng-container *ngIf="!teams.length">{{ o.permissions['teams:create'] ? 'Create a team to start channels for a group.' : 'Teams you can join will appear here.' }}</ng-container>
            </div>
            <div *ngFor="let t of filteredTeams; trackBy: trackTeam" class="home-team">
              <button type="button" class="home-team__head" (click)="toggle(t)" [attr.aria-expanded]="open.has(t.teamId)">
                <i class="ti" [class.ti-chevron-down]="open.has(t.teamId)" [class.ti-chevron-right]="!open.has(t.teamId)" aria-hidden="true"></i>
                <span class="home-team__name">{{ t.name }}</span>
                <i class="ti ti-lock" *ngIf="t.visibility === 'private'" aria-label="Private team"></i>
                <span class="org-chip ms-auto" [attr.aria-label]="t.memberCount + ' members'">{{ t.memberCount }}</span>
              </button>
              <div class="home-team__body" *ngIf="open.has(t.teamId)">
                <button type="button" *ngIf="!t.myRole" class="btn btn-light btn-sm my-1" (click)="joinTeam(t)">Join team</button>
                <a *ngFor="let c of channels[t.teamId] || []" class="home-channel" [class.home-channel--off]="!c.isMember" (click)="openChannel(c)" (keydown.enter)="openChannel(c)" tabindex="0" role="link">
                  <i class="ti" [class.ti-hash]="c.type === 'standard'" [class.ti-lock]="c.type === 'private'" [class.ti-world]="c.type === 'shared'" aria-hidden="true"></i>
                  <span class="home-team__name">{{ c.name }}</span>
                  <span class="org-chip org-chip--external" *ngIf="c.external">External</span>
                </a>
                <a [routerLink]="['/teams', t.teamId]" class="home-manage"><i class="ti ti-settings" aria-hidden="true"></i> Manage team</a>
              </div>
            </div>
          </nav>

          <div class="org-panel" *ngIf="o.role !== 'guest'">
            <div class="org-panel__head"><h2 class="org-panel__title">People</h2></div>
            <table class="org-table org-table--stack" *ngIf="filteredMembers.length">
              <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Joined</th></tr></thead>
              <tbody>
                <tr *ngFor="let m of filteredMembers">
                  <td><span class="org-person"><app-avatar [src]="m.avatar" [name]="m.username" [size]="28"></app-avatar><span>{{ m.username }}</span></span></td>
                  <td data-label="Role"><span class="org-chip org-chip--{{ m.role }}">{{ roleLabel[m.role] }}</span></td>
                  <td data-label="Joined">{{ m.joinedAt | date: 'mediumDate' }}</td>
                </tr>
              </tbody>
            </table>
            <div class="org-empty" *ngIf="members.length <= 1">
              <i class="ti ti-user-plus" aria-hidden="true"></i><strong>It's just you so far</strong>
              <a *ngIf="o.permissions['members:invite']" routerLink="/organization/settings" [queryParams]="{ tab: 'members', invite: 1 }">Invite people</a>
            </div>
          </div>
        </div>
      </ng-container>
    </section>
  `,
  styles: [`
    .home-grid { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 16px; align-items: start; }
    @media (max-width: 900px) { .home-grid { grid-template-columns: minmax(0, 1fr); } }
    .home-search { flex: 0 1 170px; }
    .home-team__head { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; padding: 7px 6px; text-align: left; color: inherit; border-radius: var(--app-radius-sm); font-weight: 600; font-size: .9rem; }
    .home-team__head:hover, .home-team__head:focus-visible { background: var(--app-hover); }
    .home-team__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .home-team__body { padding: 0 0 8px 24px; }
    .home-channel { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--app-radius-sm); cursor: pointer; color: inherit; text-decoration: none; font-size: .88rem; min-width: 0; }
    .home-channel:hover, .home-channel:focus-visible { background: var(--app-hover); }
    .home-channel--off { opacity: .6; }
    .home-manage { display: inline-flex; align-items: center; gap: 4px; margin: 4px 0 0 8px; font-size: .8rem; color: var(--app-muted); text-decoration: none; }
    .home-manage:hover { color: var(--app-text); }
  `],
})
export class OrganizationHomeComponent implements OnInit, OnDestroy {
  readonly roleLabel = ROLE_LABEL;
  org: OrgOverview | null = null;
  teams: Team[] = [];
  members: OrgMember[] = [];
  channels: Record<string, Channel[]> = {};
  open = new Set<string>();
  q = '';
  loaded = false;
  notice = "You're in your personal workspace";
  error = '';
  creating = false;
  busy = false;
  teamForm = { name: '', description: '', visibility: 'public' as 'public' | 'private' };
  private subs = new Subscription();
  private refresher = new ViewRefresher((topics) => this.load(topics));

  constructor(
    private orgs: OrganizationService,
    private clerk: ClerkService,
    private router: Router,
    private alert: AlertService,
    private sync: WorkspaceSyncService,
    private cdr: ChangeDetectorRef,
  ) {}

  get filteredTeams(): Team[] {
    const q = this.q.trim().toLowerCase();
    if (!q) return this.teams;
    return this.teams.filter((t) => t.name.toLowerCase().includes(q) || (this.channels[t.teamId] || []).some((c) => c.name.toLowerCase().includes(q)));
  }

  get filteredMembers(): OrgMember[] {
    const q = this.q.trim().toLowerCase();
    return q ? this.members.filter((m) => m.username.toLowerCase().includes(q)) : this.members;
  }

  trackTeam = (_: number, t: Team) => t.teamId;

  async ngOnInit(): Promise<void> {
    if (!this.clerk.pinnedOrganization) {
      this.loaded = true;
      this.cdr.markForCheck();
      return;
    }
    this.subs.add(this.sync.changes$.subscribe((t) => this.refresher.notify(t)));
    await this.refresher.mutate(async () => undefined, ['*']);
    // Teams I belong to start expanded
    for (const t of this.teams.filter((x) => x.myRole)) this.open.add(t.teamId);
    await this.refresher.mutate(async () => undefined, [...this.open].map((id) => `channels:${id}`));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.refresher.destroy();
  }

  /** Refetch what changed; lists are replaced from the server (no duplicates, no stale rows). */
  private async load(topics: Set<string>): Promise<void> {
    try {
      if (touches(topics, 'org') || !this.org) {
        this.org = await this.orgs.overview();
        this.sync.activeOrganizationId = this.org.organizationId;
      }
      if (touches(topics, 'teams', 'org')) {
        this.teams = await this.orgs.teams();
        // A team that disappeared (archived, or I can't see it any more) takes its channels with it
        for (const id of [...this.open]) {
          if (!this.teams.some((t) => t.teamId === id)) {
            this.open.delete(id);
            delete this.channels[id];
          }
        }
      }
      if (touches(topics, 'members', 'org')) this.members = this.org.role === 'guest' ? [] : await this.orgs.members().catch(() => this.members);
      for (const id of this.open) {
        if (touches(topics, `channels:${id}`, `team:${id}`)) this.channels[id] = await this.orgs.channels(id).catch(() => this.channels[id] || []);
      }
      this.error = '';
    } catch (e) {
      if (!this.org) this.notice = errorText(e, 'This organization is managed outside SpreeWe');
      else this.error = errorText(e, "We couldn't refresh this page.");
    } finally {
      this.loaded = true;
      this.cdr.markForCheck();
    }
  }

  async toggle(t: Team): Promise<void> {
    if (this.open.has(t.teamId)) {
      this.open.delete(t.teamId);
      this.cdr.markForCheck();
      return;
    }
    this.open.add(t.teamId);
    await this.refresher.mutate(async () => undefined, [`channels:${t.teamId}`]);
  }

  openChannel(c: Channel): void {
    if (!c.isMember) {
      this.alert.info('Join the team to read this channel.');
      return;
    }
    void this.router.navigate(['/chat'], { queryParams: { c: c.channelId } });
  }

  async joinTeam(t: Team): Promise<void> {
    try {
      this.open.add(t.teamId);
      await this.refresher.mutate(() => this.orgs.joinTeam(t.teamId), ['teams', `channels:${t.teamId}`]);
    } catch (e) {
      this.alert.error(errorText(e));
    }
  }

  async createTeam(): Promise<void> {
    this.busy = true;
    this.cdr.markForCheck();
    try {
      const { teamId } = await this.refresher.mutate(async () => {
        const r = await this.orgs.createTeam({ name: this.teamForm.name.trim(), description: this.teamForm.description.trim() || undefined, visibility: this.teamForm.visibility });
        this.open.add(r.teamId);
        return r;
      }, ['teams']);
      await this.refresher.mutate(async () => undefined, [`channels:${teamId}`]);
      this.creating = false;
      this.teamForm = { name: '', description: '', visibility: 'public' };
      this.alert.success('Team created with a General channel');
    } catch (e) {
      this.alert.error(errorText(e));
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
