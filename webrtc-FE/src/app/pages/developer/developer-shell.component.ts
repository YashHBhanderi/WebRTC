import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, ViewChild } from '@angular/core';
import { AuthService } from 'src/app/core/services/auth.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { ThemeService } from 'src/app/core/services/theme.service';
import { setPortal } from 'src/app/core/services/portal';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { WorkspaceListComponent } from '../shell/workspace-list.component';

interface DevNavItem {
  path: string;
  label: string;
  icon: string;
  exact: boolean;
}

/**
 * Frame of the Developer Portal (/developer/**). Deliberately separate from the personal app's shell:
 * no chat, calls, presence, notifications, end-to-end encryption or realtime socket — only the
 * developer modules (applications with their credentials, permissions, webhooks, usage and audit;
 * API documentation).
 *
 * The workspace list stays: applications are registered either for the personal account or bound to
 * an organization, so the active workspace matters here too.
 */
@Component({
  selector: 'app-developer-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="visually-hidden-focusable" href="#dev-main">Skip to content</a>
    <div class="dev-shell">
      <header class="dev-top">
        <a class="dev-brand" routerLink="/developer" aria-label="SpreeWe Developers home">
          <img src="assets/icon.svg" alt="" width="22" height="26" />
          <span class="dev-brand__name">SpreeWe</span>
          <span class="dev-brand__tag">Developers</span>
        </a>

        <nav class="dev-nav" aria-label="Developer portal">
          <a *ngFor="let item of nav" class="dev-nav__item" [routerLink]="item.path"
             routerLinkActive="dev-nav__item--active" [routerLinkActiveOptions]="{ exact: item.exact }"
             #rla="routerLinkActive" [attr.aria-current]="rla.isActive ? 'page' : null">
            <i class="ti {{ item.icon }}" aria-hidden="true"></i><span>{{ item.label }}</span>
          </a>
        </nav>

        <span class="dev-top__spacer"></span>

        <span class="dev-context" [title]="'Applications are listed for ' + contextLabel">
          <i class="ti" [ngClass]="inOrganization ? 'ti-building' : 'ti-user'" aria-hidden="true"></i>
          <span class="d-none d-sm-inline">{{ contextLabel }}</span>
        </span>

        <button type="button" class="dev-icon" (click)="theme.toggle()" aria-label="Toggle dark mode" title="Toggle dark mode">
          <i class="ti" [ngClass]="theme.resolved === 'dark' ? 'ti-sun' : 'ti-moon'" aria-hidden="true"></i>
        </button>

        <div ngbDropdown #menu="ngbDropdown" placement="bottom-end" autoClose="outside" class="d-inline-block"
             (openChange)="$event && workspaces?.refresh()">
          <button type="button" class="dev-me" ngbDropdownToggle aria-label="Account menu" [title]="me?.username || ''">
            <app-avatar [src]="me?.avatar" [name]="me?.username || ''" [size]="28"></app-avatar>
          </button>
          <div ngbDropdownMenu class="app-menu me-menu">
            <div class="me-menu__head">
              <app-avatar [src]="me?.avatar" [name]="me?.username || ''" [size]="40"></app-avatar>
              <div class="me-menu__who">
                <div class="me-menu__name">{{ me?.username }}</div>
                <div class="me-menu__status">Developer Portal</div>
              </div>
            </div>
            <div class="dropdown-divider"></div>
            <div class="me-menu__heading"><span>Workspace</span></div>
            <app-workspace-list #workspaces></app-workspace-list>
            <div class="dropdown-divider"></div>
            <button ngbDropdownItem type="button" (click)="menu.close(); openPersonalApp()">
              <i class="ti ti-message-circle" aria-hidden="true"></i>Open SpreeWe app
            </button>
            <div class="dropdown-divider"></div>
            <button ngbDropdownItem type="button" class="text-danger" (click)="menu.close(); signOut()">
              <i class="ti ti-logout" aria-hidden="true"></i>Sign out
            </button>
          </div>
        </div>
      </header>

      <main class="dev-main" id="dev-main" tabindex="-1">
        <router-outlet></router-outlet>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--app-bg); color: var(--app-text); }
    .dev-shell { display: flex; flex-direction: column; min-height: 100vh; }
    .dev-top {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; gap: 12px;
      height: 56px; padding: 0 16px;
      background: var(--app-surface); border-bottom: 1px solid var(--app-border);
    }
    .dev-brand { display: inline-flex; align-items: center; gap: 8px; color: var(--app-text); text-decoration: none; flex-shrink: 0; }
    .dev-brand__name { font-weight: 700; letter-spacing: -.01em; }
    .dev-brand__tag {
      font-size: .72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px;
      background: var(--app-brand-soft); color: var(--app-text);
    }
    .dev-nav { display: flex; gap: 2px; margin-left: 12px; overflow-x: auto; }
    .dev-nav__item {
      display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
      padding: 6px 10px; border-radius: 8px; color: var(--app-muted); text-decoration: none; font-size: .88rem;
    }
    .dev-nav__item:hover { background: var(--app-hover); color: var(--app-text); }
    .dev-nav__item--active { color: var(--app-text); background: var(--app-brand-soft); font-weight: 600; }
    .dev-top__spacer { flex: 1; }
    .dev-context {
      display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
      font-size: .8rem; color: var(--app-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dev-icon, .dev-me {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border: 0; border-radius: 999px; background: transparent; color: var(--app-text);
    }
    .dev-icon:hover, .dev-me:hover { background: var(--app-hover); }
    .dev-me::after { display: none; }
    .me-menu { width: 300px; max-width: calc(100vw - 24px); }
    .me-menu__head { display: flex; align-items: center; gap: 12px; padding: 8px 12px 10px; }
    .me-menu__who { min-width: 0; }
    .me-menu__name { font-weight: 600; color: var(--app-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .me-menu__status { font-size: .8rem; color: var(--app-muted); }
    .me-menu__heading { padding: 6px 12px 4px; font-size: .7rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--app-muted); }
    .me-menu .dropdown-item { display: flex; align-items: center; gap: 10px; }
    .dev-main { flex: 1; width: 100%; max-width: 1200px; margin: 0 auto; padding: 8px 0 32px; }
    .dev-main:focus { outline: none; }
    @media (max-width: 640px) {
      .dev-top { gap: 6px; padding: 0 10px; }
      .dev-brand__name { display: none; }
      .dev-nav { margin-left: 4px; }
      .dev-nav__item span { display: none; }
    }
  `],
})
export class DeveloperShellComponent implements OnInit {
  readonly nav: DevNavItem[] = [
    { path: '/developer', label: 'Applications', icon: 'ti-apps', exact: true },
    { path: '/developer/docs', label: 'API documentation', icon: 'ti-book', exact: false },
  ];
  @ViewChild('workspaces') workspaces?: WorkspaceListComponent;
  me: { _id: string; username: string; avatar?: string } | null = null;

  constructor(
    public theme: ThemeService,
    private auth: AuthService,
    private clerk: ClerkService,
    private alert: AlertService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.me = this.auth.getLoggedInUser();
    if (this.auth.workspaceFallback) {
      this.auth.workspaceFallback = false;
      this.alert.info("You no longer have access to that organization, so you're in your personal workspace.");
    }
    this.cdr.markForCheck();
  }

  get inOrganization(): boolean {
    return !!this.clerk.activeOrganizationId;
  }

  get contextLabel(): string {
    return this.inOrganization ? 'Organization workspace' : 'Personal account';
  }

  /** Switch this browser to the personal app. Full reload so no developer-portal state carries over. */
  openPersonalApp(): void {
    setPortal('personal');
    window.location.assign('/chat');
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    this.alert.success('Signed out.');
  }
}
