import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ViewRefresher, WorkspaceSyncService, touches } from 'src/app/core/services/workspace-sync.service';
import { ActivatedRoute } from '@angular/router';
import { InviteResult, JoinRequestRow, OrgInvitation, OrgMember, OrgOverview, OrgRole, OrgSettings, OrganizationService, Team, errorText } from 'src/app/core/services/organization.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { JOIN_POLICY_LABEL, ROLE_LABEL } from './org-navigation';

type Tab = 'general' | 'members' | 'teams' | 'external' | 'privacy' | 'admin';
/** Older links (?tab=invitations …) keep working: they open the section that now holds them. */
const TAB_ALIAS: Record<string, Tab> = { invitations: 'members', requests: 'members', ownership: 'admin', audit: 'admin' };

/**
 * /organization/settings — administration of the active organization. Which tabs and controls appear
 * follows the permissions the server reports; every action is still checked by the server.
 */
@Component({
  selector: 'app-organization-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./org-ui.scss'],
  template: `
    <section class="org-page">
      <div class="org-loading" *ngIf="!loaded" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Loading organization settings…</div>
      <div class="org-panel org-empty" *ngIf="loaded && !org">
        <i class="ti ti-building" aria-hidden="true"></i>
        <strong>{{ notice }}</strong>
        <a routerLink="/organizations/join" class="btn btn-light btn-sm mt-2">Find or join an organization</a>
      </div>

      <ng-container *ngIf="org as o">
        <a routerLink="/organization" class="org-back"><i class="ti ti-arrow-left" aria-hidden="true"></i>Organization home</a>
        <header class="org-head">
          <span class="org-avatar" aria-hidden="true">{{ initial(o.name) }}</span>
          <div class="org-head__text">
            <h1 class="org-head__title">{{ o.name }}</h1>
            <div class="org-head__meta">Organization settings · you are <span class="org-chip org-chip--{{ o.role }}">{{ roleLabel[o.role] }}</span> · {{ o.memberCount }} member{{ o.memberCount === 1 ? '' : 's' }}</div>
          </div>
        </header>

        <div class="org-settings">
          <nav class="org-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
            <button type="button" role="tab" *ngFor="let t of visibleTabs" [attr.aria-selected]="tab === t" [attr.aria-controls]="'org-panel-' + t" (click)="select(t)">
              <i class="ti {{ tabIcon[t] }}" aria-hidden="true"></i>{{ tabLabel[t] }}
              <span class="org-chip org-chip--count ms-auto" *ngIf="t === 'members' && requests.length" [attr.aria-label]="requests.length + ' pending join requests'">{{ requests.length }}</span>
            </button>
          </nav>

          <div class="org-content" [id]="'org-panel-' + tab" role="tabpanel">
            <div class="org-banner" *ngIf="error" role="alert"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>{{ error }}</span></div>

            <!-- General -->
            <form class="org-panel org-form" *ngIf="tab === 'general'" (ngSubmit)="saveGeneral()" (input)="editingGeneral = true">
              <div><h2 class="org-panel__title">Profile</h2><p class="org-panel__hint">How the organization appears to its members and in search.</p></div>
              <label>Name <input class="form-control" name="n" [(ngModel)]="general.name" [disabled]="!can('org:update')" maxlength="80" required /></label>
              <label>URL name <input class="form-control org-mono" name="s" [(ngModel)]="general.slug" [disabled]="!can('org:update')" maxlength="40" pattern="[a-z0-9-]{3,40}" /></label>
              <label>Description <textarea class="form-control" name="d" rows="3" [(ngModel)]="general.description" [disabled]="!can('org:update')" maxlength="500"></textarea></label>
              <div class="org-form__actions" *ngIf="can('org:update')">
                <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy">{{ busy ? 'Saving…' : 'Save changes' }}</button>
                <span class="org-panel__hint m-0" *ngIf="editingGeneral">Unsaved changes</span>
              </div>
            </form>

            <!-- Members & roles -->
            <div class="org-panel" *ngIf="tab === 'members'">
              <div class="org-panel__head">
                <div><h2 class="org-panel__title">Members</h2><p class="org-panel__hint">{{ members.length }} active member{{ members.length === 1 ? '' : 's' }}. Changes made by other admins appear here automatically.</p></div>
                <button type="button" class="btn btn-light btn-sm" *ngIf="can('members:invite')" (click)="focusInvite()"><i class="ti ti-user-plus" aria-hidden="true"></i> Invite people</button>
              </div>
              <div class="org-toolbar">
                <div class="org-search"><i class="ti ti-search" aria-hidden="true"></i><input class="form-control form-control-sm" [(ngModel)]="memberQuery" placeholder="Search members" aria-label="Search members" /></div>
                <div class="org-filter" role="group" aria-label="Filter by role">
                  <button type="button" *ngFor="let r of roleFilters" [attr.aria-pressed]="roleFilter === r" (click)="roleFilter = r">{{ r === 'all' ? 'All' : roleLabel[r] }}</button>
                </div>
              </div>
              <table class="org-table org-table--stack" *ngIf="filteredMembers.length; else noMembers">
                <thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
                <tbody>
                  <tr *ngFor="let m of filteredMembers; trackBy: trackMember">
                    <td><span class="org-person"><app-avatar [src]="m.avatar" [name]="m.username" [size]="28"></app-avatar><span>{{ m.username }}<span class="org-panel__hint d-inline" *ngIf="m.userId === myId"> (you)</span></span></span></td>
                    <td data-label="Role">
                      <select *ngIf="can('members:role') && m.userId !== myId && assignable(m).length > 1; else roleText" class="form-select form-select-sm" [ngModel]="m.role" (ngModelChange)="setRole(m, $event)" [disabled]="busy" [attr.aria-label]="'Role of ' + m.username">
                        <option *ngFor="let r of assignable(m)" [value]="r">{{ roleLabel[r] }}</option>
                      </select>
                      <ng-template #roleText><span class="org-chip org-chip--{{ m.role }}">{{ roleLabel[m.role] }}</span></ng-template>
                    </td>
                    <td data-label="Joined">{{ m.joinedAt | date: 'mediumDate' }}</td>
                    <td class="org-table__actions"><button type="button" class="btn btn-outline-danger btn-sm" *ngIf="can('members:remove') && m.userId !== myId && m.role !== 'owner'" [disabled]="busy" (click)="removeMember(m)">Remove</button></td>
                  </tr>
                </tbody>
              </table>
              <ng-template #noMembers><div class="org-empty"><i class="ti ti-users" aria-hidden="true"></i><strong>No members match</strong>Try another name or role.</div></ng-template>
            </div>
            <div class="org-panel" *ngIf="tab === 'general'">
              <div class="org-panel__head mb-0">
                <div><h2 class="org-panel__title">Leave organization</h2><p class="org-panel__hint">You lose access to its teams, channels and chats. The last owner must transfer ownership first.</p></div>
                <button type="button" class="btn btn-light btn-sm" [disabled]="busy" (click)="leave()">Leave</button>
              </div>
            </div>

            <!-- Invitations -->
            <ng-container *ngIf="tab === 'members' && can('members:invite')">
              <form class="org-panel org-form" *ngIf="can('members:invite')" (ngSubmit)="invite()">
                <div><h2 class="org-panel__title">Invite people</h2><p class="org-panel__hint">Each invitation works once, only for the invited (verified) email address.</p></div>
                <label>Email addresses <textarea id="org-invite-emails" class="form-control" name="emails" rows="3" [(ngModel)]="inviteForm.emails" placeholder="name@example.com, another@example.com"></textarea></label>
                <div class="org-form__row">
                  <label>Role
                    <select class="form-select form-select-sm" name="role" [(ngModel)]="inviteForm.role"><option *ngFor="let r of o.invitableRoles" [value]="r">{{ roleLabel[r] }}</option></select></label>
                  <label>Expires after (days) <input type="number" class="form-control form-control-sm" name="days" min="1" max="30" [(ngModel)]="inviteForm.days" /></label>
                </div>
                <div class="org-form__actions"><button type="submit" class="btn btn-primary btn-sm" [disabled]="busy || !inviteForm.emails.trim() || !o.invitableRoles.length">{{ busy ? 'Creating…' : 'Create invitations' }}</button></div>
              </form>
              <div class="org-panel" *ngIf="links.length" role="status">
                <div class="org-panel__head"><div><h2 class="org-panel__title">Share these links</h2><p class="org-panel__hint">Email delivery isn't configured, so send each person their link. It is not shown again.</p></div>
                  <button type="button" class="btn btn-light btn-sm" (click)="links = []">Done</button></div>
                <div class="org-list">
                  <div *ngFor="let l of links">
                    <div class="org-list__main"><strong>{{ l.email }}</strong>
                      <div class="org-panel__hint" *ngIf="l.status !== 'invited'">{{ l.status === 'already_member' ? 'Already a member' : 'Email domain not allowed' }}</div>
                      <code class="org-mono d-block text-break" *ngIf="l.link">{{ l.link }}</code></div>
                    <button type="button" class="btn btn-light btn-sm" *ngIf="l.link" (click)="copy(l.link)"><i class="ti ti-copy" aria-hidden="true"></i> Copy</button>
                  </div>
                </div>
              </div>
              <div class="org-panel">
                <div class="org-panel__head"><div><h2 class="org-panel__title">Invitations</h2><p class="org-panel__hint">Status updates when someone accepts, or another admin changes an invitation.</p></div></div>
                <table class="org-table org-table--stack" *ngIf="invitations.length; else noInvites">
                  <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
                  <tbody>
                    <tr *ngFor="let i of invitations">
                      <td class="text-break">{{ i.email }}</td>
                      <td data-label="Role">{{ roleLabel[i.role] }}</td>
                      <td data-label="Status"><span class="org-chip" [class.org-chip--ok]="i.status === 'accepted'" [class.org-chip--warn]="i.status === 'pending' && !expired(i)" [class.org-chip--bad]="i.status === 'revoked' || i.status === 'expired' || expired(i)">{{ expired(i) ? 'expired' : i.status }}</span></td>
                      <td data-label="Expires">{{ i.expiresAt | date: 'mediumDate' }}</td>
                      <td class="org-table__actions">
                        <ng-container *ngIf="i.status === 'pending' && !expired(i) && can('members:invite')">
                          <button type="button" class="btn btn-light btn-sm me-1" [disabled]="busy" (click)="resend(i)">New link</button>
                          <button type="button" class="btn btn-outline-danger btn-sm" [disabled]="busy" (click)="revoke(i)">Revoke</button>
                        </ng-container>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <ng-template #noInvites><div class="org-empty"><i class="ti ti-mail" aria-hidden="true"></i><strong>No invitations yet</strong>Invite people above; their invitations are listed here.</div></ng-template>
              </div>
            </ng-container>

            <!-- Join requests -->
            <div class="org-panel" *ngIf="tab === 'members' && can('requests:decide')">
              <div class="org-panel__head"><div><h2 class="org-panel__title">Join requests</h2><p class="org-panel__hint">People who found the organization in search and asked to join. New requests appear automatically.</p></div></div>
              <div class="org-list" *ngIf="requests.length; else noRequests">
                <div *ngFor="let r of requests">
                  <div class="org-list__main"><strong>{{ r.username }}</strong> <span class="org-panel__hint d-inline">{{ r.email }}</span>
                    <div class="org-panel__hint" *ngIf="r.message">“{{ r.message }}”</div></div>
                  <div class="org-form__actions">
                    <button type="button" class="btn btn-primary btn-sm" [disabled]="busy" (click)="decide(r, true)">Approve</button>
                    <button type="button" class="btn btn-light btn-sm" [disabled]="busy" (click)="decide(r, false)">Reject</button>
                  </div>
                </div>
              </div>
              <ng-template #noRequests><div class="org-empty"><i class="ti ti-inbox" aria-hidden="true"></i><strong>No pending requests</strong>Requests appear when the organization is discoverable and asks for approval.</div></ng-template>
            </div>

            <!-- Privacy & discovery -->
            <ng-container *ngIf="tab === 'privacy' && settings">
              <form class="org-panel org-form" (ngSubmit)="saveSettings()" (change)="editingSettings = true" (input)="editingSettings = true">
                <div><h2 class="org-panel__title">Discovery and joining</h2><p class="org-panel__hint">Being listed never gives access to any content.</p></div>
                <div>
                  <label class="org-check"><input type="checkbox" class="form-check-input" name="disc" [(ngModel)]="settings.discoverable" />
                    <span><span class="org-check__label">Discoverable</span><span class="org-check__hint">Listed in organization search.</span></span></label>
                  <label class="org-check"><input type="checkbox" class="form-check-input" name="mci" [(ngModel)]="settings.membersCanInvite" />
                    <span><span class="org-check__label">Members can invite</span><span class="org-check__hint">As members only; owners and admins can always invite.</span></span></label>
                  <label class="org-check"><input type="checkbox" class="form-check-input" name="mct" [(ngModel)]="settings.membersCanCreateTeams" />
                    <span><span class="org-check__label">Members can create teams</span></span></label>
                  <label class="org-check"><input type="checkbox" class="form-check-input" name="ga" [(ngModel)]="settings.guestAccess" />
                    <span><span class="org-check__label">Guest access</span><span class="org-check__hint">Guests see only teams and channels they're added to, and no member directory.</span></span></label>
                </div>
                <div class="org-form__row">
                  <label>How people join
                    <select class="form-select" name="jp" [(ngModel)]="settings.joinPolicy" [disabled]="!settings.discoverable">
                      <option value="invite">{{ policyLabel['invite'] }}</option>
                      <option value="request">{{ policyLabel['request'] }}</option>
                      <option value="open">{{ policyLabel['open'] }}</option>
                    </select></label>
                  <label>Allowed email domains <input class="form-control" name="dom" [(ngModel)]="domains" placeholder="example.com (optional)" /></label>
                </div>
                <div class="org-form__actions">
                  <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy">{{ busy ? 'Saving…' : 'Save changes' }}</button>
                  <span class="org-panel__hint m-0" *ngIf="editingSettings">Unsaved changes</span>
                </div>
              </form>
              <div class="org-panel">
                <div class="org-panel__head"><div><h2 class="org-panel__title">Join code</h2><p class="org-panel__hint">Anyone with the code can join as a member, even if the organization is private.</p></div></div>
                <div class="org-form__actions">
                  <button type="button" class="btn btn-light btn-sm" [disabled]="busy" (click)="joinCode(true)">{{ settings.joinCodeSet ? 'New join code' : 'Create join code' }}</button>
                  <button type="button" class="btn btn-light btn-sm" *ngIf="settings.joinCodeSet" [disabled]="busy" (click)="joinCode(false)">Turn off</button>
                </div>
                <div class="org-secret mt-3" *ngIf="code" role="alert">Join code <code class="org-mono">{{ code.code }}</code> — shown once.
                  <div class="text-break mt-1">{{ code.link }}</div>
                  <button type="button" class="btn btn-sm btn-light mt-2" (click)="copy(code.link)"><i class="ti ti-copy" aria-hidden="true"></i> Copy link</button></div>
              </div>
            </ng-container>

            <!-- Teams & channels -->
            <div class="org-panel" *ngIf="tab === 'teams'">
              <div class="org-panel__head">
                <div><h2 class="org-panel__title">Teams and channels</h2><p class="org-panel__hint">Teams group people; each has channels. Open a team to manage its members, roles and channels.</p></div>
                <a class="btn btn-light btn-sm" routerLink="/organization">Open Teams</a>
              </div>
              <div class="org-list" *ngIf="teams.length; else noTeams">
                <a *ngFor="let t of teams" [routerLink]="['/teams', t.teamId]" class="text-reset text-decoration-none">
                  <div class="org-list__main"><strong>{{ t.name }}</strong> <span class="org-chip ms-1" *ngIf="t.visibility === 'private'"><i class="ti ti-lock" aria-hidden="true"></i>Private</span>
                    <div class="org-panel__hint">{{ t.memberCount }} member{{ t.memberCount === 1 ? '' : 's' }}<ng-container *ngIf="t.myRole"> · you are {{ roleLabel[t.myRole] }}</ng-container></div></div>
                  <i class="ti ti-chevron-right" aria-hidden="true"></i>
                </a>
              </div>
              <ng-template #noTeams><div class="org-empty"><i class="ti ti-users-group" aria-hidden="true"></i><strong>No teams yet</strong>Create teams from the Teams page.</div></ng-template>
            </div>

            <!-- External access -->
            <div class="org-panel" *ngIf="tab === 'external'">
              <div><h2 class="org-panel__title">External access</h2><p class="org-panel__hint">Everything that lets data leave the organization is off by default. External people are always labelled External.</p></div>
              <div class="mt-2">
                <label class="org-check" *ngFor="let p of externalPolicies">
                  <input type="checkbox" class="form-check-input" [checked]="o.policies[p.key]" [disabled]="!can('org:update') || busy" (change)="setPolicy(p.key, !o.policies[p.key])" />
                  <span><span class="org-check__label">{{ p.label }}</span><span class="org-check__hint">{{ p.hint }}</span></span>
                </label>
              </div>
            </div>

            <!-- Ownership & deletion -->
            <ng-container *ngIf="tab === 'admin'">
              <div class="org-panel org-form">
                <div><h2 class="org-panel__title">Transfer ownership</h2><p class="org-panel__hint">The member becomes an owner; you become an admin.</p></div>
                <div class="org-form__row">
                  <select class="form-select form-select-sm" [(ngModel)]="transferTo" aria-label="New owner">
                    <option value="">Choose a member…</option>
                    <option *ngFor="let m of transferable" [value]="m.userId">{{ m.username }}</option>
                  </select>
                  <div><button type="button" class="btn btn-light btn-sm" [disabled]="!transferTo || busy" (click)="transfer()">Transfer ownership</button></div>
                </div>
              </div>
              <div class="org-panel org-panel--danger org-form">
                <div><h2 class="org-panel__title">Delete organization</h2><p class="org-panel__hint">Everyone loses access immediately. Data is kept but can't be opened. Type <strong>{{ o.name }}</strong> to confirm.</p></div>
                <div class="org-form__row">
                  <input class="form-control form-control-sm" [(ngModel)]="confirmName" [attr.aria-label]="'Type ' + o.name + ' to confirm'" autocomplete="off" />
                  <div><button type="button" class="btn btn-danger btn-sm" [disabled]="confirmName !== o.name || busy" (click)="deleteOrg()">Delete organization</button></div>
                </div>
              </div>
            </ng-container>

            <!-- Audit -->
            <div class="org-panel" *ngIf="tab === 'admin' && can('org:audit')">
              <div class="org-panel__head"><div><h2 class="org-panel__title">Audit log</h2><p class="org-panel__hint">Administrative changes, newest first.</p></div></div>
              <table class="org-table org-table--stack" *ngIf="auditRows.length; else noAudit">
                <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Details</th></tr></thead>
                <tbody><tr *ngFor="let e of auditRows"><td>{{ e.at | date: 'medium' }}</td><td data-label="Action">{{ e.action }}</td><td data-label="Details" class="org-panel__hint m-0 text-break">{{ details(e.target) }}</td></tr></tbody>
              </table>
              <ng-template #noAudit><div class="org-empty"><i class="ti ti-history" aria-hidden="true"></i><strong>Nothing recorded yet</strong></div></ng-template>
            </div>
          </div>
        </div>
      </ng-container>
    </section>
  `,
})
export class OrganizationSettingsComponent implements OnInit, OnDestroy {
  readonly roleLabel = ROLE_LABEL;
  readonly policyLabel = JOIN_POLICY_LABEL;
  readonly tabLabel: Record<Tab, string> = { general: 'General', members: 'Members & roles', teams: 'Teams & channels', external: 'External communication', privacy: 'Privacy & discovery', admin: 'Administration' };
  readonly tabIcon: Record<Tab, string> = { general: 'ti-id', members: 'ti-users', teams: 'ti-users-group', external: 'ti-world', privacy: 'ti-eye', admin: 'ti-key' };
  teams: Team[] = [];
  readonly roleFilters: ('all' | OrgRole)[] = ['all', 'owner', 'admin', 'member', 'guest'];
  memberQuery = '';
  roleFilter: 'all' | OrgRole = 'all';
  readonly externalPolicies = [
    { key: 'allowExternalChat', label: 'External chat', hint: 'Members may chat with people outside the organization (always labelled External)' },
    { key: 'allowExternalCalls', label: 'Calls with external people', hint: 'Needs external chat' },
    { key: 'allowExternalFiles', label: 'File sharing with external people', hint: 'Needs external chat' },
    { key: 'membersCanStartExternal', label: 'Members can start external chats', hint: 'Otherwise only owners and admins' },
  ];
  org: OrgOverview | null = null;
  settings: OrgSettings | null = null;
  domains = '';
  tab: Tab = 'general';
  general = { name: '', slug: '', description: '' };
  members: OrgMember[] = [];
  invitations: OrgInvitation[] = [];
  requests: JoinRequestRow[] = [];
  auditRows: { action: string; at: string; target: Record<string, unknown> }[] = [];
  links: InviteResult[] = [];
  inviteForm = { emails: '', role: 'member' as OrgRole, days: 7 };
  code: { code: string; link: string } | null = null;
  transferTo = '';
  confirmName = '';
  loaded = false;
  busy = false;
  /** Refresh problem shown above the content (the page keeps what it had) */
  error = '';
  /** While a form is being edited, live updates don't overwrite what the user typed */
  editingGeneral = false;
  editingSettings = false;
  private subs = new Subscription();
  private refresher = new ViewRefresher((topics) => this.load(topics));
  notice = 'Switch to an organization to manage it';
  /** The signed-in user (stored session; the server identifies me from the token anyway) */
  get myId(): string {
    return String(this.auth.getLoggedInUser()?._id || '');
  }

