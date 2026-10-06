import {
  AfterViewInit,
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
import Swal from 'sweetalert2';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { environment } from 'src/environments/environment';
import { UserService } from 'src/app/core/services/user.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { CallHandoffService } from 'src/app/core/services/call-handoff.service';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';
import { MessageSenderService } from 'src/app/core/services/message-sender.service';
import { CHAT_CONFIG, ChatConfig } from 'src/app/core/config/chat.config';
import { ChatMessage, ChatState, ChatUser, GroupSummary, MessageDraft, messagePreview } from 'src/app/core/interfaces/chat';
import { CallLaunch, CallMember } from '../group-call/call.models';
import { IncomingCall } from './incoming-call/incoming-call.component';
import { ReplyPreview } from './message-composer/message-composer.component';

export interface ActiveGroupMeeting {
  callId: string;
  callType: 'audio' | 'video';
  mode: 'ring' | 'meetNow';
}

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
  styleUrls: ['./chat.component.scss']
})
export class ChatComponent implements OnInit, AfterViewInit, OnDestroy {
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

  // ---- right panels / search jump
  rightPanel: RightPanel = 'none';
  highlightedMessageId: string | null = null;
  searchHitId: string | null = null;
  searchTerm = '';

  // ---- media preview
  previewUrl: string | null = null;
  previewType: string | null = null;

  // ---- calls
  activeGroupCalls: { [groupId: string]: ActiveGroupMeeting } = {};
  activeCall: CallLaunch | null = null;
  callMinimized = false;
  incomingCall: IncomingCall | null = null;

  // ---- layout
  isMobileView = false;
  showChatPane = false;

  // ---- group creation
  groupForm!: FormGroup;
  selectedMembers: any[] = [];
  selectedFile: File | null = null;
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
  @ViewChild('topElement', { static: false }) topElement?: ElementRef<HTMLElement>;
  @ViewChild('groupModal', { static: true }) groupModalTpl!: TemplateRef<any>;
  @ViewChild('forwardModal', { static: true }) forwardModalTpl!: TemplateRef<any>;

  private subs = new Subscription();
  private callStartedSub?: Subscription;
  private callStartTimer: ReturnType<typeof setTimeout> | null = null;
  private chatWindowObserver: IntersectionObserver | null = null;
  private seenMessageIds = new Set<string>();
  private markReadTimer: ReturnType<typeof setTimeout> | null = null;
  private listReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private groupModalRef: NgbModalRef | null = null;
  private forwardModalRef: NgbModalRef | null = null;
  private pendingUrlCall: { callId: string; groupId: string; callType: 'audio' | 'video'; join: boolean } | null = null;
  private listsLoaded = { chats: false, groups: false };
  private detachScroll: (() => void) | null = null;
  private conversationSeq = 0;

