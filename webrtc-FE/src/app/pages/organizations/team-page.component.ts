import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ViewRefresher, WorkspaceSyncService, touches } from 'src/app/core/services/workspace-sync.service';
import { ActivatedRoute, Router } from '@angular/router';
import { Channel, OrgMember, OrganizationService, Team, errorText } from 'src/app/core/services/organization.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { ROLE_LABEL } from './org-navigation';
import { PickPerson } from '../shared/person-picker.component';

/**
 * /teams/:teamId — a team: channels (standard / private / shared), members and roles, settings.
 * The server decides every permission (canManage is only used to hide controls it would refuse).
 */
@Component({
  selector: 'app-team-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../shell/section-pages.scss', './org-ui.scss'],
  template: `
    <section class="org-page org-page--narrow">
      <div class="org-loading" *ngIf="!loaded" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Loading team…</div>
      <div class="org-panel org-empty" *ngIf="loaded && !team">
        <i class="ti ti-users-group" aria-hidden="true"></i>
        <strong>This team isn't available</strong>
        It may have been archived, or you no longer have access.
        <div class="mt-2"><a class="btn btn-light btn-sm" routerLink="/organization">Back to the organization</a></div>
      </div>

      <ng-container *ngIf="team as t">
        <a routerLink="/organization" class="org-back"><i class="ti ti-arrow-left" aria-hidden="true"></i>Organization home</a>
        <header class="org-head">
          <span class="org-avatar" aria-hidden="true"><i class="ti ti-users-group"></i></span>
          <div class="org-head__text">
            <h1 class="org-head__title">{{ t.name }}</h1>
            <div class="org-head__meta">
              <span class="org-chip" *ngIf="t.visibility === 'private'"><i class="ti ti-lock" aria-hidden="true"></i>Private</span>
              {{ members.length }} member{{ members.length === 1 ? '' : 's' }}<ng-container *ngIf="t.myRole"> · you are <span class="org-chip">{{ roleLabel[t.myRole] }}</span></ng-container>
            </div>
          </div>
          <div class="org-head__actions">
            <button type="button" class="btn btn-primary btn-sm" *ngIf="!t.myRole && t.visibility === 'public'" [disabled]="busy" (click)="join()">Join team</button>
            <button type="button" class="btn btn-light btn-sm" *ngIf="t.myRole" [disabled]="busy" (click)="leave()">Leave team</button>
          </div>
        </header>
        <p class="org-panel__hint mb-3" *ngIf="t.description">{{ t.description }}</p>

        <div class="org-content">
          <div class="org-panel">
            <div class="org-panel__head">
              <div><h2 class="org-panel__title">Channels</h2><p class="org-panel__hint">Standard channels include the whole team; private channels only the people chosen.</p></div>
              <button type="button" class="btn btn-primary btn-sm" *ngIf="t.myRole && t.myRole !== 'guest'" (click)="newChannel = !newChannel" [attr.aria-expanded]="newChannel"><i class="ti ti-plus" aria-hidden="true"></i> New channel</button>
            </div>
            <form class="org-form mb-3" *ngIf="newChannel" (ngSubmit)="createChannel()">
              <label>Name <input class="form-control" name="cname" [(ngModel)]="channelForm.name" required maxlength="60" /></label>
              <div class="d-grid gap-1">
                <div class="segmented" role="radiogroup" aria-label="Channel type">
                  <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="channelForm.type === 'standard'" [attr.aria-checked]="channelForm.type === 'standard'" (click)="channelForm.type = 'standard'"><i class="ti ti-hash" aria-hidden="true"></i>Standard</button>
                  <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="channelForm.type === 'private'" [attr.aria-checked]="channelForm.type === 'private'" (click)="channelForm.type = 'private'"><i class="ti ti-lock" aria-hidden="true"></i>Private</button>
                </div>
                <span class="org-panel__hint">{{ channelForm.type === 'standard' ? 'Everyone on the team can see and join it.' : 'Only the people you choose (you\'re included).' }}</span>
              </div>
              <div *ngIf="channelForm.type === 'private'">
                <span class="org-check__label d-block mb-1">Members</span>
                <app-person-picker [people]="otherPeople" [selected]="channelForm.members" (toggled)="toggleMember($event)" placeholder="Search team members" empty="Add people to the team first." [maxHeight]="220"></app-person-picker>
              </div>
              <p class="org-panel__hint m-0">Shared channels with people outside the organization are created by organization admins through the API; they are always labelled External.</p>
              <div class="org-form__actions">
                <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy || !channelForm.name.trim()">{{ busy ? 'Creating…' : 'Create channel' }}</button>
                <button type="button" class="btn btn-light btn-sm" (click)="newChannel = false">Cancel</button>
              </div>
            </form>
            <div class="org-list" *ngIf="channels.length; else noChannels">
              <div *ngFor="let c of channels">
                <div class="org-list__main">
                  <i class="ti" [class.ti-hash]="c.type === 'standard'" [class.ti-lock]="c.type === 'private'" [class.ti-world]="c.type === 'shared'" aria-hidden="true"></i>
                  <strong>{{ c.name }}</strong>
                  <span class="org-chip org-chip--external ms-1" *ngIf="c.external">External</span>
                  <span class="org-panel__hint d-inline ms-1">{{ c.memberCount }} member{{ c.memberCount === 1 ? '' : 's' }}</span>
                </div>
                <div class="org-form__actions">
                  <button type="button" class="btn btn-light btn-sm" *ngIf="c.isMember" (click)="open(c)">Open</button>
                  <button type="button" class="btn btn-outline-danger btn-sm" *ngIf="t.canManage && !(c.type === 'standard' && c.name === 'General')" [disabled]="busy" (click)="deleteChannel(c)">Delete</button>
                </div>
              </div>
            </div>
            <ng-template #noChannels><div class="org-empty"><i class="ti ti-hash" aria-hidden="true"></i><strong>No channels you can see</strong>{{ t.myRole ? 'Create one for a topic or a group of people.' : 'Join the team to see its channels.' }}</div></ng-template>
          </div>

          <div class="org-panel">
            <div class="org-panel__head"><div><h2 class="org-panel__title">Members</h2><p class="org-panel__hint">Changes by team owners and managers appear here automatically.</p></div></div>
            <div class="mb-3" *ngIf="t.canManage && candidates.length">
              <button type="button" class="btn btn-light btn-sm" *ngIf="!adding" (click)="adding = true"><i class="ti ti-user-plus" aria-hidden="true"></i> Add members</button>
              <form class="org-form" *ngIf="adding" (ngSubmit)="addMember()">
                <app-person-picker [people]="candidatePeople" [selected]="toAdd" (toggled)="toggleAdd($event)" placeholder="Search organization members" [maxHeight]="240"></app-person-picker>
                <div class="org-form__actions">
                  <button type="submit" class="btn btn-primary btn-sm" [disabled]="!toAdd.size || busy">Add {{ toAdd.size || '' }} to team</button>
                  <button type="button" class="btn btn-light btn-sm" (click)="cancelAdd()">Cancel</button>
                </div>
              </form>
            </div>
            <table class="org-table org-table--stack">
              <thead><tr><th scope="col">Name</th><th scope="col">Team role</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                <tr *ngFor="let m of members">
                  <td><span class="org-person"><app-avatar [src]="m.avatar" [name]="m.username" [size]="28"></app-avatar><span>{{ m.username }}</span></span></td>
                  <td data-label="Team role">
                    <select *ngIf="t.canManage; else plain" class="form-select form-select-sm" [ngModel]="m.role" (ngModelChange)="setRole(m.userId, $event)" [disabled]="busy" [attr.aria-label]="'Team role of ' + m.username">
                      <option value="owner">Owner</option><option value="manager">Manager</option><option value="member">Member</option>
                    </select>
                    <ng-template #plain><span class="org-chip">{{ roleLabel[m.role] }}</span></ng-template>
                  </td>
                  <td class="org-table__actions"><button type="button" class="btn btn-light btn-sm" *ngIf="t.canManage" [disabled]="busy" (click)="remove(m.userId)">Remove</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </ng-container>
    </section>
  `,
})
export class TeamPageComponent implements OnInit, OnDestroy {
  readonly roleLabel = ROLE_LABEL;
  team: Team | null = null;
  channels: Channel[] = [];
  members: { userId: string; username: string; avatar: string; role: string }[] = [];
  orgMembers: OrgMember[] = [];
  loaded = false;
  busy = false;
  newChannel = false;
  channelForm = { name: '', type: 'standard' as 'standard' | 'private', members: new Set<string>() };
  /** Members being added (Add members picker) */
  adding = false;
  toAdd = new Set<string>();
  private teamId = '';
  private subs = new Subscription();
  private refresher = new ViewRefresher((topics) => this.load(topics));
  /** The signed-in user (from the stored session; the server derives identity from the token anyway) */
  private get myUserId(): string {
    return String(this.auth.getLoggedInUser()?._id || '');
  }

