import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit, TemplateRef, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from 'src/app/core/services/auth.service';
import { CallManagerService } from 'src/app/core/services/call-manager.service';
import { NotificationCenterService } from 'src/app/core/services/notification-center.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { ThemeService } from 'src/app/core/services/theme.service';
import { PresenceService } from 'src/app/core/services/presence.service';
import { ShellUiService } from 'src/app/core/services/shell-ui.service';
import { ChosenStatus, PresenceKey, STATUS_OPTIONS } from 'src/app/core/utils/presence.util';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ClerkService, SignedInAccount } from 'src/app/core/services/clerk.service';
import { OrganizationService } from 'src/app/core/services/organization.service';
import { NgbDropdown } from '@ng-bootstrap/ng-bootstrap';
import { WorkspaceSyncService, takeNotice } from 'src/app/core/services/workspace-sync.service';
import { E2eeService } from 'src/app/core/crypto/e2ee.service';
import { WorkspaceListComponent } from './workspace-list.component';

export interface NavItem {
  path: string;
  label: string;
  icon: string;
  shortcut: string;
}

const COLLAPSE_KEY = 'app.navCollapsed';

/**
 * Persistent application frame: navigation rail (bottom tab bar on phones), top bar and the call
 * surface. Pages render in the <router-outlet>; the call lives here so it survives navigation.
 */
