import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AppComponent } from './app.component';
import { ClerkService } from './core/services/clerk.service';
import { SocketService } from './core/services/socket.service';
import { CallManagerService } from './core/services/call-manager.service';
import { NotificationCenterService } from './core/services/notification-center.service';
import { PresenceService } from './core/services/presence.service';
import { ThemeService } from './core/services/theme.service';

/** Signed out in another tab / session revoked in Clerk: every live piece of state is torn down here too. */
describe('AppComponent', () => {
  it('on sign-out elsewhere: stops calls, notifications, presence, disconnects the socket, clears the session and shows sign-in', () => {
    const signedOut$ = new Subject<void>();
    const calls = jasmine.createSpyObj('CallManagerService', ['stop']);
    const notifications = jasmine.createSpyObj('NotificationCenterService', ['stop']);
    const presence = jasmine.createSpyObj('PresenceService', ['stop']);
    const socket = jasmine.createSpyObj('SocketService', ['disconnectSocket']);
    const router = { url: '/chat', navigate: jasmine.createSpy('navigate') };
    TestBed.configureTestingModule({
      declarations: [AppComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: ClerkService, useValue: { signedOut$ } },
        { provide: Router, useValue: router },
        { provide: SocketService, useValue: socket },
        { provide: CallManagerService, useValue: calls },
        { provide: NotificationCenterService, useValue: notifications },
        { provide: PresenceService, useValue: presence },
        { provide: ThemeService, useValue: {} },
      ],
    });
    localStorage.setItem('user', JSON.stringify({ _id: 'u1' }));
    TestBed.createComponent(AppComponent);
    signedOut$.next();
    expect(calls.stop).toHaveBeenCalled();
    expect(notifications.stop).toHaveBeenCalled();
    expect(presence.stop).toHaveBeenCalled();
    expect(socket.disconnectSocket).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/auth/login']);
    expect(localStorage.getItem('user')).toBeNull();
  });
});
