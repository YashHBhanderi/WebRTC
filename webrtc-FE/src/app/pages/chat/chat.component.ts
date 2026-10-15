import { PRESENCE_LABEL, PresenceKey, applyPresence, presenceOf } from 'src/app/core/utils/presence.util';
import {
  AfterViewInit,
  DoCheck,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Inject,
  NgZone,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild,
} from '@angular/core';
import { FormBuilder, Validators, FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, firstValueFrom } from 'rxjs';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { environment } from 'src/environments/environment';
import { UserService } from 'src/app/core/services/user.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';
import { MessageSenderService } from 'src/app/core/services/message-sender.service';
import { UploadJob, UploadService } from 'src/app/core/services/upload.service';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MessageComposerComponent, fileIconFor } from './message-composer/message-composer.component';
import { CHAT_CONFIG, ChatConfig } from 'src/app/core/config/chat.config';
import { ChatMessage, ChatState, ChatUser, EditTarget, GroupSummary, MemberReceipt, MessageDraft, PinnedMessage, messagePreview } from 'src/app/core/interfaces/chat';
import { ActiveGroupMeeting, CallManagerService } from 'src/app/core/services/call-manager.service';
import { NotificationCenterService } from 'src/app/core/services/notification-center.service';
import { ShellUiService } from 'src/app/core/services/shell-ui.service';
import { ChatUiService } from 'src/app/core/services/chat-ui.service';
import { ReplyPreview } from './message-composer/message-composer.component';
import { MediaOpenEvent } from './message-item/message-item.component';
import { CallNotificationService } from 'src/app/core/services/call-notification.service';


type SidebarFilter = 'all' | 'unread' | 'groups' | 'contacts';
type SidebarMode = 'chats' | 'archived' | 'profile';
type RightPanel = 'none' | 'search' | 'info';

/** One row in the left list — precomputed so the template does no work per change detection. */
interface SidebarItem {
  kind: 'direct' | 'group' | 'contact';
  key: string;
  conversationId?: string;
  userId?: string;
  title: string;
  avatar?: string;
  online?: boolean;
  presence?: PresenceKey | null;
  preview: string;
  previewIsMine: boolean;
  previewRead: boolean;
  time?: string;
  unread: number;
  hasActiveCall: boolean;
  source: any;
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['../shared/list-pane.scss', './chat.component.scss']
})
export class ChatComponent implements OnInit, AfterViewInit, DoCheck, OnDestroy {
  // ---- lists
  chatData: any[] = [];
  groupChatData: any[] = [];
  archivedChats: any[] = [];
  archivedGroups: any[] = [];
  users: any[] = [];
  sidebarItems: SidebarItem[] = [];
  sidebarFilter: SidebarFilter = 'all';
  sidebarMode: SidebarMode = 'chats';
  sidebarSearch = '';
  listLoading = false;

  // ---- open conversation
  messageArray: ChatMessage[] = [];
  conversationId!: string;
  receiverId!: string;
  isGroupChat = false;
  peerName = '';
  peerAvatar = '';
  isOnline = false;
  lastSeen!: Date;
  groupname!: string;
  groupAvatar = '';
  groupMembers: any[] = [];
  chatState: ChatState | null = null;
  typingUsers = new Map<string, ReturnType<typeof setTimeout>>();
  messagesLoading = false;

  page = 1;
  pageSize: number;
  hasMoreMessages = true;
  isFetchingOldMessages = false;
  isNearBottom = true;
  unseenBelow = 0;

  // ---- composer
  replyingTo: ChatMessage | null = null;
  editing: EditTarget | null = null;
  // ---- receipts / pins / unread divider for the open chat
  private receipts = new Map<string, MemberReceipt>();
  pins: PinnedMessage[] = [];
  pinnedIds = new Set<string>();
  pinsExpanded = false;
  /** First message shown under the "New messages" divider */
  firstUnreadId: string | null = null;
  private openingUnread = 0;

  // ---- right panels / search jump
  rightPanel: RightPanel = 'none';
  highlightedMessageId: string | null = null;
  searchHitId: string | null = null;
  searchTerm = '';

  // ---- media preview
  previewUrl: string | null = null;
  previewType: string | null = null;
  previewDownloadUrl: string | null = null;

  // ---- calls
  /** Live calls / meetings per conversation (owned by CallManagerService). */
  get activeGroupCalls(): { [groupId: string]: ActiveGroupMeeting } {
    return this.calls.meetings;
  }

  // ---- layout
  isMobileView = false;
  showChatPane = false;

  // ---- group creation
  groupForm!: FormGroup;
  selectedMembers: any[] = [];
  selectedFile: File | null = null;
  /** Object URL for the chosen group photo (revoked when replaced/closed). */
  selectedFilePreview: string | null = null;
  creatingGroup = false;
  memberSearch = '';

  // ---- forward
  forwardSource: ChatMessage | null = null;
  forwardSearch = '';
  forwardSending = false;

  readonly myUserId: string = this.authService.getLoggedInUser()?._id;
  loginUserProfile: string = this.authService.getLoggedInUser()?.avatar;
  myUsername: string = this.authService.getLoggedInUser()?.username;

  @ViewChild('scrollContainer', { static: false }) scrollContainer?: ElementRef<HTMLElement>;
  @ViewChild(MessageComposerComponent) composer?: MessageComposerComponent;
  /** Attachments of the open chat that are still uploading (or failed). */
  uploadJobs: UploadJob[] = [];
  dragActive = false;
  private dragDepth = 0;
  /** In-app PDF viewer source (pre-signed URL, trusted: it comes from our API). */
  previewPdf: SafeResourceUrl | null = null;
  @ViewChild('topElement', { static: false }) topElement?: ElementRef<HTMLElement>;
  @ViewChild('groupModal', { static: true }) groupModalTpl!: TemplateRef<any>;
  @ViewChild('forwardModal', { static: true }) forwardModalTpl!: TemplateRef<any>;

  private subs = new Subscription();
  private chatWindowObserver: IntersectionObserver | null = null;
  private seenMessageIds = new Set<string>();
  private markReadTimer: ReturnType<typeof setTimeout> | null = null;
  private listReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private groupModalRef: NgbModalRef | null = null;
  private forwardModalRef: NgbModalRef | null = null;
  private detachScroll: (() => void) | null = null;
  private conversationSeq = 0;
  /** Lists loaded at least once (deep links wait for all of them). */
  private readonly loadedLists = new Set<string>();
  /** `/chat?c=…&m=…` or `/chat?user=…` waiting for the lists (global search, notifications). */
  private pendingDeepLink: { conversationId?: string; userId?: string; messageId?: string; term?: string } | null = null;