  constructor(
    private orgs: OrganizationService,
    private auth: AuthService,
    private route: ActivatedRoute,
    private router: Router,
    private alert: AlertService,
    private sync: WorkspaceSyncService,
    private cdr: ChangeDetectorRef,
  ) {}

  /** Team members other than me (for choosing private-channel members) */
  get others() {
    return this.members.filter((m) => m.userId !== this.myUserId);
  }

  get candidates(): OrgMember[] {
    const inTeam = new Set(this.members.map((m) => m.userId));
    return this.orgMembers.filter((m) => !inTeam.has(m.userId));
  }

  get otherPeople(): PickPerson[] {
    return this.others.map((m) => ({ id: m.userId, name: m.username, avatar: m.avatar, badge: this.roleLabel[m.role] || m.role, badgeTone: 'role' as const }));
  }

  get candidatePeople(): PickPerson[] {
    return this.candidates.map((m) => ({ id: m.userId, name: m.username, avatar: m.avatar, badge: this.roleLabel[m.role] || m.role, badgeTone: m.role === 'guest' ? 'external' as const : 'role' as const }));
  }

  toggleAdd(id: string): void {
    const next = new Set(this.toAdd);
    next.has(id) ? next.delete(id) : next.add(id);
    this.toAdd = next;
  }