@Component({
  selector: 'app-shell',
  templateUrl: './shell.component.html',
  styleUrls: ['./shell.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent implements OnInit, OnDestroy {
  readonly primaryNav: NavItem[] = [
    { path: '/activity', label: 'Activity', icon: 'ti-bell', shortcut: '1' },
    { path: '/chat', label: 'Chat', icon: 'ti-message-circle', shortcut: '2' },
    { path: '/calls', label: 'Calls', icon: 'ti-phone', shortcut: '3' },
    { path: '/calendar', label: 'Calendar', icon: 'ti-calendar', shortcut: '4' },
    { path: '/files', label: 'Files', icon: 'ti-folder', shortcut: '5' },
  ];
  /**
   * Not in the sidebar but still reachable with Alt+6 / Alt+7 / Alt+8: Profile and Settings (account menu /
   * Settings button) and, in an organization, the Teams page (teams and channels are in the chat list).
   */
  readonly secondaryNav: NavItem[] = [
    { path: '/profile', label: 'Profile', icon: 'ti-user', shortcut: '6' },
    { path: '/settings', label: 'Settings', icon: 'ti-settings', shortcut: '7' },
    // Organization workspaces only (switching workspace reloads the app, so this is decided once)
    ...(this.clerk.activeOrganizationId ? [{ path: '/organization', label: 'Teams', icon: 'ti-users-group', shortcut: '8' }] : []),
  ];

  readonly statusOptions = STATUS_OPTIONS;
  readonly statusPresets = ['In a meeting', 'Commuting', 'Focusing', 'Out sick', 'On vacation', 'Working remotely'];
  /** Account menu: statuses are listed only after "Set status" is clicked */
  statusExpanded = false;
  /** Account menu: organization actions (create / join / settings) shown after "Manage" */
  manageExpanded = false;
  /** Pending organization invitations for me (badge on "Join organization") */
  invitationCount = 0;
  /** Other accounts signed in on this browser (Clerk multi-session) */
  otherAccounts: SignedInAccount[] = [];
  /** Session being switched to */
  switchingAccount: string | null = null;
  @ViewChild('statusMessageTpl', { static: true }) statusMessageTpl!: TemplateRef<unknown>;
  @ViewChild('workspaces') workspaces?: WorkspaceListComponent;
  statusDraft = '';
  savingStatus = false;
  private statusModal: NgbModalRef | null = null;

  collapsed = this.readCollapsed();
  me: { _id: string; username: string; avatar?: string; status?: string } | null = null;

  private subs = new Subscription();

  constructor(
    public calls: CallManagerService,
    public notifications: NotificationCenterService,
    public theme: ThemeService,
    public presence: PresenceService,
    public shellUi: ShellUiService,
    private modal: NgbModal,
    private auth: AuthService,
    private socket: SocketService,
    private alert: AlertService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private clerk: ClerkService,
    private sync: WorkspaceSyncService,
    private e2ee: E2eeService,
    private orgs: OrganizationService,
  ) {}

  ngOnInit(): void {
    this.me = this.auth.getLoggedInUser();
    if (this.auth.workspaceFallback) {
      this.auth.workspaceFallback = false;
      this.alert.info("You no longer have access to that organization, so you're in your personal workspace.");
    }
    // Left a workspace with a full reload (removed, deleted, switched in another tab): say why, once
    const notice = takeNotice();
    if (notice) this.alert.info(notice);
    this.sync.start();
    // End-to-end encryption: this browser's device keys, then device messages (room keys) as they arrive
    if (this.me?._id) {
      this.e2ee.start(String(this.me._id)).catch(() => {
        this.alert.error(this.e2ee.statusMessage || "Encryption couldn't start on this device, so messages can't be sent or read here.");
      });
    }
    for (const event of ['e2ee:to-device', 'e2ee:devices-changed']) {
      this.subs.add(this.socket.onEvent(event).subscribe(() => void this.e2ee.sync()));
    }
    this.subs.add(this.socket.onConnect().subscribe(() => void this.e2ee.sync()));
    this.calls.start();
    this.notifications.start();
    this.presence.start();
    this.subs.add(this.presence.mine$.subscribe(() => this.cdr.markForCheck()));
    this.subs.add(this.shellUi.immersive$.subscribe(() => this.cdr.markForCheck()));
    this.subs.add(this.notifications.unread$.subscribe(() => this.cdr.markForCheck()));
    this.subs.add(this.notifications.unreadChats$.subscribe(() => this.cdr.markForCheck()));
    this.subs.add(this.calls.changed$.subscribe(() => this.cdr.markForCheck()));
    this.subs.add(this.theme.mode$.subscribe(() => this.cdr.markForCheck()));
    this.subs.add(this.socket.onUserUpdated().subscribe((u) => {
      if (this.me && String(u?._id) === String(this.me._id)) {
        this.me = { ...this.me, username: u.username, avatar: u.avatar, status: u.status ?? this.me.status };
        this.cdr.markForCheck();
      }
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, this.collapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }

  async signOut(): Promise<void> {
    this.calls.stop();
    this.notifications.stop();
    this.presence.stop();
    this.e2ee.stop();
    this.socket.disconnectSocket();
    await this.auth.logout();
    this.alert.success('Signed out.');
  }

  /** My dot: what others see (Away when idle is decided by the server, so show the chosen status). */
  get myPresenceKey(): PresenceKey {
    return STATUS_OPTIONS.find((o) => o.value === this.presence.mine.status)?.key || 'available';
  }

  get myStatusLabel(): string {
    return STATUS_OPTIONS.find((o) => o.value === this.presence.mine.status)?.label || 'Available';
  }

  onAccountMenu(open: boolean): void {
    if (open) {
      this.workspaces?.refresh();
      this.otherAccounts = this.clerk.accounts().filter((a) => !a.current);
      void this.orgs.myInvitations().then((list) => {
        this.invitationCount = list.length;
        this.cdr.markForCheck();
      }, () => undefined);
    } else {
      this.statusExpanded = false;
      this.manageExpanded = false;
    }
  }

  trackAccount = (_: number, a: SignedInAccount) => a.sessionId;

  /** Another account signed in on this browser: the app restarts as that account. */
  async switchAccount(account: SignedInAccount): Promise<void> {
    if (this.switchingAccount) return;
    this.switchingAccount = account.sessionId;
    this.cdr.markForCheck();
    try {
      await this.clerk.switchAccount(account.sessionId);
      this.sync.restartForAccount(`You're now using ${account.name}.`);
    } catch {
      this.switchingAccount = null;
      this.alert.error("We couldn't switch to that account. Please sign in to it again.");
      this.cdr.markForCheck();
    }
  }

  /** Sign in to one more account (Clerk's screen). When it completes the app restarts as that account. */
  addAccount(menu: NgbDropdown): void {
    menu.close();
    if (!this.clerk.multiAccountEnabled) {
      this.alert.info("Signing in to more than one account isn't enabled for SpreeWe yet. Ask your administrator to turn it on.");
      return;
    }
    this.clerk.addAccount();
  }

  async chooseStatus(status: ChosenStatus): Promise<void> {
    try {
      await this.presence.setStatus(status);
    } catch (error: any) {
      this.alert.error(error?.message || "We couldn't update your status. Please try again.");
    }
  }

  openStatusMessage(): void {
    this.statusDraft = this.presence.mine.statusMessage;
    this.statusModal = this.modal.open(this.statusMessageTpl, { centered: true, windowClass: 'app-modal' });
  }

  async saveStatusMessage(clear = false): Promise<void> {
    this.savingStatus = true;
    try {
      await this.presence.setStatusMessage(clear ? '' : this.statusDraft);
      this.statusModal?.close();
    } catch (error: any) {
      this.alert.error(error?.message || "We couldn't update your status. Please try again.");
    } finally {
      this.savingStatus = false;
      this.cdr.markForCheck();
    }
  }

  /** Alt+1…7 jumps between sections (Teams uses Ctrl+1…; browsers own Ctrl+digit for tabs). */
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const item = [...this.primaryNav, ...this.secondaryNav].find((n) => n.shortcut === event.key);
    if (item) {
      event.preventDefault();
      void this.router.navigateByUrl(item.path);
    }
  }

  trackByPath(_: number, item: NavItem): string {
    return item.path;
  }

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  }
}
