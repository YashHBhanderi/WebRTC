import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CallNotificationService } from 'src/app/core/services/call-notification.service';
import { ThemeMode, ThemeService } from 'src/app/core/services/theme.service';
import { NotificationCenterService, NotificationPrefs } from 'src/app/core/services/notification-center.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ChatUiService } from 'src/app/core/services/chat-ui.service';

/** Sections whose feature arrives in a later phase: a proper empty state, not a blank page. */
@Component({
  selector: 'app-section-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__header"><h1 class="page__title">{{ data['title'] }}</h1></header>
      <div class="empty">
        <i class="ti {{ data['icon'] }} empty__icon" aria-hidden="true"></i>
        <h2 class="empty__title">{{ data['emptyTitle'] }}</h2>
        <p class="empty__text">{{ data['emptyText'] }}</p>
      </div>
    </section>
  `,
  styleUrls: ['./section-pages.scss'],
})
export class SectionPlaceholderComponent {
  readonly data = this.route.snapshot.data;

  constructor(private route: ActivatedRoute) {}
}

@Component({
  selector: 'app-profile-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page page--narrow">
      <app-sidebar-profile (back)="router.navigate(['/chat'])"></app-sidebar-profile>
    </section>
  `,
  styleUrls: ['./section-pages.scss'],
})
export class ProfilePageComponent {
  constructor(public router: Router) {}
}

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page page--narrow">
      <header class="page__header"><h1 class="page__title">Settings</h1></header>

      <div class="card-section">
        <h2 class="card-section__title" id="appearance-title">Appearance</h2>
        <div class="segmented" role="radiogroup" aria-labelledby="appearance-title">
          <button *ngFor="let opt of themeOptions" type="button" role="radio" class="segmented__opt"
                  [class.segmented__opt--on]="theme.mode === opt.value" [attr.aria-checked]="theme.mode === opt.value"
                  (click)="setTheme(opt.value)">
            <i class="ti {{ opt.icon }}" aria-hidden="true"></i>{{ opt.label }}
          </button>
        </div>
      </div>

      <div class="card-section">
        <h2 class="card-section__title">Chat</h2>
        <label class="pref mt-0">
          <input type="checkbox" class="form-check-input" [checked]="chatUi.showLastMessage"
                 (change)="chatUi.setShowLastMessage(!chatUi.showLastMessage)" />
          <span>
            <span class="setting-row__label">Show last message</span>
            <span class="setting-row__hint d-block">When off, the chat list shows only the name and a smaller profile photo.</span>
          </span>
        </label>
      </div>

      <div class="card-section">
        <h2 class="card-section__title">Notifications</h2>
        <div class="setting-row">
          <div>
            <div class="setting-row__label">Browser notifications</div>
            <div class="setting-row__hint">{{ notificationHint }}</div>
          </div>
          <button type="button" class="btn btn-primary btn-sm" *ngIf="notifications.permission === 'default'" (click)="enableNotifications()">Turn on</button>
          <span class="badge-state" *ngIf="notifications.permission === 'granted'">On</span>
        </div>

        <div class="pref-list" role="group" aria-label="Notify me about">
          <label class="pref" *ngFor="let p of prefOptions">
            <input type="checkbox" class="form-check-input" [checked]="center.prefs[p.key]" (change)="togglePref(p.key)" />
            <span>
              <span class="setting-row__label">{{ p.label }}</span>
              <span class="setting-row__hint d-block">{{ p.hint }}</span>
            </span>
          </label>
        </div>
        <p class="setting-row__hint mt-2 mb-0">
          Alerts are skipped for the chat you're looking at and while you're Do not disturb. These settings apply to this browser.
          Ringtone options are in your Profile.
        </p>
      </div>

      <div class="card-section">
        <h2 class="card-section__title">Keyboard shortcuts</h2>
        <dl class="shortcuts">
          <div><dt><kbd>Alt</kbd> + <kbd>1</kbd>…<kbd>7</kbd></dt><dd>Go to Activity, Chat, Calls, Calendar, Files, Profile, Settings</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Close the open panel, preview or dialog</dd></div>
        </dl>
      </div>
    </section>
  `,
  styleUrls: ['./section-pages.scss'],
})
export class SettingsPageComponent implements OnDestroy {
  readonly themeOptions: { value: ThemeMode; label: string; icon: string }[] = [
    { value: 'light', label: 'Light', icon: 'ti-sun' },
    { value: 'dark', label: 'Dark', icon: 'ti-moon' },
    { value: 'system', label: 'System', icon: 'ti-device-desktop' },
  ];
  readonly prefOptions: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
    { key: 'desktop', label: 'Show browser notifications', hint: 'When this tab is in the background' },
    { key: 'sound', label: 'Play a sound', hint: 'Muted during calls' },
    { key: 'messages', label: 'New messages', hint: 'Chats you are not looking at' },
    { key: 'mentions', label: 'Mentions', hint: 'Someone @mentions you' },
    { key: 'replies', label: 'Replies', hint: 'Someone replies to your message' },
    { key: 'reactions', label: 'Reactions', hint: 'Someone reacts to your message' },
    { key: 'missedCalls', label: 'Missed calls', hint: "Calls you didn't answer" },
    { key: 'meetings', label: 'Meeting invitations', hint: 'You are invited to a meeting' },
  ];
  private sub = new Subscription();

  constructor(
    public theme: ThemeService,
    public notifications: CallNotificationService,
    public center: NotificationCenterService,
    public chatUi: ChatUiService,
    private alert: AlertService,
    private cdr: ChangeDetectorRef,
  ) {
    this.sub.add(this.theme.mode$.subscribe(() => this.cdr.markForCheck()));
    this.sub.add(this.center.prefs$.subscribe(() => this.cdr.markForCheck()));
    this.sub.add(this.chatUi.showLastMessage$.subscribe(() => this.cdr.markForCheck()));
  }

  togglePref(key: keyof NotificationPrefs): void {
    this.center.setPrefs({ [key]: !this.center.prefs[key] });
  }

  get notificationHint(): string {
    switch (this.notifications.permission) {
      case 'granted': return 'You will be notified about calls when this tab is in the background.';
      case 'denied': return 'Blocked for this site. Allow notifications in your browser site settings.';
      case 'unsupported': return "This browser doesn't support notifications.";
      default: return 'Get notified about calls when this tab is in the background.';
    }
  }

  setTheme(mode: ThemeMode): void {
    this.theme.set(mode);
  }

  async enableNotifications(): Promise<void> {
    const result = await this.notifications.requestPermission();
    if (result === 'denied') {
      this.alert.info('Notifications are blocked for this site. You can allow them in your browser site settings.');
    }
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
