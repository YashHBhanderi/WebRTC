import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild,
} from '@angular/core';
import { FormBuilder, Validators, FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { environment } from 'src/environments/environment';
import { GroupInfoComponent } from '../group-info/group-info.component';
import { ProfileComponent } from '../profile/profile.component';
import { UserService } from 'src/app/core/services/user.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { CallHandoffService } from 'src/app/core/services/call-handoff.service';
import { CallLaunch, CallMember } from '../group-call/call.models';
import { IncomingCall } from './incoming-call/incoming-call.component';

export interface ActiveGroupMeeting {
  callId: string;
  callType: 'audio' | 'video';
  mode: 'ring' | 'meetNow';
}

export interface ChatMessage {
  _id: string;
  user: any;
  userId?: string;
  content?: string;
  fileUrl?: string;
  type: string;
  isDeleted: boolean;
  isRead?: boolean;
  createdAt: string;
  senderName?: string;
  replyTo?: any;
  reactions?: any[];
  thumbnailUrl?: string;
  conversationId?: string;
}

type SidebarFilter = 'all' | 'unread' | 'groups' | 'contacts';

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

const COMPOSER_EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋',
  '😎', '🤩', '🥳', '😏', '😌', '🤔', '🤨', '😐', '😶', '🙄', '😬', '😮', '😯', '😲', '😳', '🥺',
  '😢', '😭', '😤', '😠', '😡', '🤯', '😱', '😴', '🤗', '🤝', '👍', '👎', '👏', '🙌', '🙏', '💪',
  '👋', '✌️', '🤞', '👌', '👀', '🔥', '✨', '🎉', '💯', '✅', '❌', '❤️', '💙', '💚', '💛', '💜',
];

const SENDER_COLORS = ['#2563eb', '#0d9488', '#c026d3', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2'];

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss']
})
export class ChatComponent implements OnInit, AfterViewInit, OnDestroy {
  // ---- lists
  chatData: any[] = [];
  groupChatData: any[] = [];
  users: any[] = [];
  sidebarItems: SidebarItem[] = [];
  sidebarFilter: SidebarFilter = 'all';
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
  typingUsers = new Map<string, ReturnType<typeof setTimeout>>();
  messagesLoading = false;

  page = 1;
  pageSize = 20;
  hasMoreMessages = true;
  isFetchingOldMessages = false;
  isNearBottom = true;
  unseenBelow = 0;

  // ---- composer
  formData!: FormGroup;
  file: File | null = null;
  filePreviewUrl = '';
  uploading = false;
  replyingTo: ChatMessage | null = null;
  showComposerEmoji = false;
  readonly composerEmojis = COMPOSER_EMOJIS;
  popularEmojis: string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏', '💯'];

  // ---- in-conversation search
  showSearch = false;
  searchTerm = '';
  searchMatches: string[] = [];
  searchIndex = 0;
  highlightedMessageId: string | null = null;

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
  @ViewChild('composerInput', { static: false }) composerInput?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileInput', { static: false }) fileInput?: ElementRef<HTMLInputElement>;
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