  cancelAdd(): void {
    this.adding = false;
    this.toAdd = new Set();
  }

  async ngOnInit(): Promise<void> {
    this.subs.add(this.sync.changes$.subscribe((t) => this.refresher.notify(t)));
    // Same component for another team (back / forward, a link): load that team
    this.subs.add(this.route.paramMap.subscribe((p) => {
      const id = p.get('teamId') || '';
      if (id && id !== this.teamId && this.teamId) {
        this.teamId = id;
        this.team = null;
        this.loaded = false;
        void this.refresher.mutate(async () => undefined, ['*']);
      }
    }));
    this.teamId = this.route.snapshot.paramMap.get('teamId') || '';
    await this.refresher.mutate(async () => undefined, ['*']);
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.refresher.destroy();
  }

  /** Refetch what changed for this team (lists replaced from the server). */
  private async load(topics: Set<string>): Promise<void> {
    const id = this.teamId;
    try {
      if (touches(topics, `team:${id}`, 'teams', 'org') || !this.team) this.team = await this.orgs.team(id);
      if (touches(topics, `team:${id}`, `channels:${id}`)) this.channels = await this.orgs.channels(id);
      if (touches(topics, `team:${id}`, `teamMembers:${id}`)) this.members = await this.orgs.teamMembers(id);
      if (this.team.canManage && touches(topics, 'members', `team:${id}`)) this.orgMembers = await this.orgs.members().catch(() => this.orgMembers);
    } catch {
      // Archived, or I can no longer see it: show the "not available" state, nothing stale
      this.team = null;
      this.channels = [];
      this.members = [];
    } finally {
      this.loaded = true;
      this.cdr.markForCheck();
    }
  }

  private async act(task: () => Promise<unknown>, topics: string[], done?: string): Promise<void> {
    this.busy = true;
    this.cdr.markForCheck();
    try {
      await this.refresher.mutate(task, topics);
      if (done) this.alert.success(done);
    } catch (e) {
      this.alert.error(errorText(e));
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  toggleMember(id: string): void {
    const next = new Set(this.channelForm.members);
    next.has(id) ? next.delete(id) : next.add(id);
    this.channelForm.members = next;
  }

  createChannel(): Promise<void> {
    return this.act(async () => {
      await this.orgs.createChannel(this.teamId, { name: this.channelForm.name.trim(), type: this.channelForm.type, memberIds: this.channelForm.type === 'private' ? [...this.channelForm.members] : undefined });
      this.newChannel = false;
      this.channelForm = { name: '', type: 'standard', members: new Set() };
    }, [`channels:${this.teamId}`], 'Channel created');
  }

  open(c: Channel): void {
    void this.router.navigate(['/chat'], { queryParams: { c: c.channelId } });
  }

  async deleteChannel(c: Channel): Promise<void> {
    const ok = await this.alert.confirm({ title: `Delete "${c.name}"?`, text: 'Its history is kept, but nobody can open the channel any more.', confirmText: 'Delete channel', danger: true });
    if (ok) await this.act(() => this.orgs.deleteChannel(this.teamId, c.channelId), [`channels:${this.teamId}`], 'Channel deleted');
  }

  join(): Promise<void> {
    return this.act(() => this.orgs.joinTeam(this.teamId), [`team:${this.teamId}`], 'You joined the team');
  }

  leave(): Promise<void> {
    return this.act(() => this.orgs.removeTeamMember(this.teamId, this.myUserId), [`team:${this.teamId}`], 'You left the team');
  }

  addMember(): Promise<void> {
    return this.act(async () => {
      await this.orgs.addTeamMembers(this.teamId, [...this.toAdd]);
      this.cancelAdd();
    }, [`teamMembers:${this.teamId}`], 'Added to the team');
  }

  setRole(userId: string, role: string): Promise<void> {
    return this.act(() => this.orgs.setTeamRole(this.teamId, userId, role), [`team:${this.teamId}`], 'Role changed');
  }

  async remove(userId: string): Promise<void> {
    const who = this.members.find((m) => m.userId === userId)?.username || 'this member';
    const ok = await this.alert.confirm({ title: `Remove ${who} from the team?`, text: 'They leave all of its channels.', confirmText: 'Remove', danger: true });
    if (ok) await this.act(() => this.orgs.removeTeamMember(this.teamId, userId), [`team:${this.teamId}`], 'Removed from the team');
  }
}