  private readonly onResize = () => this.checkScreenSize();
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible' && this.conversationId) {
      this.scheduleMarkRead();
    }
  };

  /** Bound for the composer component (keeps `this`). */
  readonly sendDraft = (draft: MessageDraft): Promise<boolean> => this.send(draft);
  readonly saveEdit = (id: string, text: string, mentionIds: string[]): Promise<boolean> => this.submitEdit(id, text, mentionIds);

  constructor(
    public formBuilder: FormBuilder,
    private userService: UserService,
    private socketService: SocketService,
    public authService: AuthService,
    private alertService: AlertService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private route: ActivatedRoute,
    private modalService: NgbModal,
    private chatActions: ChatActionsService,
    private sender: MessageSenderService,
    public uploads: UploadService,
    private sanitizer: DomSanitizer,
    private zone: NgZone,
    public callNotifications: CallNotificationService,
    private calls: CallManagerService,
    private notificationCenter: NotificationCenterService,
    private shellUi: ShellUiService,
    public chatUi: ChatUiService,
    @Inject(CHAT_CONFIG) config: ChatConfig,
  ) {
    this.pageSize = config.historyPageSize;
    this.groupForm = this.formBuilder.group({
      groupName: ['', Validators.required],
      groupDescription: [''],
      groupMembers: [[], Validators.required],
      groupAvatar: null,
    });
  }

  // ================================================================ lifecycle

  ngOnInit(): void {
    this.checkScreenSize();
    this.loadChatConversations();
    this.loadGroupConversations();
    this.loadArchived();
    this.loadUsers();

    this.subs.add(this.socketService.newMessageReceived().subscribe((data: any) => this.onIncomingMessage(data)));

    this.subs.add(this.socketService.onReactionUpdated().subscribe((data: any) => {
      const index = this.messageArray.findIndex(m => m._id === data.messageId);
      if (index > -1) {
        // New object so the OnPush message row re-renders
        this.messageArray[index] = { ...this.messageArray[index], reactions: data.reactions };
        this.messageArray = [...this.messageArray];
      }
    }));

    this.subs.add(this.socketService.receivedTyping().subscribe((data: any) => this.onTyping(data)));
    this.subs.add(this.socketService.messagesMarkedRead().subscribe((data: any) => this.handleMessagesMarkedRead(data)));
    this.subs.add(this.socketService.onPresence().subscribe((data: any) => this.onPresence(data)));
    this.subs.add(this.socketService.onUserUpdated().subscribe((data) => this.onUserUpdated(data)));
    // New accounts show up in contacts / new chat / group member pickers without a reload
    this.subs.add(this.userService.newUsers$.subscribe((user) => {
      this.users = UserService.withUser(this.users, user);
      this.rebuildSidebar();
    }));
    // Missed events while offline: resync the list
    this.subs.add(this.userService.reconnected$.subscribe(() => this.loadUsers()));
    // A reconnected socket is in no rooms: rejoin the open chat so typing/room events keep flowing
    this.subs.add(this.socketService.onConnect().subscribe(() => {
      if (this.conversationId) {
        this.socketService.joinConversation(this.conversationId);
      }
    }));
    this.subs.add(this.socketService.onGroupUpdated().subscribe((data: any) => this.onGroupUpdated(data?.group)));
    this.subs.add(this.socketService.onGroupAdded().subscribe(() => this.loadGroupConversations()));
    this.subs.add(this.socketService.onGroupRemoved().subscribe((data: any) => this.onGroupRemoved(data)));
    this.subs.add(this.socketService.onMessageRejected().subscribe((data: any) => {
      this.alertService.warning(data?.reason === 'blocked'
        ? "Message not sent. You can't message this contact."
        : `Message not sent.${data?.message ? ' ' + data.message : ''}`);
    }));

    this.subs.add(this.socketService.onReceiptsUpdated().subscribe((data) => this.onReceipts(data)));
    this.subs.add(this.socketService.onMessageUpdated().subscribe((data) => this.onMessageUpdated(data)));
    this.subs.add(this.socketService.onMessageDeleted().subscribe((data) => this.onMessageDeleted(data)));
    this.subs.add(this.socketService.onPinsChanged().subscribe((data) => {
      if (String(data?.conversationId) === this.conversationId) {
        this.setPins(data.pins || []);
      }
    }));

    // Deep links: open a conversation (and optionally jump to a message)
    this.subs.add(this.route.queryParamMap.subscribe((params) => {
      const conversationId = params.get('c') || undefined;
      const userId = params.get('user') || undefined;
      if (!conversationId && !userId) {
        return;
      }
      this.pendingDeepLink = { conversationId, userId, messageId: params.get('m') || undefined, term: params.get('q') || undefined };
      void this.tryOpenDeepLink();
    }));

    this.subs.add(this.uploads.jobs$.subscribe(() => {
      const before = this.uploadJobs.length;
      this.uploadJobs = this.conversationId ? this.uploads.jobsFor(this.conversationId) : [];
      if (this.uploadJobs.length > before && this.isNearBottom) {
        this.scrollToBottom();
      }
    }));

    // Live-call badges in the list follow the shared call state
    this.subs.add(this.calls.meetings$.subscribe(() => this.rebuildSidebar()));

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.onResize);
  }

  /** Phones: an open conversation takes the whole screen (no bottom tab bar), like Teams. */
  ngDoCheck(): void {
    this.shellUi.setImmersive(this.isMobileView && this.showChatPane && this.hasOpenConversation);
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
  }

  ngOnDestroy(): void {
    this.shellUi.setImmersive(false);
    this.notificationCenter.activeConversationId = null;
    this.subs.unsubscribe();
    [this.markReadTimer, this.listReloadTimer, this.highlightTimer].forEach((t) => t && clearTimeout(t));
    this.typingUsers.forEach((t) => clearTimeout(t));
    this.chatWindowObserver?.disconnect();
    this.detachScroll?.();
    if (this.myUserId) {
      this.socketService.stopTyping(this.myUserId);
    }
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
  }

  checkScreenSize(): void {
    this.isMobileView = window.innerWidth <= 768;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Modals and menus handle their own Escape first
    if (document.querySelector('.modal.show, .dropdown-menu.show, app-emoji-picker')) {
      return;
    }
    if (this.previewUrl) {
      this.closePreview();
    } else if (this.replyingTo) {
      this.cancelReply();
    } else if (this.rightPanel !== 'none') {
      this.closeRightPanel();
    } else if (this.pinsExpanded) {
      this.pinsExpanded = false;
    }
  }

  get hasOpenConversation(): boolean {
    return !!(this.receiverId || this.conversationId);
  }

  get archivedTotal(): number {
    return this.archivedChats.length + this.archivedGroups.length;
  }

  get isArchived(): boolean {
    return !!this.chatState?.isArchived;
  }

  get blockedByMe(): boolean {
    return !this.isGroupChat && !!this.chatState?.blockedByMe;
  }

  backToList(): void {
    this.showChatPane = false;
    this.rightPanel = 'none';
  }

  // ================================================================ sidebar

  loadUsers(): void {
    this.userService.getAllUsersExceptCurrentUser().subscribe({
      next: (response) => {
        this.users = response.data || [];
        this.rebuildSidebar();
      },
      error: () => undefined, // The error interceptor already showed a friendly message
    });
  }

  loadChatConversations(): void {
    this.listLoading = true;
    this.userService.getUserConversations().subscribe({
      next: (response) => {
        this.listLoading = false;
        this.chatData = response.data || [];
        this.rebuildSidebar();
        this.listLoaded('chats');
      },
      error: (error) => {
        this.listLoading = false;
        // The error interceptor already showed a friendly message
        this.listLoaded('chats');
      }
    });
  }

  private loadGroupConversations(): void {
    this.userService.getUserGropuConversations().subscribe({
      next: (response) => {
        this.groupChatData = response.data || [];
        this.syncOpenGroupFromList();
        this.rebuildSidebar();
        this.listLoaded('groups');
      },
      error: (error) => {
        // The error interceptor already showed a friendly message
        this.listLoaded('groups');
      }
    });
  }

  private loadArchived(): void {
    this.userService.getUserConversations(true).subscribe({
      next: (res) => {
        this.archivedChats = res.data || [];
        this.rebuildSidebar();
        this.listLoaded('archivedChats');
      },
      error: () => this.listLoaded('archivedChats'),
    });
    this.userService.getUserGropuConversations(true).subscribe({
      next: (res) => {
        this.archivedGroups = res.data || [];
        this.rebuildSidebar();
        this.listLoaded('archivedGroups');
      },
      error: () => this.listLoaded('archivedGroups'),
    });
  }

  private reloadAllLists(): void {
    this.loadChatConversations();
    this.loadGroupConversations();
    this.loadArchived();
  }

  /** New conversation appeared (first message from someone) → refresh lists once. */
  private scheduleListReload(): void {
    if (this.listReloadTimer) {
      return;
    }
    this.listReloadTimer = setTimeout(() => {
      this.listReloadTimer = null;
      this.reloadAllLists();
    }, 600);
  }

  setSidebarFilter(filter: SidebarFilter): void {
    this.sidebarFilter = filter;
    this.rebuildSidebar();
  }

  setSidebarMode(mode: SidebarMode): void {
    this.sidebarMode = mode;
    this.sidebarSearch = '';
    if (mode === 'archived') {
      this.loadArchived();
    }
    this.rebuildSidebar();
  }

  onSidebarSearch(value: string): void {
    this.sidebarSearch = value;
    this.rebuildSidebar();
  }

  rebuildSidebar(): void {
    this.notificationCenter.setUnreadChats(
      [...this.chatData, ...this.groupChatData].filter((c) => c.unreadCount > 0 && String(c._id) !== this.conversationId).map((c) => String(c._id)),
    );
    const q = this.sidebarSearch.trim().toLowerCase();
    const matches = (text: string) => !q || (text || '').toLowerCase().includes(q);
    const items: SidebarItem[] = [];
    const archivedMode = this.sidebarMode === 'archived';

    if (!archivedMode && this.sidebarFilter === 'contacts') {
      this.users
        .filter((u) => matches(u.username))
        .sort((a, b) => (a.username || '').localeCompare(b.username || ''))
        .forEach((u) => items.push({
          kind: 'contact',
          key: `c:${u._id}`,
          userId: u._id,
          title: u.username,
          avatar: u.avatar,
          online: !!u.isOnline,
          presence: presenceOf(u),
          preview: u.bio || (u.isOnline ? 'Online' : ''),
          previewIsMine: false,
          previewRead: false,
          unread: 0,
          hasActiveCall: false,
          source: u,
        }));
      this.sidebarItems = items;
      return;
    }

    const chats = archivedMode ? this.archivedChats : this.chatData;
    const groups = archivedMode ? this.archivedGroups : this.groupChatData;

    if (archivedMode || this.sidebarFilter !== 'groups') {
      chats.forEach((c) => {
        if (!c?.receiver || !matches(c.receiver.username)) {
          return;
        }
        items.push({
          kind: 'direct',
          key: `d:${c._id}`,
          conversationId: c._id,
          userId: c.receiver._id,
          title: c.receiver.username,
          avatar: c.receiver.avatar,
          online: !!c.receiver.isOnline,
          presence: presenceOf(c.receiver),
          preview: this.previewText(c.lastMessage),
          previewIsMine: this.isMineId(c.lastMessage?.userId),
          previewRead: !!c.lastMessage?.isRead,
          time: c.lastMessage?.createdAt || c.timestamp,
          unread: c.unreadCount || 0,
          hasActiveCall: !!this.activeGroupCalls[c._id],
          source: c,
        });
      });
    }

    groups.forEach((g) => {
      if (!matches(g.groupName)) {
        return;
      }
      const hasLast = !!g.lastMessage?.createdAt;
      items.push({
        kind: 'group',
        key: `g:${g._id}`,
        conversationId: g._id,
        title: g.groupName,
        avatar: g.groupAvatar,
        preview: hasLast ? this.previewText(g.lastMessage, true) : `${g.members?.length || 0} participants`,
        previewIsMine: false,
        previewRead: false,
        time: g.lastMessage?.createdAt || g.timestamp,
        unread: g.unreadCount || 0,
        hasActiveCall: !!this.activeGroupCalls[g._id],
        source: g,
      });
    });

    let result = items;
    if (!archivedMode && this.sidebarFilter === 'unread') {
      result = items.filter((i) => i.unread > 0);
    }
    result.sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());
    this.sidebarItems = result;
  }

  private previewText(last: any, withSender = false): string {
    if (!last) {
      return '';
    }
    const icons: Record<string, string> = { image: '📷 ', video: '🎥 ', audio: '🎵 ', pdf: '📄 ', call: '📞 ' };
    const body = (icons[last.type] || '') + (last.type === 'call' || last.type === 'system' ? last.content : messagePreview(last));
    if (withSender && last.type !== 'system' && this.isMineId(last.userId)) {
      return `You: ${body}`;
    }
    return body;
  }

  openSidebarItem(item: SidebarItem): void {
    this.openingUnread = item.unread || 0;
    if (item.kind === 'group') {
      this.openGroupConversation(item.source);
      return;
    }
    if (item.kind === 'direct') {
      const c = item.source;
      this.startOrResumeChat(c.receiver.username, c.receiver.avatar, c.receiver.isOnline, c._id, c.receiver._id, c.receiver.lastSeen);
      return;
    }
    const u = item.source;
    const existing = [...this.chatData, ...this.archivedChats].find((c) => c.receiver?._id === u._id);
    this.startOrResumeChat(u.username, u.avatar, u.isOnline, existing?._id || u.conversationId, u._id, u.lastSeen);
  }

  isItemActive(item: SidebarItem): boolean {
    if (item.kind === 'contact') {
      return !this.isGroupChat && this.receiverId === item.userId;
    }
    return this.conversationId === item.conversationId;
  }

  trackBySidebar(_: number, item: SidebarItem): string {
    return item.key;
  }

  // ================================================================ opening conversations

  startOrResumeChat(name: string, avatar: any, isOnline: boolean, conversationId: string, receiverId: string, lastSeen: Date): void {
    this.resetConversationState();
    this.isGroupChat = false;
    this.receiverId = receiverId;
    this.peerName = name;
    this.peerAvatar = avatar;
    this.isOnline = isOnline;
    this.lastSeen = lastSeen;
    this.showChatPane = true;

    if (!conversationId) {
      this.startNewChat(receiverId, name, avatar);
    } else {
      this.conversationId = conversationId;
      this.afterConversationOpened();
    }
  }

  startNewChat(userId: string, username: string, avatar: string): void {
    this.userService.createOrGetConversation(userId).subscribe({
      next: (response) => {
        if (response && response.conversationId) {
          this.conversationId = response.conversationId;
          this.peerName = username;
          this.peerAvatar = avatar;
          this.afterConversationOpened();
        } else {
          this.alertService.error("We couldn't open this chat. Please try again.");
        }
      },
      error: () => undefined, // The error interceptor already showed a friendly message
    });
  }

  openGroupConversation(group: any): void {
    this.resetConversationState();
    this.isGroupChat = true;
    this.receiverId = '';
    this.groupname = group.groupName;
    this.groupAvatar = group.groupAvatar ? group.groupAvatar : '';
    this.conversationId = group._id;
    this.groupMembers = group.members || [];
    this.showChatPane = true;
    this.afterConversationOpened();
    this.checkForActiveGroupCall();
  }

  private afterConversationOpened(): void {
    this.uploadJobs = this.uploads.jobsFor(this.conversationId);
    this.notificationCenter.activeConversationId = this.conversationId;
    this.loadMessages(this.conversationId);
    this.socketService.markMessagesAsRead(this.conversationId);
    const id = this.conversationId;
    this.chatActions.state(id).then((state) => {
      if (this.conversationId === id) {
        this.chatState = state;
        this.receipts = new Map((state.receipts || []).map((r) => [String(r.userId), r]));
        this.setPins(state.pins || []);
        this.refreshStatuses();
      }
    }).catch(() => undefined);
  }

  private resetConversationState(): void {
    this.conversationSeq++;
    this.cancelReply();
    this.editing = null;
    this.receipts.clear();
    this.pins = [];
    this.pinnedIds = new Set();
    this.pinsExpanded = false;
    this.firstUnreadId = null;
    this.chatState = null;
    this.searchHitId = null;
    this.searchTerm = '';
    this.highlightedMessageId = null;
    this.typingUsers.forEach((t) => clearTimeout(t));
    this.typingUsers.clear();
    this.messageArray = [];
    this.page = 1;
    this.hasMoreMessages = true;
    this.isFetchingOldMessages = false;
    this.unseenBelow = 0;
    this.isNearBottom = true;
    if (this.rightPanel === 'search') {
      this.rightPanel = 'none';
    }
    if (this.myUserId) {
      this.socketService.stopTyping(this.myUserId);
    }
  }

  private closeConversation(): void {
    this.resetConversationState();
    this.conversationId = '';
    this.receiverId = '';
    this.isGroupChat = false;
    this.rightPanel = 'none';
    this.showChatPane = false;
  }

  private loadMessages(conversationId: string): void {
    this.messagesLoading = true;
    this.isFetchingOldMessages = true; // Block infinite scroll while initial page loads
    this.socketService.joinConversation(conversationId);
    this.userService.getMessages(conversationId, this.page, this.pageSize).subscribe({
      next: (response) => {
        if (this.conversationId !== conversationId) {
          return; // user switched chats while loading
        }
        if (response.success) {
          this.messageArray = this.withSenderNames(response.data || []);
          this.messageArray.forEach((m) => this.seenMessageIds.add(m._id));
          this.hasMoreMessages = (response.data || []).length === this.pageSize;
          this.refreshStatuses();
          this.placeUnreadDivider();
        }
        this.messagesLoading = false;
        this.cdr.detectChanges();
        this.attachScrollWatcher();
        this.setupInfiniteScroll();
        // Open at the first unread message (Teams-style), otherwise at the latest
        const divider = this.firstUnreadId ? document.getElementById('unread-divider') : null;
        if (divider) {
          divider.scrollIntoView({ block: 'start' });
        } else {
          this.scrollToBottom(true);
        }
        setTimeout(() => {
          this.isFetchingOldMessages = false; // Re-enable infinite scroll after rendering
        }, 400);
      },
      error: () => {
        this.messagesLoading = false;
        this.isFetchingOldMessages = false;
      }
    });
  }

  private withSenderNames(messages: ChatMessage[]): ChatMessage[] {
    if (!this.isGroupChat) {
      return messages;
    }
    return messages.map((message) => {
      const sender = this.groupMembers?.find((member) => member._id === (message.userId || message.user?._id));
      if (sender) {
        message.senderName = sender.username;
      }
      return message;
    });
  }

  setupInfiniteScroll(): void {
    this.chatWindowObserver?.disconnect();
    const root = this.scrollContainer?.nativeElement;
    if (!root || !this.topElement) {
      return;
    }
    this.chatWindowObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.hasMoreMessages && !this.isFetchingOldMessages) {
        this.zone.run(() => this.fetchOldMessages());
      }
    }, { root, rootMargin: '120px 0px 0px 0px', threshold: 0 });
    this.chatWindowObserver.observe(this.topElement.nativeElement);
  }

  fetchOldMessages(): void {
    if (!this.conversationId || !this.hasMoreMessages) {
      return;
    }
    const conversationId = this.conversationId;
    this.page++;
    this.isFetchingOldMessages = true;
    const scrollElement = this.scrollContainer?.nativeElement;
    const oldScrollHeight = scrollElement?.scrollHeight || 0;

    this.userService.getMessages(conversationId, this.page, this.pageSize).subscribe({
      next: (response) => {
        if (this.conversationId !== conversationId) {
          return;
        }
        const data: ChatMessage[] = response.success ? response.data || [] : [];
        if (data.length) {
          const older = this.withSenderNames(data).filter((m) => !this.seenMessageIds.has(m._id));
          older.forEach((m) => this.seenMessageIds.add(m._id));
          this.messageArray = [...older, ...this.messageArray];
          this.hasMoreMessages = data.length >= this.pageSize;
          this.cdr.detectChanges();
          if (scrollElement) {
            // Keep the reader's position after prepending
            scrollElement.scrollTop = scrollElement.scrollHeight - oldScrollHeight;
          }
        } else {
          this.hasMoreMessages = false;
        }
        this.isFetchingOldMessages = false;
      },
      error: () => {
        this.page--;
        this.isFetchingOldMessages = false;
      }
    });
  }

  // ================================================================ realtime messages

  private onIncomingMessage(data: any): void {
    if (!data?._id) {
      return;
    }
    // The server emits both to the room and to each member socket — keep the first copy
    const fresh = !this.seenMessageIds.has(data._id);
    this.seenMessageIds.add(data._id);
    if (!fresh) {
      return;
    }
    if (this.seenMessageIds.size > 5000) {
      this.seenMessageIds = new Set([...this.seenMessageIds].slice(-2000));
    }

    const conversationId = String(data.conversationId);
    const senderId = String(data.user?._id || data.userId || '');
    const mine = senderId === this.myUserId;
    const isOpen = conversationId === this.conversationId;
    this.updateListForMessage(conversationId, data, mine, isOpen);

    if (!isOpen) {
      return;
    }

    if (this.typingUsers.has(senderId)) {
      clearTimeout(this.typingUsers.get(senderId)!);
      this.typingUsers.delete(senderId);
    }

    const append = (msg: ChatMessage) => {
      this.messageArray = [...this.messageArray, msg];
      if (mine || this.isNearBottom) {
        this.scrollToBottom();
      } else {
        this.unseenBelow++;
      }
      if (!mine) {
        this.scheduleMarkRead();
      }
    };

    if (this.isGroupChat && !data.user) {
      this.userService.getUserById(data.userId).subscribe({
        next: (response) => {
          data.senderName = response.data.username;
          data.user = { _id: data.userId, username: response.data.username, avatar: response.data.avatar };
          append(data);
        },
        error: () => undefined, // The error interceptor already showed a friendly message
      });
      return;
    }
    if (this.isGroupChat && data.user) {
      data.senderName = data.user.username;
    }
    append(data);
  }

  /** Move the conversation to the top with the new last message, bumping unread if it isn't open. */
  private updateListForMessage(conversationId: string, message: any, mine: boolean, isOpen: boolean): void {
    const bump = (list: any[]): boolean => {
      const index = list.findIndex((c) => String(c._id) === conversationId);
      if (index === -1) {
        return false;
      }
      const updated = {
        ...list[index],
        lastMessage: {
          ...list[index].lastMessage,
          _id: message._id,
          userId: message.user?._id || message.userId,
          content: message.content,
          type: message.type,
          isRead: false,
          createdAt: message.createdAt,
        },
      };
      if (!isOpen && !mine) {
        updated.unreadCount = (updated.unreadCount || 0) + 1;
      }
      list.splice(index, 1);
      list.unshift(updated);
      return true;
    };
    // Archived chats stay archived when new messages arrive (WhatsApp default)
    const found = bump(this.chatData) || bump(this.groupChatData) || bump(this.archivedChats) || bump(this.archivedGroups);
    if (!found) {
      this.scheduleListReload();
    }
    this.rebuildSidebar();
  }

  private scheduleMarkRead(): void {
    if (document.visibilityState !== 'visible' || !this.conversationId) {
      return;
    }
    if (this.markReadTimer) {
      clearTimeout(this.markReadTimer);
    }
    const id = this.conversationId;
    this.markReadTimer = setTimeout(() => {
      this.markReadTimer = null;
      if (this.conversationId === id) {
        this.socketService.markMessagesAsRead(id);
      }
    }, 500);
  }

  handleMessagesMarkedRead(data: { conversationId: string; userId: string }): void {
    const conversationId = String(data?.conversationId);
    const readerIsMe = String(data?.userId) === this.myUserId;
    const update = (list: any[]) => {
      const conversation = list.find((c) => String(c._id) === conversationId);
      if (!conversation) {
        return;
      }
      if (readerIsMe) {
        conversation.unreadCount = 0;
      } else if (conversation.lastMessage && this.isMineId(conversation.lastMessage.userId)) {
        conversation.lastMessage = { ...conversation.lastMessage, isRead: true };
      }
    };
    [this.chatData, this.groupChatData, this.archivedChats, this.archivedGroups].forEach(update);

    // Someone else read this chat → my messages are seen (new objects so OnPush rows update)
    if (!readerIsMe && conversationId === this.conversationId) {
      let changed = false;
      this.messageArray = this.messageArray.map((m) => {
        if (this.isMine(m) && !m.isRead) {
          changed = true;
          return { ...m, isRead: true };
        }
        return m;
      });
      if (!changed) {
        this.messageArray = [...this.messageArray];
      }
    }
    this.rebuildSidebar();
  }

  private onTyping(data: any): void {
    const userId = String(data?.userId || '');
    if (!userId || userId === this.myUserId) {
      return;
    }
    if (data.conversationId && String(data.conversationId) !== this.conversationId) {
      return;
    }
    const existing = this.typingUsers.get(userId);
    if (existing) {
      clearTimeout(existing);
    }
    if (data.isTyping) {
      // Safety expiry in case the stop event is lost
      this.typingUsers.set(userId, setTimeout(() => this.typingUsers.delete(userId), 8000));
    } else {
      this.typingUsers.delete(userId);
    }
  }

  private onPresence(data: any): void {
    const userId = String(data?.userId || '');
    if (!userId) {
      return;
    }
    const apply = (u: any) => {
      if (u && String(u._id) === userId) {
        applyPresence(u, data);
      }
    };
    [...this.chatData, ...this.archivedChats].forEach((c) => apply(c.receiver));
    this.users.forEach(apply);
    [...this.groupChatData, ...this.archivedGroups].forEach((g) => (g.members || []).forEach(apply));
    this.groupMembers.forEach(apply);
    if (!this.isGroupChat && this.receiverId === userId) {
      this.isOnline = !!data.isOnline;
      if (data.lastSeen) {
        this.lastSeen = data.lastSeen;
      }
    }
    this.groupMembers = [...this.groupMembers];
    this.rebuildSidebar();
  }

  // ================================================================ groups (live updates)

  private onGroupUpdated(group: GroupSummary | undefined): void {
    if (!group?._id) {
      return;
    }
    const apply = (list: any[]) => {
      const entry = list.find((g) => String(g._id) === String(group._id));
      if (entry) {
        entry.groupName = group.groupName;
        entry.groupAvatar = group.groupAvatar;
        entry.groupDescription = group.groupDescription;
        entry.groupAdmins = group.groupAdmins;
        entry.members = group.members;
      }
    };
    apply(this.groupChatData);
    apply(this.archivedGroups);
    if (this.isGroupChat && this.conversationId === String(group._id)) {
      this.groupname = group.groupName || this.groupname;
      this.groupAvatar = group.groupAvatar || '';
      this.groupMembers = group.members || [];
    }
    this.rebuildSidebar();
  }

  /** The info panel saved/changed the group — reflect it in the header and list right away. */
  onPanelGroupChanged(group: GroupSummary): void {
    this.onGroupUpdated(group);
  }

  private onGroupRemoved(data: any): void {
    const groupId = String(data?.groupId || '');
    if (!groupId) {
      return;
    }
    const name = [...this.groupChatData, ...this.archivedGroups].find((g) => String(g._id) === groupId)?.groupName;
    this.groupChatData = this.groupChatData.filter((g) => String(g._id) !== groupId);
    this.archivedGroups = this.archivedGroups.filter((g) => String(g._id) !== groupId);
    if (this.conversationId === groupId) {
      this.closeConversation();
    }
    if (data?.reason === 'removed') {
      this.alertService.info(`You were removed from ${name || 'a group'}`);
    } else if (data?.reason === 'deleted' && String(data?.by) !== this.myUserId) {
      this.alertService.info(`${name || 'A group'} was deleted by an admin`);
    }
    this.rebuildSidebar();
  }

  private syncOpenGroupFromList(): void {
    if (!this.isGroupChat || !this.conversationId) {
      return;
    }
    const entry = this.groupChatData.find((g) => String(g._id) === this.conversationId);
    if (entry) {
      this.groupMembers = entry.members || this.groupMembers;
    }
  }

  // ================================================================ header

  get headerSubtitle(): string {
    if (this.isGroupChat) {
      const typing = [...this.typingUsers.keys()];
      if (typing.length) {
        const names = typing.map((id) => this.groupMembers.find((m) => m._id === id)?.username || 'Someone');
        return names.length === 1 ? `${names[0]} is typing…` : `${names.length} people are typing…`;
      }
      const total = this.groupMembers.length;
      const online = this.groupMembers.filter((m) => m.isOnline || String(m._id) === this.myUserId).length;
      return `${total} Participant${total === 1 ? '' : 's'} · ${online} online`;
    }
    if (this.typingUsers.size) {
      return 'typing…';
    }
    const peer = this.peerUser;
    if (this.isOnline) {
      const label = PRESENCE_LABEL[presenceOf({ ...peer, isOnline: true })];
      return peer?.statusMessage ? `${label} · ${peer.statusMessage}` : label;
    }
    return this.lastSeen ? `last seen ${this.formatLastSeen(this.lastSeen)}` : '';
  }

  /** The other person in an open 1:1 chat, as known from the lists (for presence details). */
  get peerUser(): any {
    if (this.isGroupChat || !this.receiverId) {
      return null;
    }
    return [...this.chatData, ...this.archivedChats].find((c) => String(c.receiver?._id) === this.receiverId)?.receiver
      || this.users.find((u) => String(u._id) === this.receiverId)
      || null;
  }

  get peerPresence(): PresenceKey {
    return presenceOf({ ...(this.peerUser || {}), isOnline: this.isOnline });
  }

  get isTyping(): boolean {
    return this.typingUsers.size > 0;
  }

  openInfoPanel(): void {
    this.rightPanel = this.rightPanel === 'info' ? 'none' : 'info';
  }

  openSearchPanel(): void {
    this.rightPanel = 'search';
  }

  closeRightPanel(): void {
    this.rightPanel = 'none';
    this.searchHitId = null;
    this.searchTerm = '';
  }

  async toggleArchive(): Promise<void> {
    const archive = !this.isArchived;
    try {
      const res = await this.chatActions.archive(this.conversationId, archive);
      this.chatState = { ...(this.chatState as ChatState), ...res.state };
      this.alertService.success(archive ? 'Chat archived' : 'Chat unarchived');
      this.reloadAllLists();
    } catch (error: any) {
      this.alertService.fromError(error, "We couldn't update the chat. Please try again.");
    }
  }

  async clearChat(): Promise<void> {
    const confirm = await this.alertService.confirm({ title: 'Clear this chat?', text: 'Messages will be removed for you only. Other participants will still see them.', confirmText: 'Clear chat', danger: true });
    if (!confirm) {
      return;
    }
    try {
      const res = await this.chatActions.clear(this.conversationId);
      this.chatState = { ...(this.chatState as ChatState), ...res.state };
      this.messageArray = [];
      this.hasMoreMessages = false;
      const clearEntry = (list: any[]) => {
        const entry = list.find((c) => String(c._id) === this.conversationId);
        if (entry) {
          entry.lastMessage = null;
          entry.unreadCount = 0;
        }
      };
      [this.chatData, this.groupChatData, this.archivedChats, this.archivedGroups].forEach(clearEntry);
      this.rebuildSidebar();
    } catch (error: any) {
      this.alertService.fromError(error, "We couldn't clear the chat. Please try again.");
    }
  }

  async toggleBlock(): Promise<void> {
    if (this.isGroupChat || !this.receiverId) {
      return;
    }
    const block = !this.blockedByMe;
    if (block) {
      const confirm = await this.alertService.confirm({ title: `Block ${this.peerName}?`, text: "Blocked contacts can't message or call you. They won't be notified.", confirmText: 'Block', danger: true });
      if (!confirm) {
        return;
      }
    }
    try {
      await this.chatActions.setBlocked(this.receiverId, block);
      this.chatState = { ...(this.chatState as ChatState), blockedByMe: block };
      this.alertService.success(block ? `${this.peerName} blocked` : `${this.peerName} unblocked`);
    } catch (error: any) {
      this.alertService.fromError(error, "We couldn't update the block. Please try again.");
    }
  }

  async leaveGroup(): Promise<void> {
    if (!this.isGroupChat) {
      return;
    }
    const confirm = await this.alertService.confirm({ title: `Exit "${this.groupname}"?`, text: 'You will stop receiving messages from this group.', confirmText: 'Exit group', danger: true });
    if (!confirm) {
      return;
    }
    const groupId = this.conversationId;
    try {
      await this.chatActions.leaveGroup(groupId);
      this.onGroupRemoved({ groupId, reason: 'left' });
      this.alertService.success('You left the group');
    } catch (error: any) {
      this.alertService.fromError(error, "We couldn't leave the group. Please try again.");
    }
  }

  async deleteGroup(): Promise<void> {
    if (!this.isGroupChat) {
      return;
    }
    const confirmed = await this.alertService.confirm({
      title: `Delete "${this.groupname}"?`,
      text: 'The group and all of its messages and files will be deleted for every member. This cannot be undone.',
      confirmText: 'Delete group',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    const groupId = this.conversationId;
    try {
      await firstValueFrom(this.userService.deleteConversation(groupId));
      this.onGroupRemoved({ groupId, reason: 'deleted-by-me' });
      this.alertService.success('Group deleted');
    } catch {
      // The interceptor already showed the reason
    }
  }

  // ================================================================ message helpers (template)

  isMineId(id: any): boolean {
    return !!id && String(id) === this.myUserId;
  }

  isMine(msg: ChatMessage): boolean {
    return this.isMineId(msg.user?._id || msg.userId);
  }

  trackByMessage(_: number, msg: ChatMessage): string {
    return msg._id;
  }

  isNewDay(index: number): boolean {
    if (index === 0) {
      return true;
    }
    const a = new Date(this.messageArray[index - 1]?.createdAt);
    const b = new Date(this.messageArray[index]?.createdAt);
    return a.toDateString() !== b.toDateString();
  }

  /** First bubble of a run from the same sender (shows the group sender name, bubble tail). */
  isFirstOfRun(index: number): boolean {
    if (index === 0 || this.isNewDay(index)) {
      return true;
    }
    const prev = this.messageArray[index - 1];
    const cur = this.messageArray[index];
    if (prev.type === 'call' || prev.type === 'system') {
      return true;
    }
    const sameSender = String(prev.user?._id || prev.userId) === String(cur.user?._id || cur.userId);
    const gap = new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return !sameSender || gap > 5 * 60 * 1000;
  }

  dayLabel(date: string): string {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) {
      return 'Today';
    }
    if (d.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }
    const diffDays = (today.getTime() - d.getTime()) / 86400000;
    if (diffDays < 7) {
      return d.toLocaleDateString(undefined, { weekday: 'long' });
    }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  senderName(msg: ChatMessage): string {
    if (this.isMine(msg)) {
      return 'You';
    }
    if (!this.isGroupChat) {
      return this.peerName;
    }
    const id = String(msg.user?._id || msg.userId);
    return msg.senderName || msg.user?.username || this.groupMembers.find((m) => String(m._id) === id)?.username || 'Unknown';
  }

  /** The actual sender's picture (never the group's). */
  senderAvatar(msg: ChatMessage): string | undefined {
    if (!this.isGroupChat) {
      return this.peerAvatar;
    }
    const id = String(msg.user?._id || msg.userId);
    return msg.user?.avatar || this.groupMembers.find((m) => String(m._id) === id)?.avatar;
  }

  /** Who wrote the quoted message: "You", the group member, or the other person in a 1:1. */
  replyAuthor(reply: any): string {
    if (!reply) {
      return '';
    }
    if (this.isMineId(reply.userId)) {
      return 'You';
    }
    if (this.isGroupChat) {
      return this.groupMembers.find((m) => String(m._id) === String(reply.userId))?.username || 'Member';
    }
    return this.peerName || 'Reply';
  }

  get replyPreview(): ReplyPreview | null {
    const msg = this.replyingTo;
    if (!msg) {
      return null;
    }
    return {
      id: msg._id,
      author: this.isMine(msg) ? 'You' : this.senderName(msg),
      text: messagePreview(msg),
    };
  }

  /** Call messages carry their join link in fileUrl; extract the call id. */
  callIdOf(msg: ChatMessage): string | null {
    const match = /[?&]callId=([^&]+)/.exec(msg.fileUrl || '');
    return match ? decodeURIComponent(match[1]) : null;
  }

  isCallLive(msg: ChatMessage): boolean {
    const callId = this.callIdOf(msg);
    return !!callId && Object.values(this.activeGroupCalls).some((m) => String(m.callId) === callId);
  }

  isMissedCall(msg: ChatMessage): boolean {
    return msg.type === 'call' && /^(missed|declined)/i.test(msg.content || '');
  }

  /** Call log line, from my side: I placed it → outgoing / unanswered. */
  callLogLabel(msg: ChatMessage): string {
    const call = msg.call;
    if (!call) {
      return msg.content || 'Call';
    }
    if (call.mode === 'meetNow') {
      return 'Meeting';
    }
    const kind = call.callType === 'video' ? 'video' : 'voice';
    if (call.outcome === 'missed') {
      return this.isMine(msg) ? `Unanswered ${kind} call` : `Missed ${kind} call`;
    }
    return `${this.isMine(msg) ? 'Outgoing' : 'Incoming'} ${kind} call`;
  }

  callLogDuration(msg: ChatMessage): string {
    const total = Math.max(0, Math.round(msg.call?.duration || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  }

  /** 1:1 chats only (groups start meetings from the header). */
  get canCallBack(): boolean {
    return !this.isGroupChat && !this.blockedByMe && !this.inCallHere;
  }

  callAgain(msg: ChatMessage): void {
    if (msg.call?.callType === 'video') {
      this.startVideoCall();
    } else {
      this.startAudioCall();
    }
  }

  isVideoCallMessage(msg: ChatMessage): boolean {
    return /video|meeting/i.test(msg.content || '') || /callType=video/.test(msg.fileUrl || '');
  }

  joinCallFromMessage(msg: ChatMessage): void {
    const callId = this.callIdOf(msg);
    const meeting = Object.entries(this.activeGroupCalls).find(([, m]) => String(m.callId) === callId);
    if (!callId || !meeting) {
      this.alertService.info('This call has ended.');
      return;
    }
    void this.calls.joinMeeting(meeting[0], callId);
  }

  addReaction(messageId: string, emoji: string): void {
    this.socketService.sendReaction(messageId, emoji, this.conversationId);
  }

  // ================================================================ scrolling / jump to message

  /** Track "near bottom" outside Angular; only re-enter when the flag flips. */
  private attachScrollWatcher(): void {
    this.detachScroll?.();
    const el = this.scrollContainer?.nativeElement;
    if (!el) {
      return;
    }
    const handler = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (near !== this.isNearBottom) {
        this.zone.run(() => {
          this.isNearBottom = near;
          if (near) {
            this.unseenBelow = 0;
          }
        });
      }
    };
    this.zone.runOutsideAngular(() => el.addEventListener('scroll', handler, { passive: true }));
    this.detachScroll = () => el.removeEventListener('scroll', handler);
  }

  scrollToBottom(instant = false): void {
    setTimeout(() => {
      const el = this.scrollContainer?.nativeElement;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
        this.unseenBelow = 0;
      }
    }, 50);
  }

  private highlight(messageId: string): void {
    const element = document.getElementById('message-' + messageId);
    if (!element) {
      return;
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlightedMessageId = messageId;
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
    }
    this.highlightTimer = setTimeout(() => {
      this.highlightedMessageId = null;
      this.searchHitId = null;
    }, 3000);
  }

  /**
   * Scroll to a message (reply quote or search result). If it is older than what is loaded,
   * ask the server how far back it is and load exactly enough history in one request.
   */
  async jumpToMessage(messageId: string, term = ''): Promise<void> {
    if (!messageId) {
      return;
    }
    this.searchTerm = term;
    this.searchHitId = term ? messageId : null;
    if (this.isMobileView && this.rightPanel === 'search') {
      this.rightPanel = 'none';
    }
    if (this.messageArray.some((m) => m._id === messageId)) {
      setTimeout(() => this.highlight(messageId));
      return;
    }
    const conversationId = this.conversationId;
    const seq = this.conversationSeq;
    this.isFetchingOldMessages = true;
    try {
      const newer = await this.chatActions.position(conversationId, messageId);
      const limit = Math.ceil((newer + 1 + 5) / this.pageSize) * this.pageSize;
      const res = await firstValueFrom(this.userService.getMessages(conversationId, 1, limit));
      if (seq !== this.conversationSeq) {
        return;
      }
      const data: ChatMessage[] = res.data || [];
      this.messageArray = this.withSenderNames(data);
      data.forEach((m) => this.seenMessageIds.add(m._id));
      this.page = limit / this.pageSize;
      this.hasMoreMessages = data.length === limit;
      this.cdr.detectChanges();
      setTimeout(() => this.highlight(messageId), 60);
    } catch (error: any) {
      this.alertService.info(error?.message || 'That message is no longer available.');
    } finally {
      setTimeout(() => (this.isFetchingOldMessages = false), 600);
    }
  }

  onSearchJump(event: { messageId: string; term: string }): void {
    void this.jumpToMessage(event.messageId, event.term);
  }

  // ================================================================ sending

  typing(): void {
    if (this.conversationId) {
      this.socketService.typing(this.conversationId, this.myUserId);
    }
  }

  setReply(message: ChatMessage): void {
    this.replyingTo = message;
    this.composer?.focus();
  }

  cancelReply(): void {
    this.replyingTo = null;
  }

  private async send(draft: MessageDraft): Promise<boolean> {
    if (!this.conversationId) {
      return false;
    }
    try {
      const files = draft.files?.length ? draft.files : draft.file ? [draft.file] : [];
      if (files.length) {
        this.uploads.enqueue(this.conversationId, files, { caption: draft.text, replyToId: draft.replyToId, mentionIds: draft.mentionIds });
      } else {
        await this.sender.send(this.conversationId, draft);
      }
      this.replyingTo = null;
      this.socketService.stopTyping(this.myUserId);
      this.scrollToBottom();
      return true;
    } catch {
      // The error interceptor already showed why the upload failed
      return false;
    }
  }

  // ================================================================ message actions

  openPreview(event: MediaOpenEvent): void {
    const { url, type } = event;
    if (type === 'audio') {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const isPdf = type === 'pdf' || type === 'application/pdf';
    this.previewUrl = url;
    this.previewType = isPdf ? 'pdf' : type;
    this.previewPdf = isPdf ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;
    this.previewDownloadUrl = event.downloadUrl || null;
  }

  // ================================================================ uploads / drag & drop

  cancelUpload(job: UploadJob): void {
    this.uploads.cancel(job.id);
  }

  retryUpload(job: UploadJob): void {
    this.uploads.retry(job.id);
  }

  uploadIcon(job: UploadJob): string {
    return fileIconFor(job.file.name, job.file.type.split('/')[0]);
  }

  trackByJob(_: number, job: UploadJob): string {
    return job.id;
  }

  private hasFiles(event: DragEvent): boolean {
    return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
  }

  onDragEnter(event: DragEvent): void {
    if (!this.hasFiles(event) || this.blockedByMe) {
      return;
    }
    event.preventDefault();
    this.dragDepth++;
    this.dragActive = true;
  }

  onDragOver(event: DragEvent): void {
    if (this.hasFiles(event) && !this.blockedByMe) {
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'copy';
    }
  }

  onDragLeave(event: DragEvent): void {
    if (!this.hasFiles(event)) {
      return;
    }
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (!this.dragDepth) {
      this.dragActive = false;
    }
  }

  onDrop(event: DragEvent): void {
    if (!this.hasFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    const files = event.dataTransfer?.files;
    if (files?.length && !this.blockedByMe) {
      this.composer?.addFiles(files);
    }
  }

  closePreview(): void {
    this.previewPdf = null;
    this.previewUrl = null;
    this.previewType = null;
    this.previewDownloadUrl = null;
  }

  private copyFailed(error: unknown): void {
    console.warn('[chat] copy failed', error);
    this.alertService.error("We couldn't copy that. Your browser may not allow clipboard access here.");
  }

  onCopyMessage(msg: ChatMessage): void {
    if (msg.type === 'image') {
      fetch(msg.fileUrl!)
        .then((res) => res.blob())
        .then((blob) => {
          if (blob.type === 'image/jpeg') {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = () => {
              canvas.width = img.width;
              canvas.height = img.height;
              ctx?.drawImage(img, 0, 0);
              URL.revokeObjectURL(img.src);
              canvas.toBlob((pngBlob) => {
                if (pngBlob) {
                  navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
                    .then(() => this.alertService.info('Image copied to clipboard!'))
                    .catch((error) => this.copyFailed(error));
                }
              }, 'image/png');
            };
            img.src = URL.createObjectURL(blob);
          } else {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
              .then(() => this.alertService.info('Image copied to clipboard!'))
              .catch((error) => this.copyFailed(error));
          }
        })
        .catch((error) => this.copyFailed(error));
    } else {
      const messageContent = msg.type === 'text' ? msg.content || '' : msg.fileUrl || msg.content || '';
      navigator.clipboard.writeText(messageContent)
        .then(() => this.alertService.info('Message copied!'))
        .catch((error) => this.copyFailed(error));
    }
  }

  deleteMessage(message: ChatMessage): void {
    this.alertService.confirm({ title: 'Delete this message?', text: "You won't be able to see this message again!", confirmText: 'Delete', cancelText: 'Cancel', danger: true }).then((confirmed) => {
      if (confirmed) {
        this.userService.deleteMessage(message._id).subscribe({
          next: (res) => {
            this.messageArray = this.messageArray.filter(msg => msg._id !== message._id);
            this.alertService.success(`${res.message || 'Message deleted successfully!'}`);
          },
          error: () => undefined, // The error interceptor already showed a friendly message
        });
      }
    });
  }

  forwardMessage(message: ChatMessage): void {
    this.forwardSource = message;
    this.forwardSearch = '';
    this.forwardModalRef = this.modalService.open(this.forwardModalTpl, { centered: true, scrollable: true, windowClass: 'app-modal' });
  }

  get forwardTargets(): SidebarItem[] {
    const q = this.forwardSearch.trim().toLowerCase();
    const all: SidebarItem[] = [
      ...this.chatData.filter((c) => c.receiver).map((c) => ({
        kind: 'direct' as const, key: `d:${c._id}`, conversationId: c._id, title: c.receiver.username, avatar: c.receiver.avatar,
        preview: '', previewIsMine: false, previewRead: false, unread: 0, hasActiveCall: false, source: c,
      })),
      ...this.groupChatData.map((g) => ({
        kind: 'group' as const, key: `g:${g._id}`, conversationId: g._id, title: g.groupName, avatar: g.groupAvatar,
        preview: `${g.members?.length || 0} participants`, previewIsMine: false, previewRead: false, unread: 0, hasActiveCall: false, source: g,
      })),
    ];
    return q ? all.filter((i) => (i.title || '').toLowerCase().includes(q)) : all;
  }

  /** Re-sends the same content/file to another conversation through the existing sendMessage event. */
  confirmForward(target: SidebarItem): void {
    const source = this.forwardSource;
    if (!source || !target.conversationId || this.forwardSending) {
      return;
    }
    this.forwardSending = true;
    this.socketService.sendMessage({
      user: this.sender.currentUserPayload(),
      conversationId: target.conversationId,
      content: source.content || '',
      type: source.type,
      // The server copies content + attachment from the original (and checks you can see it)
      forwardOf: source._id,
    });
    this.forwardSending = false;
    this.forwardModalRef?.close();
    this.forwardSource = null;
    this.alertService.success(`Forwarded to ${target.title}`);
  }

  // ================================================================ profile / group modals

  async onLogoutClick(): Promise<void> {
    this.socketService.disconnectSocket();
    await this.authService.logout();
    this.alertService.success('Signed out.');
  }

  /** Own profile saved in the sidebar Profile view. */
  onProfileSaved(user: ChatUser): void {
    this.onUserUpdated({ _id: user._id, username: user.username, avatar: user.avatar || '', bio: user.bio });
  }

  /** Someone (possibly me) changed their name / picture: patch every place that shows them. */
  private onUserUpdated(data: { _id: string; username: string; avatar: string; bio?: string } | undefined): void {
    const userId = String(data?._id || '');
    if (!userId || !data) {
      return;
    }
    const apply = (u: any) => {
      if (u && String(u._id) === userId) {
        u.username = data.username;
        u.avatar = data.avatar;
        if (data.bio !== undefined) {
          u.bio = data.bio;
        }
      }
    };
    [...this.chatData, ...this.archivedChats].forEach((c: any) => {
      apply(c.receiver);
      apply(c.sender);
    });
    this.users.forEach(apply);
    [...this.groupChatData, ...this.archivedGroups].forEach((g) => (g.members || []).forEach(apply));
    this.groupMembers.forEach(apply);
    this.messageArray.forEach((m: any) => apply(m.user));
    if (userId === this.myUserId) {
      this.myUsername = data.username;
      this.loginUserProfile = data.avatar;
      this.authService.updateLoggedInUser({ username: data.username, avatar: data.avatar });
    }
    if (!this.isGroupChat && this.receiverId === userId) {
      this.peerName = data.username;
      this.peerAvatar = data.avatar;
    }
    this.rebuildSidebar();
  }

  openCreateGroup(): void {
    this.groupForm.reset({ groupName: '', groupDescription: '', groupMembers: [], groupAvatar: null });
    this.selectedMembers = [];
    this.clearGroupPhoto();
    this.memberSearch = '';
    if (!this.users.length) {
      this.loadUsers();
    }
    this.groupModalRef = this.modalService.open(this.groupModalTpl, { centered: true, scrollable: true, windowClass: 'app-modal' });
  }

  /** Optional group photo: same rules as the server (JPG/PNG/GIF/WebP, up to 5 MB). */
  onFileSelected(event: Event): void {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) {
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
      this.alertService.warning('Please choose a JPG, PNG, GIF or WebP image.');
      this.clearGroupPhoto(target);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.alertService.warning('Group photos can be up to 5 MB.');
      this.clearGroupPhoto(target);
      return;
    }
    this.clearGroupPhoto();
    this.selectedFile = file;
    this.selectedFilePreview = URL.createObjectURL(file);
  }

  clearGroupPhoto(input?: HTMLInputElement): void {
    if (this.selectedFilePreview) {
      URL.revokeObjectURL(this.selectedFilePreview);
    }
    this.selectedFile = null;
    this.selectedFilePreview = null;
    if (input) {
      input.value = '';
    }
  }

  get memberCandidates(): any[] {
    const q = this.memberSearch.trim().toLowerCase();
    return q ? this.users.filter((u) => (u.username || '').toLowerCase().includes(q)) : this.users;
  }

  toggleMember(user: any): void {
    if (this.isSelected(user)) {
      this.removeUser(user);
    } else {
      this.selectUser(user);
    }
  }

  selectUser(user: any): void {
    if (!this.selectedMembers.find(u => u._id === user._id)) {
      this.selectedMembers.push(user);
      this.groupForm.get('groupMembers')?.setValue(this.selectedMembers.map(u => u._id));
    }
  }

  removeUser(user: any): void {
    this.selectedMembers = this.selectedMembers.filter(u => u._id !== user._id);
    this.groupForm.get('groupMembers')?.setValue(this.selectedMembers.map(u => u._id));
  }

  isSelected(user: any): boolean {
    return !!this.selectedMembers.find(u => u._id === user._id);
  }

  createGroup(): void {
    this.groupForm.markAllAsTouched();
    if (this.groupForm.invalid || this.selectedMembers.length < 2) {
      this.alertService.error('Please provide a group name and select at least 2 members.');
      return;
    }
    const formData = new FormData();
    formData.append('groupName', this.groupForm.get('groupName')?.value);
    formData.append('groupAdmin', this.myUserId);
    formData.append('groupMembers', JSON.stringify(this.groupForm.get('groupMembers')?.value));
    formData.append('groupDescription', this.groupForm.get('groupDescription')?.value || '');
    if (this.selectedFile) {
      formData.append('image', this.selectedFile);
    }

    this.creatingGroup = true;
    this.userService.createGroup(formData).subscribe({
      next: () => {
        this.creatingGroup = false;
        this.alertService.success('Group created successfully!');
        this.loadGroupConversations();
        this.groupModalRef?.close();
        this.groupForm.reset();
        this.selectedMembers = [];
        this.clearGroupPhoto();
      },
      error: (error) => {
        this.creatingGroup = false;
        // The error interceptor already showed a friendly message
      }
    });
  }

  hasError(controlName: string, errorName: string): boolean {
    return this.groupForm.controls[controlName].touched && this.groupForm.controls[controlName].hasError(errorName);
  }

  // ================================================================ calls

  private listLoaded(key: 'chats' | 'groups' | 'archivedChats' | 'archivedGroups'): void {
    this.loadedLists.add(key);
    this.shareConversations();
    void this.tryOpenDeepLink();
  }

  private async tryOpenDeepLink(): Promise<void> {
    const link = this.pendingDeepLink;
    if (!link || this.loadedLists.size < 4) {
      return;
    }
    this.pendingDeepLink = null;
    // Consume the link so a refresh / back doesn't re-open it (call params are kept)
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { c: null, user: null, m: null, q: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });

    const group = [...this.groupChatData, ...this.archivedGroups].find((g) => String(g._id) === link.conversationId);
    const direct = [...this.chatData, ...this.archivedChats].find((c) =>
      (link.conversationId && String(c._id) === link.conversationId) ||
      (link.userId && String(c.receiver?._id) === link.userId));

    if (group) {
      if (this.conversationId !== String(group._id)) {
        this.openGroupConversation(group);
      }
    } else if (direct) {
      if (this.conversationId !== String(direct._id)) {
        const r = direct.receiver;
        this.startOrResumeChat(r.username, r.avatar, r.isOnline, direct._id, r._id, r.lastSeen);
      }
    } else if (link.userId) {
      const user = this.users.find((u) => String(u._id) === link.userId)
        || (await firstValueFrom(this.userService.getUserById(link.userId)).then((r) => r.data).catch(() => null));
      if (!user) {
        this.alertService.info("We couldn't find that person.");
        return;
      }
      this.startOrResumeChat(user.username, user.avatar, !!user.isOnline, '', String(user._id), user.lastSeen as any);
      return;
    } else {
      this.alertService.info("This chat isn't available any more.");
      return;
    }

    if (link.messageId) {
      // Let the first page land, then load back to the message and highlight it
      const start = Date.now();
      while ((this.messagesLoading || !this.conversationId) && Date.now() - start < 8000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await this.jumpToMessage(link.messageId, link.term || '');
    }
  }

  /** Called once the first history page of a chat is shown: place the "New messages" divider. */
  private placeUnreadDivider(): void {
    const count = this.openingUnread;
    this.openingUnread = 0;
    if (!count) {
      this.firstUnreadId = null;
      return;
    }
    const fromOthers = this.messageArray.filter((m) => !this.isMine(m) && m.type !== 'system');
    this.firstUnreadId = fromOthers.length ? fromOthers[Math.max(0, fromOthers.length - Math.min(count, 99))]._id : null;
  }

  // ================================================================ receipts / edit / pin / save

  private members(): string[] {
    if (this.isGroupChat) {
      return (this.groupMembers || []).map((m: any) => String(m._id));
    }
    return [this.myUserId, this.receiverId].filter(Boolean).map(String);
  }

  private statusOf(msg: ChatMessage): 'sent' | 'delivered' | 'seen' {
    const author = String(msg.user?._id || msg.userId || '');
    const others = this.members().filter((id) => id !== author);
    if (!others.length) {
      return msg.status || 'sent';
    }
    const t = new Date(msg.createdAt).getTime();
    const at = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0);
    if (others.every((id) => at(this.receipts.get(id)?.readAt) >= t)) {
      return 'seen';
    }
    if (others.every((id) => Math.max(at(this.receipts.get(id)?.deliveredAt), at(this.receipts.get(id)?.readAt)) >= t)) {
      return 'delivered';
    }
    // Never downgrade what the server already reported
    return msg.status === 'seen' || msg.status === 'delivered' ? msg.status : 'sent';
  }

  /** Re-derive ticks of my messages from the members' cursors (new objects only where it changed). */
  private refreshStatuses(): void {
    if (!this.receipts.size) {
      return;
    }
    let changed = false;
    const next = this.messageArray.map((m) => {
      if (!this.isMine(m)) {
        return m;
      }
      const status = this.statusOf(m);
      if (status === m.status) {
        return m;
      }
      changed = true;
      return { ...m, status, isRead: status === 'seen' };
    });
    if (changed) {
      this.messageArray = next;
    }
  }

  private onReceipts(data: { conversationId: string; userId: string; readAt?: string; deliveredAt?: string }): void {
    const conversationId = String(data?.conversationId || '');
    const userId = String(data?.userId || '');
    if (!conversationId || !userId) {
      return;
    }
    // Sidebar ticks: 1:1 last message read by the other person
    if (userId !== this.myUserId && data.readAt) {
      const entry = [...this.chatData, ...this.archivedChats].find((c) => String(c._id) === conversationId);
      if (entry?.lastMessage && String(entry.lastMessage.userId) === this.myUserId
        && new Date(data.readAt).getTime() >= new Date(entry.lastMessage.createdAt).getTime()) {
        entry.lastMessage = { ...entry.lastMessage, isRead: true, status: 'seen' };
        this.rebuildSidebar();
      }
    }
    if (conversationId !== this.conversationId) {
      return;
    }
    const current = this.receipts.get(userId) || { userId, readAt: null, deliveredAt: null };
    const later = (a: string | null, b?: string) => (b && (!a || new Date(b) > new Date(a)) ? b : a);
    this.receipts.set(userId, { userId, readAt: later(current.readAt, data.readAt), deliveredAt: later(current.deliveredAt, data.deliveredAt) });
    this.refreshStatuses();
  }

  private onMessageUpdated(data: { conversationId: string; messageId: string; content: string; editedAt: string; mentions: string[] }): void {
    if (String(data?.conversationId) === this.conversationId) {
      this.messageArray = this.messageArray.map((m) => (m._id === data.messageId
        ? { ...m, content: data.content, editedAt: data.editedAt, mentions: data.mentions || [] }
        : m));
    }
    const lists = [this.chatData, this.groupChatData, this.archivedChats, this.archivedGroups];
    let touched = false;
    for (const list of lists) {
      const entry = list.find((c) => String(c._id) === String(data?.conversationId));
      if (entry?.lastMessage && String(entry.lastMessage._id) === String(data.messageId)) {
        entry.lastMessage = { ...entry.lastMessage, content: data.content };
        touched = true;
      }
    }
    if (touched) {
      this.rebuildSidebar();
    }
  }

  private onMessageDeleted(data: { conversationId: string; messageId: string }): void {
    if (String(data?.conversationId) === this.conversationId) {
      this.messageArray = this.messageArray.filter((m) => m._id !== data.messageId);
      if (this.editing?.id === data.messageId) {
        this.editing = null;
      }
    }
    // The list preview may now be stale: refresh once
    const lists = [this.chatData, this.groupChatData, this.archivedChats, this.archivedGroups];
    if (lists.some((list) => list.some((c) => String(c._id) === String(data?.conversationId) && String(c.lastMessage?._id) === String(data.messageId)))) {
      this.scheduleListReload();
    }
  }

  private setPins(pins: PinnedMessage[]): void {
    this.pins = pins;
    this.pinnedIds = new Set(pins.map((p) => String(p.messageId)));
    if (pins.length <= 1) {
      this.pinsExpanded = false;
    }
  }

  pinPreview(pin: PinnedMessage): string {
    return pin.type === 'text' || !pin.type ? pin.content : pin.fileName || messagePreview({ content: pin.content, type: pin.type });
  }

  onEditMessage(msg: ChatMessage): void {
    this.cancelReply();
    this.editing = { id: msg._id, text: msg.content || '', mentionIds: msg.mentions || [] };
  }

  /** ↑ in an empty composer edits my last text message. */
  editLastMessage(): void {
    const last = [...this.messageArray].reverse().find((m) => this.isMine(m) && m.type === 'text');
    if (last) {
      this.onEditMessage(last);
    }
  }

  cancelEdit(): void {
    this.editing = null;
  }

  private async submitEdit(id: string, text: string, mentionIds: string[]): Promise<boolean> {
    const original = this.messageArray.find((m) => m._id === id);
    if (original && (original.content || '').trim() === text.trim()) {
      this.editing = null;
      return true;
    }
    try {
      await this.chatActions.editMessage(id, text, mentionIds);
      this.editing = null;
      return true;
    } catch (error: any) {
      this.alertService.error(error?.message || "We couldn't edit the message. Please try again.");
      return false;
    }
  }

  async onTogglePin(msg: ChatMessage): Promise<void> {
    const pinned = !this.pinnedIds.has(msg._id);
    try {
      const res = await this.chatActions.setPinned(msg._id, pinned);
      this.setPins(res.pins || []);
      this.alertService.success(pinned ? 'Message pinned' : 'Message unpinned');
    } catch (error: any) {
      this.alertService.error(error?.message || "We couldn't update the pin. Please try again.");
    }
  }

  async unpin(pin: PinnedMessage): Promise<void> {
    try {
      const res = await this.chatActions.setPinned(pin.messageId, false);
      this.setPins(res.pins || []);
    } catch (error: any) {
      this.alertService.error(error?.message || "We couldn't update the pin. Please try again.");
    }
  }

  async onToggleSave(msg: ChatMessage): Promise<void> {
    const saved = !msg.saved;
    this.messageArray = this.messageArray.map((m) => (m._id === msg._id ? { ...m, saved } : m));
    try {
      await this.chatActions.setSaved(msg._id, saved);
      this.alertService.success(saved ? 'Saved' : 'Removed from saved', saved ? { action: { label: 'View saved', handler: () => this.router.navigate(['/saved']) } } : undefined);
    } catch {
      this.messageArray = this.messageArray.map((m) => (m._id === msg._id ? { ...m, saved: !saved } : m));
    }
  }

  onCopyLink(msg: ChatMessage): void {
    const url = `${window.location.origin}/chat?c=${encodeURIComponent(this.conversationId)}&m=${encodeURIComponent(msg._id)}`;
    navigator.clipboard.writeText(url)
      .then(() => this.alertService.info('Link copied'))
      .catch(() => this.alertService.error("We couldn't copy the link."));
  }

  /** Display names of the people a message mentions. */
  mentionNames(msg: ChatMessage): string[] {
    if (!msg.mentions?.length) {
      return [];
    }
    return msg.mentions
      .map((id) => this.mentionCandidates.find((u) => String(u._id) === String(id))?.username
        || (String(id) === this.myUserId ? this.myUsername : ''))
      .filter(Boolean);
  }

  /** Who can be @mentioned in the open chat. */
  get mentionCandidates(): ChatUser[] {
    if (this.isGroupChat) {
      return (this.groupMembers || []).filter((m: any) => String(m._id) !== this.myUserId) as ChatUser[];
    }
    return this.receiverId ? [{ _id: this.receiverId, username: this.peerName, avatar: this.peerAvatar } as ChatUser] : [];
  }

  private shareConversations(): void {
    this.calls.setConversations([...this.chatData, ...this.archivedChats], [...this.groupChatData, ...this.archivedGroups]);
  }

  /** One-time offer to turn on call notifications (the browser only asks after a click). */
  get showNotificationPrompt(): boolean {
    return this.sidebarMode === 'chats' && this.callNotifications.permission === 'default' && !this.callNotifications.promptDismissed;
  }

  async enableCallNotifications(): Promise<void> {
    const result = await this.callNotifications.requestPermission();
    if (result === 'denied') {
      this.alertService.info('Notifications are blocked for this site. You can allow them in your browser site settings.');
    }
    this.callNotifications.dismissPrompt();
    this.cdr.markForCheck();
  }

  dismissNotificationPrompt(): void {
    this.callNotifications.dismissPrompt();
  }

  get currentMeeting(): ActiveGroupMeeting | null {
    return this.calls.meetingFor(this.conversationId);
  }

  /** In this conversation's call right now (shown as "Return to call"). */
  get inCallHere(): boolean {
    return this.calls.inCall(this.conversationId);
  }

  checkForActiveGroupCall(): void {
    if (this.isGroupChat && this.conversationId) {
      void this.calls.refreshMeeting(this.conversationId);
    }
  }

  startVideoCall(): void {
    if (!this.conversationId) {
      this.alertService.warning('Open the chat before starting a call');
      return;
    }
    // Use mediasoup SFU (same as group) — P2P fails across networks without TURN
    this.calls.startCall(this.conversationId, 'video', 'ring');
  }

  startAudioCall(): void {
    if (!this.conversationId) {
      this.alertService.warning('Open the chat before starting a call');
      return;
    }
    this.calls.startCall(this.conversationId, 'audio', 'ring');
  }

  /** Groups start meetings only ("Meet now"); joining an active one goes through the lobby. */
  startMeetNow(conversationId: string): void {
    this.calls.startCall(conversationId, 'video', 'meetNow');
  }

  joinCurrentMeeting(): void {
    if (this.conversationId) {
      void this.calls.joinMeeting(this.conversationId);
    }
  }

  returnToCall(): void {
    this.calls.restore();
  }

  // ================================================================ formatting

  formatTimestamp(dateString: string | undefined): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }
    if ((now.getTime() - date.getTime()) / 86400000 < 7) {
      return date.toLocaleDateString(undefined, { weekday: 'short' });
    }
    return date.toLocaleDateString();
  }

  private formatLastSeen(value: Date | string): string {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return '';
    }
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === now.toDateString()) {
      return `today at ${time}`;
    }
    if (date.toDateString() === yesterday.toDateString()) {
      return `yesterday at ${time}`;
    }
    return `${date.toLocaleDateString()} at ${time}`;
  }

  get contactsForPanel(): ChatUser[] {
    return this.users as ChatUser[];
  }
}