  private readonly onResize = () => this.checkScreenSize();
  private readonly onPaste = (event: ClipboardEvent) => this.handleClipboardFiles(event);
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible' && this.conversationId) {
      this.scheduleMarkRead();
    }
  };

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
    private zone: NgZone,
  ) {
    this.groupForm = this.formBuilder.group({
      groupName: ['', Validators.required],
      groupDescription: [''],
      groupMembers: [[], Validators.required],
      groupAvatar: null,
    });

    this.formData = this.formBuilder.group({
      message: ['']
    });
  }

  // ================================================================ lifecycle

  ngOnInit(): void {
    this.checkScreenSize();
    this.loadChatConversations();
    this.loadGroupConversations();
    this.loadUsers();

    this.subs.add(this.socketService.newMessageReceived().subscribe((data: any) => this.onIncomingMessage(data)));

    this.subs.add(this.socketService.onReactionUpdated().subscribe((data: any) => {
      const msg = this.messageArray.find(m => m._id === data.messageId);
      if (msg) {
        msg.reactions = data.reactions;
      }
    }));

    this.subs.add(this.socketService.receivedTyping().subscribe((data: any) => this.onTyping(data)));
    this.subs.add(this.socketService.messagesMarkedRead().subscribe((data: any) => this.handleMessagesMarkedRead(data)));
    this.subs.add(this.socketService.onPresence().subscribe((data: any) => this.onPresence(data)));
    // A reconnected socket is in no rooms: rejoin the open chat so typing/room events keep flowing
    this.subs.add(this.socketService.onConnect().subscribe(() => {
      if (this.conversationId) {
        this.socketService.joinConversation(this.conversationId);
      }
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

    document.addEventListener('paste', this.onPaste);
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
    this.revokeFilePreview();
    if (this.myUserId) {
      this.socketService.stopTyping(this.myUserId);
    }
    document.removeEventListener('paste', this.onPaste);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
  }

  checkScreenSize(): void {
    const mobile = window.innerWidth <= 768;
    if (mobile !== this.isMobileView) {
      this.isMobileView = mobile;
    }
  }

  get hasOpenConversation(): boolean {
    return !!(this.receiverId || this.conversationId);
  }

  backToList(): void {
    this.showChatPane = false;
    this.showSearch = false;
    this.showComposerEmoji = false;
  }

  // ================================================================ sidebar

  loadUsers(): void {
    this.userService.getAllUsersExceptCurrentUser().subscribe({
      next: (response) => {
        this.users = response.data || [];
        this.rebuildSidebar();
      },
      error: (error) => {
        this.alertService.error(`Failed to load users: ${error || 'Unknown error'}`);
      }
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

  /** New conversation appeared (first message from someone) → refresh lists once. */
  private scheduleListReload(): void {
    if (this.listReloadTimer) {
      return;
    }
    this.listReloadTimer = setTimeout(() => {
      this.listReloadTimer = null;
      this.loadChatConversations();
      this.loadGroupConversations();
    }, 600);
  }

  setSidebarFilter(filter: SidebarFilter): void {
    this.sidebarFilter = filter;
    if (filter === 'all') {
      this.loadChatConversations();
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

    if (this.sidebarFilter === 'contacts') {
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

    if (this.sidebarFilter !== 'groups') {
      this.chatData.forEach((c) => {
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
          time: c.lastMessage?.createdAt,
          unread: c.unreadCount || 0,
          hasActiveCall: !!this.activeGroupCalls[c._id],
          source: c,
        });
      });
    }

    this.groupChatData.forEach((g) => {
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
        preview: hasLast ? this.previewText(g.lastMessage, true) : `${g.members?.length || 0} members`,
        previewIsMine: false,
        previewRead: false,
        time: g.lastMessage?.createdAt,
        unread: g.unreadCount || 0,
        hasActiveCall: !!this.activeGroupCalls[g._id],
        source: g,
      });
    });

    let result = items;
    if (this.sidebarFilter === 'unread') {
      result = items.filter((i) => i.unread > 0);
    }
    result.sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());
    this.sidebarItems = result;
  }

  private previewText(last: any, withSender = false): string {
    if (!last) {
      return '';
    }
    const labels: Record<string, string> = {
      image: '📷 Photo',
      video: '🎥 Video',
      audio: '🎵 Audio',
      pdf: '📄 Document',
    };
    const body = last.type === 'call' ? `📞 ${last.content || 'Call'}` : labels[last.type] || last.content || '';
    if (withSender && this.isMineId(last.userId)) {
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
    const existing = this.chatData.find((c) => c.receiver?._id === u._id);
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
      this.loadMessages(this.conversationId);
      this.socketService.markMessagesAsRead(conversationId);
    }
  }

  startNewChat(userId: string, username: string, avatar: string): void {
    this.userService.createOrGetConversation(userId).subscribe({
      next: (response) => {
        if (response && response.conversationId) {
          this.conversationId = response.conversationId;
          this.socketService.joinConversation(response.conversationId);
          this.peerName = username;
          this.peerAvatar = avatar;
          this.page = 1;
          this.hasMoreMessages = true;
          this.isFetchingOldMessages = false;
          this.loadMessages(this.conversationId);
        } else {
          this.alertService.error('Failed to create or retrieve conversation.');
        }
      },
      error: (error) => {
        this.alertService.error(`Failed to create or retrieve conversation: ${error || 'Unknown error'}`);
      }
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
    this.loadMessages(this.conversationId);
    this.socketService.markMessagesAsRead(this.conversationId);
    this.checkForActiveGroupCall();
  }

  private resetConversationState(): void {
    this.cancelReply();
    this.closeSearch();
    this.clearSelectedFile();
    this.showComposerEmoji = false;
    this.typingUsers.forEach((t) => clearTimeout(t));
    this.typingUsers.clear();
    this.messageArray = [];
    this.page = 1;
    this.hasMoreMessages = true;
    this.isFetchingOldMessages = false;
    this.unseenBelow = 0;
    this.isNearBottom = true;
    if (this.myUserId) {
      this.socketService.stopTyping(this.myUserId);
    }
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
        error: (error) => {
          this.alertService.error(`Error fetching user: ${error || 'Unknown error'}`);
        }
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
    const found = bump(this.chatData) || bump(this.groupChatData);
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
    update(this.chatData);
    update(this.groupChatData);

    // Someone else read this chat → my messages are seen
    if (!readerIsMe && conversationId === this.conversationId) {
      this.messageArray.forEach((m) => {
        if (this.isMine(m)) {
          m.isRead = true;
        }
      });
    }
    this.rebuildSidebar();
  }

  private onTyping(data: any): void {
    const userId = String(data?.userId || '');
    if (!userId || userId === this.myUserId) {
      return;
    }
    // Older servers omit conversationId; then assume the open chat
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
    this.chatData.forEach((c) => apply(c.receiver));
    this.users.forEach(apply);
    this.groupChatData.forEach((g) => (g.members || []).forEach(apply));
    if (!this.isGroupChat && this.receiverId === userId) {
      this.isOnline = !!data.isOnline;
      if (data.lastSeen) {
        this.lastSeen = data.lastSeen;
      }
    }
    this.rebuildSidebar();
  }

  get headerSubtitle(): string {
    if (this.isGroupChat) {
      const typing = [...this.typingUsers.keys()];
      if (typing.length) {
        const names = typing.map((id) => this.groupMembers.find((m) => m._id === id)?.username || 'Someone');
        return names.length === 1 ? `${names[0]} is typing…` : `${names.length} people are typing…`;
      }
      const names = (this.groupMembers || [])
        .map((m) => (m._id === this.myUserId ? 'You' : m.username))
        .filter(Boolean);
      return names.length ? names.join(', ') : `${this.groupMembers.length} members`;
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

  /** First bubble of a run from the same sender (shows name/avatar, bubble tail). */
  isFirstOfRun(index: number): boolean {
    if (index === 0 || this.isNewDay(index)) {
      return true;
    }
    const prev = this.messageArray[index - 1];
    const cur = this.messageArray[index];
    if (prev.type === 'call' || cur.type === 'call') {
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

  /** Who wrote the quoted message: "You", the group member, or the other person in a 1:1. */
  replyAuthor(reply: any): string {
    if (this.isMineId(reply?.userId)) {
      return 'You';
    }
    if (this.isGroupChat) {
      return this.groupMembers.find((m) => String(m._id) === String(reply?.userId))?.username || 'Member';
    }
    return this.peerName || 'Reply';
  }

  /** Text or media caption. Without a caption the server stores the type name as content. */
  hasText(msg: ChatMessage): boolean {
    return !!msg.content && msg.type !== 'call' && msg.content !== msg.type;
  }

  senderName(msg: ChatMessage): string {
    return msg.senderName || msg.user?.username || 'Unknown';
  }

  senderColor(msg: ChatMessage): string {
    const id = String(msg.user?._id || msg.userId || '');
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
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

  getReactionCount(reactions: any[], emoji: string): number {
    return reactions ? reactions.filter(r => r.emoji === emoji).length : 0;
  }

  hasReacted(reactions: any[], emoji: string): boolean {
    return reactions ? reactions.some(r => String(r.userId) === this.myUserId && r.emoji === emoji) : false;
  }

  getUniqueReactions(reactions: any[]): string[] {
    if (!reactions) {
      return [];
    }
    return [...new Set(reactions.map((r) => r.emoji as string))];
  }

  addReaction(messageId: string, emoji: string): void {
    this.socketService.sendReaction(messageId, emoji, this.conversationId);
  }

  // ================================================================ scrolling

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

  scrollToMessage(messageId: string): void {
    if (!messageId) {
      return;
    }
    const id = messageId.toString();
    const element = document.getElementById('message-' + id);
    if (!element) {
      this.alertService.info('That message is further back in the chat. Scroll up to load it.');
      return;
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlightedMessageId = id;
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
    }
    this.highlightTimer = setTimeout(() => (this.highlightedMessageId = null), 2000);
  }

  // ================================================================ in-conversation search

  toggleSearch(): void {
    if (this.showSearch) {
      this.closeSearch();
    } else {
      this.showSearch = true;
      setTimeout(() => document.getElementById('conversation-search')?.focus(), 0);
    }
  }

  closeSearch(): void {
    this.showSearch = false;
    this.searchTerm = '';
    this.searchMatches = [];
    this.searchIndex = 0;
  }

  onSearchTerm(term: string): void {
    this.searchTerm = term;
    const q = term.trim().toLowerCase();
    this.searchMatches = q.length < 2
      ? []
      : this.messageArray.filter((m) => m.type !== 'call' && m.content?.toLowerCase().includes(q)).map((m) => m._id);
    // Start from the newest match, like WhatsApp
    this.searchIndex = this.searchMatches.length - 1;
    if (this.searchMatches.length) {
      this.scrollToMessage(this.searchMatches[this.searchIndex]);
    }
  }

  stepSearch(direction: -1 | 1): void {
    if (!this.searchMatches.length) {
      return;
    }
    this.searchIndex = (this.searchIndex + direction + this.searchMatches.length) % this.searchMatches.length;
    this.scrollToMessage(this.searchMatches[this.searchIndex]);
  }

  isSearchHit(msg: ChatMessage): boolean {
    return this.showSearch && this.searchMatches.length > 0 && this.searchMatches.includes(msg._id);
  }

  // ================================================================ composer

  typing(): void {
    if (this.conversationId) {
      this.socketService.typing(this.conversationId, this.myUserId);
    }
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.sendMessage();
    } else if (event.key === 'Escape') {
      if (this.showComposerEmoji) {
        this.showComposerEmoji = false;
      } else if (this.replyingTo) {
        this.cancelReply();
      }
    }
  }

  autoGrow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  insertEmoji(emoji: string): void {
    const control = this.formData.get('message')!;
    const el = this.composerInput?.nativeElement;
    const value: string = control.value || '';
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    control.setValue(value.slice(0, start) + emoji + value.slice(end));
    setTimeout(() => {
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = start + emoji.length;
      }
    });
  }

  get canSend(): boolean {
    return !this.uploading && (!!(this.formData.get('message')?.value || '').trim() || !!this.file);
  }

  setReply(message: ChatMessage): void {
    this.replyingTo = message;
    setTimeout(() => this.composerInput?.nativeElement.focus(), 0);
  }

  cancelReply(): void {
    this.replyingTo = null;
  }

  private currentUserPayload() {
    const loggedInUser = this.authService.getLoggedInUser();
    return {
      _id: loggedInUser._id,
      username: loggedInUser.username,
      email: loggedInUser.email,
      avatar: loggedInUser.avatar,
      isOnline: loggedInUser.isOnline,
      lastSeen: loggedInUser.lastSeen
    };
  }

  sendMessage(): void {
    const text = (this.formData.get('message')!.value || '').trim();
    if ((!text && !this.file) || this.uploading || !this.conversationId) {
      return;
    }

    const messageData: any = {
      user: this.currentUserPayload(),
      conversationId: this.conversationId,
      content: text,
      createdAt: new Date().toISOString(),
      replyTo: this.replyingTo ? this.replyingTo._id : null
    };

    const finish = () => {
      this.replyingTo = null;
      this.formData.reset({ message: '' });
      this.showComposerEmoji = false;
      if (this.composerInput) {
        this.composerInput.nativeElement.style.height = 'auto';
      }
      this.socketService.stopTyping(this.myUserId);
      this.scrollToBottom();
    };

    if (this.file) {
      const file = this.file;
      this.uploading = true;
      this.socketService.uploadFile(file).subscribe({
        next: (response) => {
          this.uploading = false;
          messageData.fileUrl = response.fileUrl;
          messageData.thumbnailUrl = response.thumbnailUrl;
          if (file.type.startsWith('image')) {
            messageData.type = 'image';
          } else if (file.type.startsWith('video')) {
            messageData.type = 'video';
          } else if (file.type.startsWith('audio')) {
            messageData.type = 'audio';
          } else if (file.type === 'application/pdf') {
            messageData.type = 'pdf';
          } else {
            messageData.type = 'unknown';
          }
          this.socketService.sendMessage(messageData);
          this.clearSelectedFile();
          finish();
        },
        error: () => {
          // The error interceptor already shows the reason
          this.uploading = false;
        },
      });
    } else {
      messageData.type = 'text';
      this.socketService.sendMessage(messageData);
      finish();
    }
  }

  handleFileUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.setSelectedFile(file);
    }
  }

  handleClipboardFiles(event: ClipboardEvent): void {
    if (!this.conversationId) {
      return;
    }
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          this.setSelectedFile(file);
          this.alertService.info('File copied from clipboard!');
        }
      }
    }
  }

  private setSelectedFile(file: File): void {
    this.revokeFilePreview();
    this.file = file;
    this.filePreviewUrl = URL.createObjectURL(file);
  }

  clearSelectedFile(): void {
    this.revokeFilePreview();
    this.file = null;
    if (this.fileInput) {
      this.fileInput.nativeElement.value = '';
    }
  }

  private revokeFilePreview(): void {
    if (this.filePreviewUrl) {
      URL.revokeObjectURL(this.filePreviewUrl);
      this.filePreviewUrl = '';
    }
  }

  get fileKind(): 'image' | 'video' | 'audio' | 'pdf' | 'file' {
    const type = this.file?.type || '';
    if (type.startsWith('image')) return 'image';
    if (type.startsWith('video')) return 'video';
    if (type.startsWith('audio')) return 'audio';
    if (type === 'application/pdf') return 'pdf';
    return 'file';
  }

  // ================================================================ message actions

  openPreview(url: string, type: string): void {
    if (type === 'pdf' || type === 'application/pdf') {
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

  fileNameOf(url?: string): string {
    return decodeURIComponent((url || '').split('/').pop() || 'Document');
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
                  const item = new ClipboardItem({ 'image/png': pngBlob });
                  navigator.clipboard.write([item]).then(() => {
                    this.alertService.info('Image copied to clipboard!');
                  }).catch((error) => {
                    this.alertService.error(`Failed to copy image to clipboard: ${error || 'Unknown error'}`);
                  });
                }
              }, 'image/png');
            };

            img.src = URL.createObjectURL(blob);
          } else {
            const item = new ClipboardItem({ 'image/png': blob });
            navigator.clipboard.write([item]).then(() => {
              this.alertService.info('Image copied to clipboard!');
            }).catch((error) => {
              this.alertService.error(`Failed to copy image to clipboard: ${error || 'Unknown error'}`);
            });
          }
        })
        .catch((error) => {
          this.alertService.error(`Error fetching the image: ${error || 'Unknown error'}`);
        });
    } else {
      const messageContent = msg.type === 'text' ? msg.content || '' : msg.fileUrl || msg.content || '';
      navigator.clipboard.writeText(messageContent).then(() => {
        this.alertService.info('Message copied!');
      }).catch((error) => {
        this.alertService.error(`Failed to copy message: ${error || 'Unknown error'}`);
      });
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
          error: (error) => {
            this.alertService.error(`${error || 'Unknown error'}`);
          }
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
        preview: `${g.members?.length || 0} members`, previewIsMine: false, previewRead: false, unread: 0, hasActiveCall: false, source: g,
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
      user: this.currentUserPayload(),
      conversationId: target.conversationId,
      content: source.content || '',
      fileUrl: source.fileUrl,
      thumbnailUrl: source.thumbnailUrl,
      type: source.type,
    });
    this.forwardSending = false;
    this.forwardModalRef?.close();
    this.forwardSource = null;
    this.alertService.success(`Forwarded to ${target.title}`);
  }

  canForward(msg: ChatMessage): boolean {
    return msg.type !== 'call';
  }

  deleteConversation(conversationId: string): void {
    Swal.fire({
      title: 'Delete this chat?',
      text: "You won't be able to see this conversation again!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel'
    }).then((result) => {
      if (result.isConfirmed) {
        this.userService.deleteConversation(conversationId).subscribe({
          next: (res) => {
            this.chatData = this.chatData.filter(chat => chat._id !== conversationId);
            this.groupChatData = this.groupChatData.filter(chat => chat._id !== conversationId);
            if (this.conversationId === conversationId) {
              this.conversationId = '';
              this.receiverId = '';
              this.messageArray = [];
              this.showChatPane = false;
            }
            this.rebuildSidebar();
            this.alertService.success(`${res.message || 'Conversation deleted successfully!'}`);
          },
          error: (error) => {
            this.alertService.error(`${error || 'Unknown error'}`);
          }
        });
      }
    });
  }

  // ================================================================ profile / group modals

  onLogoutClick(): void {
    this.socketService.disconnectSocket();
    this.authService.logout();
    this.alertService.success('Logout Successfully.');
  }

  openUserProfile(userId: string): void {
    const modalRef = this.modalService.open(ProfileComponent, {
      windowClass: 'custom-modal'
    });
    modalRef.componentInstance.userId = userId;
    // Only pass conversationId if we are viewing someone else's profile in a private chat
    if (userId !== this.myUserId && !this.isGroupChat) {
      modalRef.componentInstance.conversationId = this.conversationId;
    }
    modalRef.componentInstance.modalRef = modalRef;
  }

  openGroupInfo(groupId: string): void {
    const modalRef = this.modalService.open(GroupInfoComponent);
    modalRef.componentInstance.groupId = groupId;
    modalRef.componentInstance.modalRef = modalRef;
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

  editCurrentUserProfile(): void {
    // The profile modal supports editing when it shows the current user
    this.openUserProfile(this.myUserId);
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
            this.callHandoff.stash({
              from: data.from,
              offer: data.offer,
              callType: data.callType || 'video',
            });
            this.router.navigate(['/video-call', data.from], {
              queryParams: { callType: data.callType },
            });
          } else {
            this.alertService.info('Call declined.');
          }
        },
        error: (error) => {
          this.alertService.error(`Failed to fetch caller info: ${error || 'Unknown error'}`);
        },
      });
    }));

    // Audio / video ring for group + 1:1 (both use mediasoup)
    this.subs.add(this.socketService.onIncomingGroupCall().subscribe((data: any) => {
      if (!data?.callId) {
        return;
      }
      this.setActiveMeeting(data.groupId, {
        callId: data.callId,
        callType: data.callType || 'audio',
        mode: data.mode || 'ring',
      });

      if (data.mode === 'meetNow' || this.activeCall || this.incomingCall) {
        return;
      }
      this.incomingCall = this.buildIncomingCall(data);
    }));

    this.subs.add(this.socketService.onMeetingActive().subscribe((data: any) => {
      if (!data?.groupId || !data?.callId) {
        return;
      }
      this.setActiveMeeting(data.groupId, {
        callId: data.callId,
        callType: data.callType || 'video',
        mode: 'meetNow',
      });
    }));

    this.subs.add(this.socketService.onGroupCallEnded().subscribe((data: any) => {
      const groupId = data?.groupId?.toString?.() || data?.groupId;
      const callId = data?.callId?.toString?.() || data?.callId;
      this.clearActiveMeeting(groupId, callId);
      if (this.incomingCall && String(this.incomingCall.callId) === String(callId)) {
        this.incomingCall = null;
      }
    }));
  }

  private buildIncomingCall(data: any): IncomingCall {
    const groupId = String(data.groupId);
    const callerId = String(data.initiatedBy || '');
    const group = this.groupChatData.find((g) => String(g._id) === groupId);
    const direct = this.chatData.find((c) => String(c._id) === groupId);
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

  /** Join replaces Meet now only for an active Meet Now session */
  get activeMeetNow(): ActiveGroupMeeting | null {
    if (!this.isGroupChat) {
      return null;
    }
    const meeting = this.currentMeeting;
    return meeting?.mode === 'meetNow' ? meeting : null;
  }

  /** In this conversation's call right now (shown as "Return to call"). */
  get inCallHere(): boolean {
    return !!this.activeCall && this.activeCall.groupId === this.conversationId;
  }

  private setActiveMeeting(groupId: string, meeting: ActiveGroupMeeting): void {
    this.activeGroupCalls = {
      ...this.activeGroupCalls,
      [groupId]: meeting,
    };
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
        this.setActiveMeeting(groupId, {
          callId: res.call.callId,
          callType: res.call.callType,
          mode: res.call.mode || 'ring',
        });
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

  startGroupAudioCall(conversationId: string): void {
    this.startGroupCall(conversationId, 'audio', 'ring');
  }

  startMeetNow(conversationId: string): void {
    if (this.activeMeetNow) {
      this.joinCurrentMeeting();
      return;
    }
    this.startGroupCall(conversationId, 'video', 'meetNow');
  }

  joinCurrentMeeting(): void {
    const meeting = this.activeMeetNow || this.currentMeeting;
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
      this.setActiveMeeting(conversationId, {
        callId: data.callId,
        callType: effectiveType,
        mode: effectiveMode,
      });
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

  sendCallNotificationMessage(
    conversationId: string,
    callType: 'audio' | 'video',
    callId?: string,
    mode: 'ring' | 'meetNow' = 'ring'
  ): void {
    const joinUrl = callId
      ? `${environment.BASE_URL}/group-call/${conversationId}?callId=${callId}&callType=${callType}`
      : `${environment.BASE_URL}/group-call/${conversationId}`;

    const messageData: any = {
      user: this.currentUserPayload(),
      conversationId,
      content:
        mode === 'meetNow'
          ? 'Meeting started — tap Join to enter.'
          : callType === 'video'
            ? 'Video call started.'
            : 'Audio call started.',
      fileUrl: joinUrl,
      type: 'call',
      createdAt: new Date().toISOString(),
    };

    this.socketService.sendGroupMessage(messageData);
  }

  private isGroupConversation(conversationId: string): boolean {
    return this.groupChatData.some((g) => String(g._id) === String(conversationId));
  }

  /** Everything the call surface needs, resolved from the loaded conversation lists. */
  private buildLaunch(
    groupId: string,
    callId: string,
    callType: 'audio' | 'video',
    opts: { prejoin?: boolean; isInitiator?: boolean } = {}
  ): CallLaunch {
    const group = this.groupChatData.find((g) => String(g._id) === String(groupId));
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
    const direct = this.chatData.find((c) => String(c._id) === String(groupId));
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
}