  private readonly onResize = () => this.checkScreenSize();
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible' && this.conversationId) {
      this.scheduleMarkRead();
    }
  };

  /** Bound for the composer component (keeps `this`). */
  readonly sendDraft = (draft: MessageDraft): Promise<boolean> => this.send(draft);

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
    private callHandoff: CallHandoffService,
    private chatActions: ChatActionsService,
    private sender: MessageSenderService,
    private zone: NgZone,
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

    this.setupCallNotifications();

    // `/chat?call=…` → open (or after a refresh, rejoin) that call
    this.subs.add(this.route.queryParamMap.subscribe((params) => {
      const callId = params.get('call');
      const groupId = params.get('g');
      if (!callId || !groupId || this.activeCall?.callId === callId) {
        return;
      }
      this.pendingUrlCall = {
        callId,
        groupId,
        callType: params.get('t') === 'audio' ? 'audio' : 'video',
        join: params.get('join') === '1',
      };
      this.tryOpenPendingCall();
    }));

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.onResize);
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.callStartedSub?.unsubscribe();
    if (this.callStartTimer) {
      clearTimeout(this.callStartTimer);
    }
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
    if (this.previewUrl) {
      this.closePreview();
    } else if (this.replyingTo) {
      this.cancelReply();
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
      error: (error) => this.alertService.error(`Failed to load users: ${error || 'Unknown error'}`),
    });
  }

  loadChatConversations(): void {
    this.listLoading = true;
    this.userService.getUserConversations().subscribe({
      next: (response) => {
        this.listLoading = false;
        this.chatData = response.data || [];
        this.listsLoaded.chats = true;
        this.rebuildSidebar();
        this.tryOpenPendingCall();
      },
      error: (error) => {
        this.listLoading = false;
        this.listsLoaded.chats = true;
        this.alertService.error(`Failed to load conversations: ${error || 'Unknown error'}`);
        this.tryOpenPendingCall();
      }
    });
  }

  private loadGroupConversations(): void {
    this.userService.getUserGropuConversations().subscribe({
      next: (response) => {
        this.groupChatData = response.data || [];
        this.listsLoaded.groups = true;
        this.syncOpenGroupFromList();
        this.rebuildSidebar();
        this.tryOpenPendingCall();
      },
      error: (error) => {
        this.listsLoaded.groups = true;
        this.alertService.error(`Failed to load group conversations: ${error || 'Unknown error'}`);
        this.tryOpenPendingCall();
      }
    });
  }

  private loadArchived(): void {
    this.userService.getUserConversations(true).subscribe({
      next: (res) => {
        this.archivedChats = res.data || [];
        this.rebuildSidebar();
      },
      error: () => undefined,
    });
    this.userService.getUserGropuConversations(true).subscribe({
      next: (res) => {
        this.archivedGroups = res.data || [];
        this.rebuildSidebar();
      },
      error: () => undefined,
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
          this.alertService.error('Failed to create or retrieve conversation.');
        }
      },
      error: (error) => this.alertService.error(`Failed to create or retrieve conversation: ${error || 'Unknown error'}`),
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
    this.loadMessages(this.conversationId);
    this.socketService.markMessagesAsRead(this.conversationId);
    const id = this.conversationId;
    this.chatActions.state(id).then((state) => {
      if (this.conversationId === id) {
        this.chatState = state;
      }
    }).catch(() => undefined);
  }

  private resetConversationState(): void {
    this.conversationSeq++;
    this.cancelReply();
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
        }
        this.messagesLoading = false;
        this.cdr.detectChanges();
        this.attachScrollWatcher();
        this.setupInfiniteScroll();
        this.scrollToBottom(true);
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
        error: (error) => this.alertService.error(`Error fetching user: ${error || 'Unknown error'}`),
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
        u.isOnline = !!data.isOnline;
        if (data.lastSeen) {
          u.lastSeen = data.lastSeen;
        }
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
    if (this.isOnline) {
      return 'online';
    }
    return this.lastSeen ? `last seen ${this.formatLastSeen(this.lastSeen)}` : '';
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
      this.alertService.error(error?.message || 'Could not update the chat');
    }
  }

  async clearChat(): Promise<void> {
    const confirm = await Swal.fire({
      title: 'Clear this chat?',
      text: 'Messages will be removed for you only. Other participants will still see them.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Clear chat',
      confirmButtonColor: '#dc2626',
    });
    if (!confirm.isConfirmed) {
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
      this.alertService.error(error?.message || 'Could not clear the chat');
    }
  }

  async toggleBlock(): Promise<void> {
    if (this.isGroupChat || !this.receiverId) {
      return;
    }
    const block = !this.blockedByMe;
    if (block) {
      const confirm = await Swal.fire({
        title: `Block ${this.peerName}?`,
        text: "Blocked contacts can't message or call you. They won't be notified.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Block',
        confirmButtonColor: '#dc2626',
      });
      if (!confirm.isConfirmed) {
        return;
      }
    }
    try {
      await this.chatActions.setBlocked(this.receiverId, block);
      this.chatState = { ...(this.chatState as ChatState), blockedByMe: block };
      this.alertService.success(block ? `${this.peerName} blocked` : `${this.peerName} unblocked`);
    } catch (error: any) {
      this.alertService.error(error?.message || 'Could not update the block');
    }
  }

  async leaveGroup(): Promise<void> {
    if (!this.isGroupChat) {
      return;
    }
    const confirm = await Swal.fire({
      title: `Exit "${this.groupname}"?`,
      text: 'You will stop receiving messages from this group.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Exit group',
      confirmButtonColor: '#dc2626',
    });
    if (!confirm.isConfirmed) {
      return;
    }
    const groupId = this.conversationId;
    try {
      await this.chatActions.leaveGroup(groupId);
      this.onGroupRemoved({ groupId, reason: 'left' });
      this.alertService.success('You left the group');
    } catch (error: any) {
      this.alertService.error(error?.message || 'Could not leave the group');
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
    this.openCall(this.buildLaunch(meeting[0], callId, meeting[1].callType, { prejoin: this.isGroupConversation(meeting[0]) }));
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
  }

  cancelReply(): void {
    this.replyingTo = null;
  }

  private async send(draft: MessageDraft): Promise<boolean> {
    if (!this.conversationId) {
      return false;
    }
    try {
      await this.sender.send(this.conversationId, draft);
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

  openPreview(url: string, type: string): void {
    if (type === 'pdf' || type === 'application/pdf' || type === 'audio') {
      window.open(url, '_blank', 'noopener');
      return;
    }
    this.previewUrl = url;
    this.previewType = type;
  }

  closePreview(): void {
    this.previewUrl = null;
    this.previewType = null;
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
                    .catch((error) => this.alertService.error(`Failed to copy image to clipboard: ${error || 'Unknown error'}`));
                }
              }, 'image/png');
            };
            img.src = URL.createObjectURL(blob);
          } else {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
              .then(() => this.alertService.info('Image copied to clipboard!'))
              .catch((error) => this.alertService.error(`Failed to copy image to clipboard: ${error || 'Unknown error'}`));
          }
        })
        .catch((error) => this.alertService.error(`Error fetching the image: ${error || 'Unknown error'}`));
    } else {
      const messageContent = msg.type === 'text' ? msg.content || '' : msg.fileUrl || msg.content || '';
      navigator.clipboard.writeText(messageContent)
        .then(() => this.alertService.info('Message copied!'))
        .catch((error) => this.alertService.error(`Failed to copy message: ${error || 'Unknown error'}`));
    }
  }

  deleteMessage(message: ChatMessage): void {
    Swal.fire({
      title: 'Delete this message?',
      text: "You won't be able to see this message again!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel'
    }).then((result) => {
      if (result.isConfirmed) {
        this.userService.deleteMessage(message._id).subscribe({
          next: (res) => {
            this.messageArray = this.messageArray.filter(msg => msg._id !== message._id);
            this.alertService.success(`${res.message || 'Message deleted successfully!'}`);
          },
          error: (error) => this.alertService.error(`${error || 'Unknown error'}`),
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

  onLogoutClick(): void {
    this.socketService.disconnectSocket();
    this.authService.logout();
    this.alertService.success('Logout Successfully.');
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
    this.selectedFile = null;
    this.memberSearch = '';
    if (!this.users.length) {
      this.loadUsers();
    }
    this.groupModalRef = this.modalService.open(this.groupModalTpl, { centered: true, scrollable: true, windowClass: 'app-modal' });
  }

  onFileSelected(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length) {
      this.selectedFile = target.files[0];
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
    if (!this.selectedFile) {
      // The API requires an avatar image for new groups
      this.alertService.error('Please choose a group photo.');
      return;
    }

    const formData = new FormData();
    formData.append('groupName', this.groupForm.get('groupName')?.value);
    formData.append('groupAdmin', this.myUserId);
    formData.append('groupMembers', JSON.stringify(this.groupForm.get('groupMembers')?.value));
    formData.append('groupDescription', this.groupForm.get('groupDescription')?.value || '');
    formData.append('image', this.selectedFile);

    this.creatingGroup = true;
    this.userService.createGroup(formData).subscribe({
      next: () => {
        this.creatingGroup = false;
        this.alertService.success('Group created successfully!');
        this.loadGroupConversations();
        this.groupModalRef?.close();
        this.groupForm.reset();
        this.selectedMembers = [];
        this.selectedFile = null;
      },
      error: (error) => {
        this.creatingGroup = false;
        this.alertService.error(`${error || 'Could not create the group'}`);
      }
    });
  }

  hasError(controlName: string, errorName: string): boolean {
    return this.groupForm.controls[controlName].touched && this.groupForm.controls[controlName].hasError(errorName);
  }

  // ================================================================ calls

  private setupCallNotifications(): void {
    // Legacy 1:1 P2P offer (older clients). Current clients ring through call:incoming.
    this.subs.add(this.socketService.onIncomingCall().subscribe(async (data: any) => {
      if (!data.offer || data.from === this.myUserId || data.to !== this.myUserId) return;

      if (this.activeCall) {
        this.alertService.info('You are already in another call.');
        return;
      }

      this.userService.getUserById(data.from).subscribe({
        next: async (res) => {
          const callerName = res.data.username || 'Unknown User';
          const isVideo = data.callType === 'video';
          const result = await Swal.fire({
            title: isVideo ? 'Incoming video call' : 'Incoming audio call',
            text: `${callerName} is calling you`,
            icon: 'info',
            showCancelButton: true,
            confirmButtonText: 'Accept',
            cancelButtonText: 'Decline',
            confirmButtonColor: '#16a34a',
            cancelButtonColor: '#dc2626',
            allowOutsideClick: false,
          });
          if (result.isConfirmed) {
            this.callHandoff.stash({ from: data.from, offer: data.offer, callType: data.callType || 'video' });
            this.router.navigate(['/video-call', data.from], { queryParams: { callType: data.callType } });
          } else {
            this.alertService.info('Call declined.');
          }
        },
        error: (error) => this.alertService.error(`Failed to fetch caller info: ${error || 'Unknown error'}`),
      });
    }));

    // Audio / video ring for group + 1:1 (both use mediasoup)
    this.subs.add(this.socketService.onIncomingGroupCall().subscribe((data: any) => {
      if (!data?.callId) {
        return;
      }
      this.setActiveMeeting(data.groupId, { callId: data.callId, callType: data.callType || 'audio', mode: data.mode || 'ring' });
      if (data.mode === 'meetNow' || this.activeCall || this.incomingCall) {
        return;
      }
      this.incomingCall = this.buildIncomingCall(data);
    }));

    this.subs.add(this.socketService.onMeetingActive().subscribe((data: any) => {
      if (!data?.groupId || !data?.callId) {
        return;
      }
      this.setActiveMeeting(data.groupId, { callId: data.callId, callType: data.callType || 'video', mode: 'meetNow' });
    }));

    this.subs.add(this.socketService.onGroupCallEnded().subscribe((data: any) => {
      const groupId = data?.groupId?.toString?.() || data?.groupId;
      const callId = data?.callId?.toString?.() || data?.callId;
      this.clearActiveMeeting(groupId, callId);
      if (this.incomingCall && String(this.incomingCall.callId) === String(callId)) {
        this.incomingCall = null;
      }
    }));

    this.subs.add(this.socketService.onCallError().subscribe((data: any) => {
      // Only surface errors for a call we are trying to start (in-call errors are shown by the call UI)
      if (this.callStartTimer) {
        clearTimeout(this.callStartTimer);
        this.callStartTimer = null;
        this.callStartedSub?.unsubscribe();
        this.alertService.error(data?.message || "Couldn't start the call");
      }
    }));
  }

  private buildIncomingCall(data: any): IncomingCall {
    const groupId = String(data.groupId);
    const callerId = String(data.initiatedBy || '');
    const group = [...this.groupChatData, ...this.archivedGroups].find((g) => String(g._id) === groupId);
    const direct = [...this.chatData, ...this.archivedChats].find((c) => String(c._id) === groupId);
    const caller =
      group?.members?.find((m: any) => String(m._id) === callerId) ||
      (direct?.receiver && String(direct.receiver._id) === callerId ? direct.receiver : null) ||
      this.users.find((u) => String(u._id) === callerId);

    const incoming: IncomingCall = {
      callId: String(data.callId),
      groupId,
      callType: data.callType === 'video' ? 'video' : 'audio',
      isGroup: !!group,
      callerId,
      callerName: caller?.username || 'Someone',
      avatar: group ? group.groupAvatar : caller?.avatar,
      groupName: group?.groupName,
    };

    if (!caller && callerId) {
      this.userService.getUserById(callerId).subscribe({
        next: (res) => {
          if (this.incomingCall?.callId === incoming.callId) {
            this.incomingCall = {
              ...this.incomingCall,
              callerName: res.data.username || 'Someone',
              avatar: this.incomingCall.isGroup ? this.incomingCall.avatar : res.data.avatar,
            };
          }
        },
        error: () => undefined,
      });
    }
    return incoming;
  }

  acceptIncomingCall(): void {
    const call = this.incomingCall;
    if (!call) {
      return;
    }
    this.incomingCall = null;
    this.openCall(this.buildLaunch(call.groupId, call.callId, call.callType, { prejoin: false }));
  }

  declineIncomingCall(): void {
    if (this.incomingCall) {
      this.socketService.rejectGroupCall(this.incomingCall.callId);
      this.incomingCall = null;
    }
  }

  get currentMeeting(): ActiveGroupMeeting | null {
    if (!this.conversationId) {
      return null;
    }
    return this.activeGroupCalls[this.conversationId] || null;
  }

  /** In this conversation's call right now (shown as "Return to call"). */
  get inCallHere(): boolean {
    return !!this.activeCall && this.activeCall.groupId === this.conversationId;
  }

  private setActiveMeeting(groupId: string, meeting: ActiveGroupMeeting): void {
    this.activeGroupCalls = { ...this.activeGroupCalls, [groupId]: meeting };
    this.rebuildSidebar();
  }

  private clearActiveMeeting(groupId?: string, callId?: string): void {
    const next = { ...this.activeGroupCalls };
    if (groupId && next[groupId]) {
      delete next[groupId];
    } else if (callId) {
      for (const key of Object.keys(next)) {
        if (next[key].callId?.toString() === callId.toString()) {
          delete next[key];
        }
      }
    }
    this.activeGroupCalls = next;
    this.rebuildSidebar();
  }

  checkForActiveGroupCall(): void {
    if (this.isGroupChat && this.conversationId) {
      void this.refreshActiveMeeting(this.conversationId);
    }
  }

  private async refreshActiveMeeting(groupId: string): Promise<void> {
    try {
      const res = await this.socketService.getActiveGroupCall(groupId);
      if (res?.call) {
        this.setActiveMeeting(groupId, { callId: res.call.callId, callType: res.call.callType, mode: res.call.mode || 'ring' });
      } else {
        this.clearActiveMeeting(groupId);
      }
    } catch {
      this.clearActiveMeeting(groupId);
    }
  }

  startVideoCall(): void {
    if (!this.conversationId) {
      this.alertService.warning('Open the chat before starting a call');
      return;
    }
    // Use mediasoup SFU (same as group) — P2P fails across networks without TURN
    this.startGroupCall(this.conversationId, 'video', 'ring');
  }

  startAudioCall(): void {
    if (!this.conversationId) {
      this.alertService.warning('Open the chat before starting a call');
      return;
    }
    this.startGroupCall(this.conversationId, 'audio', 'ring');
  }

  /** Groups start meetings only ("Meet now"); joining an active one goes through the lobby. */
  startMeetNow(conversationId: string): void {
    if (this.currentMeeting) {
      this.joinCurrentMeeting();
      return;
    }
    this.startGroupCall(conversationId, 'video', 'meetNow');
  }

  joinCurrentMeeting(): void {
    const meeting = this.currentMeeting;
    if (!meeting || !this.conversationId) {
      return;
    }
    this.openCall(this.buildLaunch(this.conversationId, meeting.callId, meeting.callType, { prejoin: this.isGroupChat }));
  }

  returnToCall(): void {
    this.callMinimized = false;
  }

  private startGroupCall(conversationId: string, callType: 'audio' | 'video', mode: 'ring' | 'meetNow'): void {
    if (this.activeCall) {
      if (this.activeCall.groupId === conversationId) {
        this.callMinimized = false;
      } else {
        this.alertService.info('Leave your current call before starting another one.');
      }
      return;
    }

    this.callStartedSub?.unsubscribe();
    if (this.callStartTimer) {
      clearTimeout(this.callStartTimer);
    }
    this.socketService.startGroupCall(conversationId, callType, mode);

    this.callStartTimer = setTimeout(() => {
      this.callStartTimer = null;
      this.callStartedSub?.unsubscribe();
      this.alertService.error("Couldn't start the call. Check your connection and try again.");
    }, 10000);

    this.callStartedSub = this.socketService.onCallStarted().subscribe((data: any) => {
      if (String(data?.groupId) !== String(conversationId)) {
        return;
      }
      this.callStartedSub?.unsubscribe();
      if (this.callStartTimer) {
        clearTimeout(this.callStartTimer);
        this.callStartTimer = null;
      }
      const effectiveType: 'audio' | 'video' = data.callType || callType;
      const effectiveMode = data.mode || mode;
      this.setActiveMeeting(conversationId, { callId: data.callId, callType: effectiveType, mode: effectiveMode });
      // A resumed call already has its chat message
      if (!data.resumed) {
        this.sendCallNotificationMessage(conversationId, effectiveType, data.callId, effectiveMode);
      }
      const isGroup = this.isGroupConversation(conversationId);
      this.openCall(this.buildLaunch(conversationId, String(data.callId), effectiveType, {
        prejoin: isGroup && effectiveMode === 'meetNow',
        isInitiator: !data.resumed,
      }));
    });
  }

  sendCallNotificationMessage(conversationId: string, callType: 'audio' | 'video', callId?: string, mode: 'ring' | 'meetNow' = 'ring'): void {
    const joinUrl = callId
      ? `${environment.BASE_URL}/group-call/${conversationId}?callId=${callId}&callType=${callType}`
      : `${environment.BASE_URL}/group-call/${conversationId}`;

    this.socketService.sendGroupMessage({
      user: this.sender.currentUserPayload(),
      conversationId,
      content: mode === 'meetNow' ? 'Meeting started — tap Join to enter.' : callType === 'video' ? 'Video call started.' : 'Audio call started.',
      fileUrl: joinUrl,
      type: 'call',
      createdAt: new Date().toISOString(),
    } as any);
  }

  private isGroupConversation(conversationId: string): boolean {
    return [...this.groupChatData, ...this.archivedGroups].some((g) => String(g._id) === String(conversationId));
  }

  /** Everything the call surface needs, resolved from the loaded conversation lists. */
  private buildLaunch(groupId: string, callId: string, callType: 'audio' | 'video', opts: { prejoin?: boolean; isInitiator?: boolean } = {}): CallLaunch {
    const group = [...this.groupChatData, ...this.archivedGroups].find((g) => String(g._id) === String(groupId));
    if (group) {
      return {
        groupId,
        callId,
        callType,
        isGroup: true,
        title: group.groupName,
        avatar: group.groupAvatar,
        members: (group.members || []).map((m: any): CallMember => ({ _id: m._id, username: m.username, avatar: m.avatar })),
        isInitiator: !!opts.isInitiator,
        prejoin: !!opts.prejoin,
      };
    }
    const direct = [...this.chatData, ...this.archivedChats].find((c) => String(c._id) === String(groupId));
    const peer = direct?.receiver || (this.receiverId && groupId === this.conversationId
      ? { _id: this.receiverId, username: this.peerName, avatar: this.peerAvatar, isOnline: this.isOnline }
      : null);
    return {
      groupId,
      callId,
      callType,
      isGroup: false,
      title: peer?.username || 'Call',
      avatar: peer?.avatar,
      members: peer ? [{ _id: peer._id, username: peer.username, avatar: peer.avatar }] : [],
      isInitiator: !!opts.isInitiator,
      prejoin: false,
      peerOnline: !!peer?.isOnline,
    };
  }

  openCall(launch: CallLaunch): void {
    if (this.activeCall) {
      if (this.activeCall.callId === launch.callId) {
        this.callMinimized = false;
      } else {
        this.alertService.info('You are already in another call.');
      }
      return;
    }
    if (this.incomingCall?.callId === launch.callId) {
      this.incomingCall = null;
    }
    this.activeCall = launch;
    this.callMinimized = false;
    // Mirror the call in the URL so a refresh rejoins it
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { call: launch.callId, g: launch.groupId, t: launch.callType },
      replaceUrl: true,
    });
  }

  onCallClosed(): void {
    const groupId = this.activeCall?.groupId;
    this.activeCall = null;
    this.callMinimized = false;
    this.router.navigate(['/chat'], { replaceUrl: true });
    if (groupId && this.isGroupConversation(groupId)) {
      void this.refreshActiveMeeting(groupId);
    }
  }

  private tryOpenPendingCall(): void {
    const pending = this.pendingUrlCall;
    if (!pending || !this.listsLoaded.chats || !this.listsLoaded.groups) {
      return;
    }
    this.pendingUrlCall = null;
    if (this.activeCall) {
      return;
    }
    const isGroup = this.isGroupConversation(pending.groupId);
    this.openCall(this.buildLaunch(pending.groupId, pending.callId, pending.callType, {
      // From a join link → lobby; from a refresh → straight back in
      prejoin: isGroup && pending.join,
    }));
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
