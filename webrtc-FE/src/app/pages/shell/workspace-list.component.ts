import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { OrganizationService, OrgRole, errorText } from 'src/app/core/services/organization.service';
import { ViewRefresher, WorkspaceSyncService } from 'src/app/core/services/workspace-sync.service';
import { switchWorkspace } from './workspace-switch';
import { ROLE_LABEL } from '../organizations/org-navigation';

export interface WorkspaceEntry {
  /** Clerk organization id (what Clerk switches to) */
  id: string;
  /** SpreeWe organization id, when SpreeWe knows the workspace */
  organizationId: string | null;
  name: string;
  role: string;
  /** Members managed in Clerk (legacy workspaces) */
  clerkManaged: boolean;
}

/**
 * Account & organization section of the profile menu: Personal and every organization I belong to,
 * the active one marked, one click to switch.
 *
 * The list comes from SpreeWe (GET /v1/organizations/mine: names and roles as SpreeWe has them),
 * plus Clerk memberships SpreeWe has not seen yet (Clerk-managed workspaces never opened here). It
 * refreshes when my memberships change (server events), without a reload.
 *
 * Switching is deliberately a full reload: Clerk's active organization changes, the server is asked
 * to confirm the new context (membership / tenant status re-checked), and the whole app restarts.
 * That is the one way to guarantee no conversation, contact, presence or call state from the previous
 * workspace stays in memory, and that Socket.IO reconnects with a token for the new workspace.
 */
@Component({
  selector: 'app-workspace-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .ws-item { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent; color: var(--app-text); text-align: left; border-radius: var(--app-radius-sm, 8px); padding: 7px 12px; font-size: .9rem; }
    .ws-item:hover:not(:disabled), .ws-item:focus-visible { background: var(--app-hover); }
    .ws-item:disabled { opacity: .7; }
    .ws-item__text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
    .ws-item__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ws-item__meta { font-size: .74rem; color: var(--app-muted); }
    .ws-item__avatar { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none; font-size: .78rem; font-weight: 700; background: var(--app-surface-2, var(--app-hover)); color: var(--app-text); }
    .ws-item[aria-current="true"] .ws-item__avatar { background: var(--app-accent); color: #10202e; }
    .ws-item[aria-current="true"] .ws-item__name { font-weight: 600; }
    .ws-item__check { margin-left: auto; color: var(--app-accent-strong, var(--app-accent)); }
    .ws-status { padding: 6px 12px; font-size: .8rem; color: var(--app-muted); display: flex; align-items: center; gap: 8px; }
    .ws-status--error { color: var(--app-danger); }
  `],
  template: `
    <div role="group" aria-label="Switch account or organization">
      <button type="button" class="ws-item" (click)="switchTo(null)" [attr.aria-current]="!activeId" [disabled]="switching">
        <span class="ws-item__avatar" aria-hidden="true"><i class="ti ti-user"></i></span>
        <span class="ws-item__text"><span class="ws-item__name">Personal</span><span class="ws-item__meta">Your own chats and calls</span></span>
        <i class="ti ti-check ws-item__check" *ngIf="!activeId" aria-label="Active"></i>
      </button>
      <button type="button" class="ws-item" *ngFor="let o of orgs; trackBy: trackById" (click)="switchTo(o.id)" [attr.aria-current]="o.id === activeId" [disabled]="switching">
        <span class="ws-item__avatar" aria-hidden="true">{{ initial(o.name) }}</span>
        <span class="ws-item__text"><span class="ws-item__name">{{ o.name }}</span>
          <span class="ws-item__meta">{{ roleLabel(o.role) }}{{ o.clerkManaged ? ' · managed in Clerk' : '' }}</span></span>
        <i class="ti ti-check ws-item__check" *ngIf="o.id === activeId" aria-label="Active"></i>
      </button>
      <div class="ws-status" *ngIf="switching" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Switching…</div>
      <div class="ws-status" *ngIf="loading && !orgs.length" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Loading organizations…</div>
      <div class="ws-status ws-status--error" *ngIf="listError" role="alert">{{ listError }}</div>
    </div>
  `,
})
export class WorkspaceListComponent implements OnInit, OnDestroy {
  orgs: WorkspaceEntry[] = [];
  activeId: string | null = null;
  switching = false;
  loading = false;
  listError = '';
  private subs = new Subscription();
  private refresher = new ViewRefresher(() => this.loadList());

  constructor(
    private clerk: ClerkService,
    private orgsApi: OrganizationService,
    private sync: WorkspaceSyncService,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.activeId = this.clerk.pinnedOrganization;
    this.subs.add(this.sync.changes$.subscribe((t) => { if (t === 'mine' || t === '*') this.refresher.notify(t); }));
    void this.refresher.mutate(async () => undefined, ['mine']);
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.refresher.destroy();
  }

  /** Called when the menu opens: memberships may have changed meanwhile */
  refresh(): void {
    this.refresher.notify('mine');
  }

  initial(name: string): string {
    return (name.trim()[0] || '?').toUpperCase();
  }

  roleLabel(role: string): string {
    const r = role.replace(/^org:/, '');
    return ROLE_LABEL[r] || r;
  }

  trackById = (_: number, o: WorkspaceEntry) => o.id;

  private async loadList(): Promise<void> {
    this.loading = true;
    this.cdr.markForCheck();
    try {
      const [mine, clerkOrgs] = await Promise.all([this.orgsApi.mine(), this.clerk.organizations()]);
      const entries: WorkspaceEntry[] = mine
        .filter((o) => o.status === 'active')
        .map((o) => ({ id: o.clerkOrgId, organizationId: o.organizationId, name: o.name, role: o.role as OrgRole, clerkManaged: o.managedBy !== 'spreewe' }));
      const known = new Set(entries.map((e) => e.id));
      // Clerk memberships SpreeWe doesn't list: Clerk-managed workspaces not opened here yet. A stale
      // Clerk-only membership of a SpreeWe-managed organization also lands here; choosing it is refused
      // by the server and the tab stays where it was (known limitation: the client can't tell them apart)
      for (const c of clerkOrgs) {
        if (!known.has(c.id) && !mine.some((m) => m.clerkOrgId === c.id)) entries.push({ id: c.id, organizationId: null, name: c.name, role: c.role, clerkManaged: true });
      }
      this.orgs = entries.sort((a, b) => a.name.localeCompare(b.name));
      this.sync.activeOrganizationId = mine.find((o) => o.clerkOrgId === this.activeId)?.organizationId ?? null;
      this.listError = '';
    } catch (e) {
      this.listError = errorText(e, "We couldn't load your organizations.");
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  async switchTo(orgId: string | null): Promise<void> {
    if (orgId === this.activeId || this.switching) return;
    const previous = this.activeId;
    this.switching = true;
    this.listError = '';
    this.cdr.markForCheck();
    try {
      await switchWorkspace(this.clerk, this.http, orgId, previous);
    } catch (error) {
      this.listError = errorText(error, "You can't switch to that workspace right now.");
      this.switching = false;
      this.refresher.notify('mine');
      this.cdr.markForCheck();
    }
  }
}
