import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { AuthService } from 'src/app/core/services/auth.service';
import { Channel, OrganizationService, Team, errorText } from 'src/app/core/services/organization.service';
import { PickPerson } from '../shared/person-picker.component';
import { ROLE_LABEL } from './org-navigation';

/** New team (opened from the chat list's Teams & channels menu). Closes with { teamId }. */
@Component({
  selector: 'app-create-team-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-header">
      <div>
        <h2 class="modal-title h5" id="create-team-title">Create a team</h2>
        <p class="modal-subtitle">Every team starts with a General channel for all its members.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="modal.dismiss()"></button>
    </div>
    <form (ngSubmit)="submit()" novalidate>
      <div class="modal-body d-grid gap-3">
        <div>
          <label class="form-label" for="ct-name">Team name</label>
          <input id="ct-name" class="form-control" name="name" [(ngModel)]="name" maxlength="80" required ngbAutofocus placeholder="e.g. Engineering" />
        </div>
        <div>
          <label class="form-label" for="ct-desc">Description <span class="text-muted">(optional)</span></label>
          <input id="ct-desc" class="form-control" name="description" [(ngModel)]="description" maxlength="500" placeholder="What is this team about?" />
        </div>
        <div>
          <span class="form-label d-block" id="ct-vis">Privacy</span>
          <div class="segmented" role="radiogroup" aria-labelledby="ct-vis">
            <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="visibility === 'public'" [attr.aria-checked]="visibility === 'public'" (click)="visibility = 'public'"><i class="ti ti-world" aria-hidden="true"></i>Public</button>
            <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="visibility === 'private'" [attr.aria-checked]="visibility === 'private'" (click)="visibility = 'private'"><i class="ti ti-lock" aria-hidden="true"></i>Private</button>
          </div>
          <p class="form-text mb-0">{{ visibility === 'public' ? 'Anyone in the organization can find and join it.' : 'Only people that team owners add can see it.' }}</p>
        </div>
        <div class="form-error" *ngIf="error" role="alert"><i class="ti ti-alert-triangle" aria-hidden="true"></i>{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-light" (click)="modal.dismiss()">Cancel</button>
        <button type="submit" class="btn btn-primary" [disabled]="busy || name.trim().length < 2">{{ busy ? 'Creating…' : 'Create team' }}</button>
      </div>
    </form>
  `,
})
export class CreateTeamDialogComponent {
  name = '';
  description = '';
  visibility: 'public' | 'private' = 'public';
  busy = false;
  error = '';

  constructor(public modal: NgbActiveModal, private orgs: OrganizationService, private cdr: ChangeDetectorRef) {}

  async submit(): Promise<void> {
    if (this.busy || this.name.trim().length < 2) return;
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const { teamId } = await this.orgs.createTeam({ name: this.name.trim(), description: this.description.trim() || undefined, visibility: this.visibility });
      this.modal.close({ teamId });
    } catch (e) {
      this.error = errorText(e, "We couldn't create the team.");
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}

/** New channel in one of my teams. Closes with the created Channel. */
@Component({
  selector: 'app-create-channel-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-header">
      <div>
        <h2 class="modal-title h5" id="create-channel-title">Create a channel</h2>
        <p class="modal-subtitle">Channels keep a team's conversations organized by topic.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="modal.dismiss()"></button>
    </div>
    <form (ngSubmit)="submit()" novalidate>
      <div class="modal-body d-grid gap-3">
        <div *ngIf="teams.length > 1 || !teamId">
          <label class="form-label" for="cc-team">Team</label>
          <select id="cc-team" class="form-select" name="team" [(ngModel)]="teamId" (ngModelChange)="teamChanged()">
            <option value="" disabled>Choose a team</option>
            <option *ngFor="let t of teams" [value]="t.teamId">{{ t.name }}</option>
          </select>
        </div>
        <div>
          <label class="form-label" for="cc-name">Channel name</label>
          <input id="cc-name" class="form-control" name="name" [(ngModel)]="name" maxlength="60" required ngbAutofocus placeholder="e.g. design-reviews" />
        </div>
        <div>
          <span class="form-label d-block" id="cc-type">Privacy</span>
          <div class="segmented" role="radiogroup" aria-labelledby="cc-type">
            <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="type === 'standard'" [attr.aria-checked]="type === 'standard'" (click)="setType('standard')"><i class="ti ti-hash" aria-hidden="true"></i>Standard</button>
            <button type="button" role="radio" class="segmented__opt" [class.segmented__opt--on]="type === 'private'" [attr.aria-checked]="type === 'private'" (click)="setType('private')"><i class="ti ti-lock" aria-hidden="true"></i>Private</button>
          </div>
          <p class="form-text mb-0">{{ type === 'standard' ? 'Everyone on the team can see and join it.' : 'Only the people you choose (you\\'re included).' }}</p>
        </div>
        <div *ngIf="type === 'private'">
          <span class="form-label d-block">Members</span>
          <div class="text-muted small" *ngIf="loadingMembers" role="status"><span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading team members…</div>
          <app-person-picker *ngIf="!loadingMembers" [people]="people" [selected]="members" (toggled)="toggle($event)"
                             placeholder="Search team members" empty="Add people to the team first." [maxHeight]="220"></app-person-picker>
        </div>
        <div class="form-error" *ngIf="error" role="alert"><i class="ti ti-alert-triangle" aria-hidden="true"></i>{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-light" (click)="modal.dismiss()">Cancel</button>
        <button type="submit" class="btn btn-primary" [disabled]="busy || !teamId || !name.trim()">{{ busy ? 'Creating…' : 'Create channel' }}</button>
      </div>
    </form>
  `,
})
export class CreateChannelDialogComponent implements OnInit {
  /** Teams I can create channels in */
  @Input() teams: Team[] = [];
  @Input() teamId = '';
  name = '';
  type: 'standard' | 'private' = 'standard';
  members = new Set<string>();
  people: PickPerson[] = [];
  loadingMembers = false;
  busy = false;
  error = '';
  private loadedFor = '';

  constructor(public modal: NgbActiveModal, private orgs: OrganizationService, private auth: AuthService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    if (!this.teamId && this.teams.length === 1) this.teamId = this.teams[0].teamId;
  }

  setType(type: 'standard' | 'private'): void {
    this.type = type;
    if (type === 'private') void this.loadMembers();
  }

  teamChanged(): void {
    this.members = new Set();
    if (this.type === 'private') void this.loadMembers();
  }

  toggle(id: string): void {
    const next = new Set(this.members);
    next.has(id) ? next.delete(id) : next.add(id);
    this.members = next;
  }

  private async loadMembers(): Promise<void> {
    if (!this.teamId || this.loadedFor === this.teamId) return;
    const teamId = this.teamId;
    this.loadingMembers = true;
    this.cdr.markForCheck();
    try {
      const me = String(this.auth.getLoggedInUser()?._id || '');
      const rows = await this.orgs.teamMembers(teamId);
      if (teamId !== this.teamId) return;
      this.people = rows.filter((m) => m.userId !== me).map((m) => ({ id: m.userId, name: m.username, avatar: m.avatar, badge: ROLE_LABEL[m.role] || m.role, badgeTone: 'role' as const }));
      this.loadedFor = teamId;
    } catch (e) {
      this.error = errorText(e, "We couldn't load the team's members.");
    } finally {
      this.loadingMembers = false;
      this.cdr.markForCheck();
    }
  }

  async submit(): Promise<void> {
    if (this.busy || !this.teamId || !this.name.trim()) return;
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const channel: Channel = await this.orgs.createChannel(this.teamId, {
        name: this.name.trim(),
        type: this.type,
        memberIds: this.type === 'private' ? [...this.members] : undefined,
      });
      this.modal.close(channel);
    } catch (e) {
      this.error = errorText(e, "We couldn't create the channel.");
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
