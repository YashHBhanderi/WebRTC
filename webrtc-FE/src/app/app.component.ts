import { Component, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ClerkService } from './core/services/clerk.service';
import { clearStoredSession } from './core/services/auth.service';
import { SocketService } from './core/services/socket.service';
import { CallManagerService } from './core/services/call-manager.service';
import { ThemeService } from './core/services/theme.service';
import { NotificationCenterService } from './core/services/notification-center.service';
import { PresenceService } from './core/services/presence.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnDestroy {
  title = 'My Chat App';
  private sub: Subscription;

  // ThemeService is injected so the saved theme applies on every page, including sign-in
  constructor(clerk: ClerkService, router: Router, socket: SocketService, calls: CallManagerService, notifications: NotificationCenterService, presence: PresenceService, _theme: ThemeService) {
    // Signed out in another tab, or the session was revoked in Clerk: leave the app here too
    this.sub = clerk.signedOut$.subscribe(() => {
      clearStoredSession();
      calls.stop();
      notifications.stop();
      presence.stop();
      socket.disconnectSocket();
      if (!router.url.startsWith('/auth')) {
        router.navigate(['/auth/login']);
      }
    });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