  constructor(
    private orgs: OrganizationService,
    private auth: AuthService,
    private route: ActivatedRoute,
    private alert: AlertService,
    private sync: WorkspaceSyncService,
    private cdr: ChangeDetectorRef,
  ) {}

  can(p: string): boolean {
    return !!this.org?.permissions?.[p];
  }

  get visibleTabs(): Tab[] {
    const t: Tab[] = ['general', 'members'];
    if (this.org?.role !== 'guest') t.push('teams');
    if (this.can('org:update')) t.push('external', 'privacy');
    if (this.can('org:delete') || this.can('org:audit')) t.push('admin');
    return t;
  }

  get filteredMembers(): OrgMember[] {
    const q = this.memberQuery.trim().toLowerCase();
    return this.members.filter((m) => (this.roleFilter === 'all' || m.role === this.roleFilter) && (!q || m.username.toLowerCase().includes(q)));
  }

  trackMember = (_: number, m: OrgMember) => m.userId;

  initial(name: string): string {
    return (name.trim()[0] || '?').toUpperCase();
  }

  /** Pending but past its expiry (the server marks it expired when the list is next loaded). */
  expired(i: OrgInvitation): boolean {
    return i.status === 'pending' && new Date(i.expiresAt).getTime() <= Date.now();
  }

