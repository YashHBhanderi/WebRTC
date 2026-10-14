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
    { path: '/activity', label: 'Activity', icon: 'fa-bell', shortcut: '1' },
    { path: '/chat', label: 'Chat', icon: 'fa-comment-dots', shortcut: '2' },
    { path: '/calls', label: 'Calls', icon: 'fa-phone', shortcut: '3' },
    { path: '/calendar', label: 'Calendar', icon: 'fa-calendar-days', shortcut: '4' },
    { path: '/files', label: 'Files', icon: 'fa-folder', shortcut: '5' },
  ];
  /** Not in the sidebar (account menu / Settings button) but still reachable with Alt+6 / Alt+7. */
  readonly secondaryNav: NavItem[] = [
    { path: '/profile', label: 'Profile', icon: 'fa-user', shortcut: '6' },
    { path: '/settings', label: 'Settings', icon: 'fa-gear', shortcut: '7' },
  ];

  readonly statusOptions = STATUS_OPTIONS;
  @ViewChild('statusMessageTpl', { static: true }) statusMessageTpl!: TemplateRef<unknown>;
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
  ) {}

  ngOnInit(): void {
    this.me = this.auth.getLoggedInUser();
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
