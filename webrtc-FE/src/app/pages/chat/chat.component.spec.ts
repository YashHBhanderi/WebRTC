import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { ChatComponent } from './chat.component';
import { UserService } from 'src/app/core/services/user.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';
import { MessageSenderService } from 'src/app/core/services/message-sender.service';
import { UploadService } from 'src/app/core/services/upload.service';
import { CallNotificationService } from 'src/app/core/services/call-notification.service';
import { CallManagerService } from 'src/app/core/services/call-manager.service';
import { NotificationCenterService } from 'src/app/core/services/notification-center.service';
import { ShellUiService } from 'src/app/core/services/shell-ui.service';
import { ChatUiService } from 'src/app/core/services/chat-ui.service';
import { CHAT_CONFIG } from 'src/app/core/config/chat.config';
import { E2eeService } from 'src/app/core/crypto/e2ee.service';
import { OrganizationService } from 'src/app/core/services/organization.service';
import { WorkspaceSyncService } from 'src/app/core/services/workspace-sync.service';

/** Any method returns an empty observable, so construction works without a backend. */
const stub = () => new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : () => of(null)) });

// Construction and its form setup. The page's live behaviour needs a signed-in session and a socket;
// it is exercised by the staging browser walkthrough (docs/testing/phase-5c-test-results.md).
describe('ChatComponent', () => {
  function create(overrides: { provide: unknown; useValue: unknown }[] = []) {
    const tokens = [UserService, SocketService, AuthService, AlertService, ChatActionsService, MessageSenderService, UploadService, CallNotificationService, CallManagerService, NotificationCenterService, ShellUiService, ChatUiService, NgbModal, Router, ActivatedRoute, OrganizationService, WorkspaceSyncService];
    TestBed.configureTestingModule({
      imports: [ReactiveFormsModule],
      declarations: [ChatComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [...tokens.map((provide) => ({ provide, useValue: stub() })), { provide: CHAT_CONFIG, useValue: { historyPageSize: 30 } }, { provide: E2eeService, useValue: { keysChanged$: new Subject<void>(), status$: new BehaviorSubject('ready'), statusMessage: '' } }, ...overrides],
    });
    return TestBed.createComponent(ChatComponent).componentInstance;
  }

  it('is created with its dependencies and a valid empty group form', () => {
    const chat = create();
    expect(chat).toBeTruthy();
    expect(chat.groupForm.valid).toBeFalse(); // name and members are required
  });

  describe('chat list sections (All)', () => {
    const chats = () => [
      { _id: 'c1', receiver: { _id: 'u1', username: 'Ann' }, lastMessage: { createdAt: '2026-10-28T10:00:00Z' }, isFavorite: true },
      { _id: 'c2', receiver: { _id: 'u2', username: 'Bob' }, lastMessage: { createdAt: '2026-10-28T11:00:00Z' } },
    ];
    const teams = [{ team: { teamId: 't1', name: 'Ops', myRole: 'member' }, channels: [{ channelId: 'ch1', name: 'General', type: 'standard', isMember: true, isFavorite: false }] }];

    it('splits into Favorites, Recent chats and Teams & channels', () => {
      const chat: any = create();
      chat.chatData = chats();
      chat.myTeams = teams;
      chat.rebuildSidebar();
      expect(chat.favoriteItems.map((i: any) => i.title)).toEqual(['Ann']);
      expect(chat.recentItems.map((i: any) => i.title)).toEqual(['Bob']);
      expect(chat.teamSections[0].items.map((i: any) => [i.kind, i.title])).toEqual([['channel', 'General']]);
      // Other filters keep the plain list
      chat.setSidebarFilter('unread');
      expect(chat.sectioned).toBeFalse();
    });

    it('the star moves a chat to Favorites at once, and back if the server refuses', async () => {
      let fail = false;
      const favorite = jasmine.createSpy().and.callFake(() => (fail ? Promise.reject('no') : Promise.resolve({ state: {} })));
      const alert = { error: jasmine.createSpy(), success: () => undefined, info: () => undefined };
      const chat: any = create([{ provide: ChatActionsService, useValue: { favorite } }, { provide: AlertService, useValue: alert }]);
      chat.chatData = chats();
      chat.myTeams = teams;
      chat.rebuildSidebar();
      const bob = chat.recentItems[0];
      await chat.toggleFavorite(bob, new Event('click'));
      expect(favorite).toHaveBeenCalledWith('c2', true);
      expect(chat.favoriteItems.map((i: any) => i.title)).toEqual(['Bob', 'Ann']); // newest first
      fail = true;
      await chat.toggleFavorite(chat.teamSections[0].items[0], new Event('click'));
      expect(favorite).toHaveBeenCalledWith('ch1', true);
      expect(chat.favoriteItems.some((i: any) => i.kind === 'channel')).toBeFalse();
      expect(alert.error).toHaveBeenCalled();
    });
  });
});