  get transferable(): OrgMember[] {
    return this.members.filter((m) => m.userId !== this.myId && m.role !== 'guest');
  }

  /** Roles the server would accept for this member (owners: all; admins: member ↔ guest). */
  assignable(m: OrgMember): OrgRole[] {
    if (this.org?.role === 'owner') return ['owner', 'admin', 'member', ...(this.org.settings?.guestAccess || m.role === 'guest' ? ['guest' as OrgRole] : [])];
    if (m.role === 'owner' || m.role === 'admin') return [m.role];
    return ['member', ...(this.org?.settings?.guestAccess || m.role === 'guest' ? ['guest' as OrgRole] : [])];
  }

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const raw = params.get('tab') || '';
    const wanted = (TAB_ALIAS[raw] || raw) as Tab;
    const inviting = params.get('invite') === '1' || raw === 'invitations';
    // Changes by anyone (another admin, the member themselves) show up here without a reload
    this.subs.add(this.sync.changes$.subscribe((t) => this.refresher.notify(t)));
    await this.refresher.mutate(async () => undefined, ['org']);
    if (wanted && this.visibleTabs.includes(wanted)) await this.select(wanted);
    if (inviting && this.tab === 'members') this.focusInvite();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.refresher.destroy();
  }

  /** Refetch what changed (lists are replaced, never appended to). */
  private async load(topics: Set<string>): Promise<void> {
    try {
      if (touches(topics, 'org') || !this.org) {
        this.org = await this.orgs.overview();
        this.sync.activeOrganizationId = this.org.organizationId;
        if (!this.editingGeneral) this.general = { name: this.org.name, slug: this.org.slug, description: this.org.description };
        if (!this.editingSettings) {
          this.settings = this.org.settings ? { ...this.org.settings } : null;
          this.domains = (this.settings?.allowedEmailDomains || []).join(', ');
        }
      }
      const role = this.org.role;
      if (touches(topics, 'org', 'members')) this.members = role === 'guest' ? [] : await this.orgs.members().catch(() => this.members);
      if (touches(topics, 'org', 'requests') && this.can('requests:decide')) this.requests = await this.orgs.joinRequests().catch(() => this.requests);
      if (touches(topics, 'org', 'invitations') && this.can('members:invite') && this.tab === 'members') this.invitations = await this.orgs.invitations().catch(() => this.invitations);
      if (this.tab === 'teams' && touches(topics, 'org', 'teams')) this.teams = await this.orgs.teams().catch(() => this.teams);
      if (this.tab === 'admin' && this.can('org:audit')) this.auditRows = await this.orgs.audit().catch(() => this.auditRows);
      // A tab I may no longer see (my role changed): back to General
      if (!this.visibleTabs.includes(this.tab)) this.tab = 'general';
      this.error = '';
    } catch (e) {
      if (!this.org) this.notice = errorText(e, this.notice);
      else this.error = errorText(e, "We couldn't refresh this page.");
    } finally {
      this.loaded = true;
      this.cdr.markForCheck();
    }
  }

  /** "Invite" is an action of the Members section: open it and put the cursor in the invite form. */
  focusInvite(): void {
    void this.select('members').then(() => setTimeout(() => document.getElementById('org-invite-emails')?.focus()));
  }

  async select(t: Tab): Promise<void> {
    this.tab = t;
    this.cdr.markForCheck();
    if (t === 'members' && this.can('members:invite')) this.invitations = await this.orgs.invitations().catch(() => []);
    if (t === 'members' && this.can('requests:decide')) this.requests = await this.orgs.joinRequests().catch(() => []);
    if (t === 'teams') this.teams = await this.orgs.teams().catch(() => []);
    if (t === 'admin' && this.can('org:audit')) this.auditRows = await this.orgs.audit().catch(() => []);
    this.cdr.markForCheck();
  }

  /** Run a change; the affected topics are reloaded afterwards whatever happens (no stale rows). */
  private async act(task: () => Promise<unknown>, topics: string[], done?: string): Promise<boolean> {
    this.busy = true;
    this.cdr.markForCheck();
    try {
      await this.refresher.mutate(task, topics);
      if (done) this.alert.success(done);
      return true;
    } catch (e) {
      this.alert.error(errorText(e));
      return false;
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  async saveGeneral(): Promise<void> {
    this.editingGeneral = false;
    await this.act(() => this.orgs.update({ name: this.general.name.trim(), slug: this.general.slug.trim(), description: this.general.description }), ['org'], 'Saved');
  }

  async saveSettings(): Promise<void> {
    const s = this.settings!;
    const allowedEmailDomains = this.domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
    this.editingSettings = false;
    await this.act(() => this.orgs.update({ settings: { discoverable: s.discoverable, joinPolicy: s.joinPolicy, allowedEmailDomains, membersCanInvite: s.membersCanInvite, membersCanCreateTeams: s.membersCanCreateTeams, guestAccess: s.guestAccess } }), ['org'], 'Saved');
  }

  async setPolicy(key: string, value: boolean): Promise<void> {
    await this.act(() => this.orgs.updatePolicies({ [key]: value }), ['org'], 'Policy updated');
  }

  async setRole(m: OrgMember, role: OrgRole): Promise<void> {
    if (role === m.role) return;
    await this.act(() => this.orgs.setRole(m.userId, role), ['members', 'org'], `${m.username} is now ${ROLE_LABEL[role]}`);
  }

  async removeMember(m: OrgMember): Promise<void> {
    const ok = await this.alert.confirm({ title: `Remove ${m.username}?`, text: 'They lose access to the organization, its teams and channels immediately.', confirmText: 'Remove', danger: true });
    if (ok) await this.act(() => this.orgs.removeMember(m.userId), ['members', 'org'], 'Member removed');
  }

  async leave(): Promise<void> {
    const ok = await this.alert.confirm({ title: 'Leave this organization?', text: 'You lose access to its teams, channels and chats.', confirmText: 'Leave', danger: true });
    if (ok && (await this.act(() => this.orgs.leave(), []))) await this.sync.leaveWorkspace('You left the organization.');
  }

  async invite(): Promise<void> {
    const emails = this.inviteForm.emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    if (!emails.length) return;
    await this.act(async () => {
      const r = await this.orgs.invite(emails, this.inviteForm.role, Number(this.inviteForm.days) || 7);
      this.links = r.results;
      this.inviteForm.emails = '';
    }, ['invitations']);
  }

  async resend(i: OrgInvitation): Promise<void> {
    await this.act(async () => {
      const r = await this.orgs.resendInvitation(i.invitationId);
      this.links = [{ email: i.email, status: 'invited', link: r.link, emailed: r.emailed }];
    }, ['invitations']);
  }

  async revoke(i: OrgInvitation): Promise<void> {
    await this.act(() => this.orgs.revokeInvitation(i.invitationId), ['invitations'], 'Invitation revoked');
  }

  async decide(r: JoinRequestRow, approve: boolean): Promise<void> {
    await this.act(() => this.orgs.decide(r.requestId, approve), ['requests', 'members', 'org'], approve ? `${r.username} joined` : 'Request rejected');
  }

  async joinCode(enable: boolean): Promise<void> {
    await this.act(async () => {
      const r = await this.orgs.setJoinCode(enable);
      this.code = r.code && r.link ? { code: r.code, link: r.link } : null;
    }, ['org'], enable ? undefined : 'Join code turned off');
  }

  async transfer(): Promise<void> {
    const ok = await this.alert.confirm({ title: 'Transfer ownership?', text: 'The member becomes an owner and you become an admin.', confirmText: 'Transfer' });
    if (ok) await this.act(() => this.orgs.transfer(this.transferTo), ['org', 'members'], 'Ownership transferred');
  }

  async deleteOrg(): Promise<void> {
    if (await this.act(() => this.orgs.remove(this.confirmName), [])) await this.sync.leaveWorkspace('The organization was deleted.');
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
    this.alert.info('Copied');
  }

  details(target: Record<string, unknown>): string {
    return Object.entries(target || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
  }
}
