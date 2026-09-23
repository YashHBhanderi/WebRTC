import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormBuilder, Validators, FormGroup } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { environment } from 'src/environments/environment';
import { GroupInfoComponent } from '../group-info/group-info.component';
import { ProfileComponent } from '../profile/profile.component';
import { UserService } from 'src/app/core/services/user.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { CallHandoffService } from 'src/app/core/services/call-handoff.service';

export interface ActiveGroupMeeting {
  callId: string;
  callType: 'audio' | 'video';
  mode: 'ring' | 'meetNow';
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss']
})
export class ChatComponent implements OnInit, AfterViewInit, OnDestroy {
  chatData: any[] = [];
  groupChatData: any[] = [];
  users: any[] = [];
  selectedMembers: any[] = [];
  groupMembers!: any[];
  groupCallParticipants: any[] = [];

  messageArray: Array<{
    _id: string,
    user: any,
    content?: string,
    fileUrl?: string,
    type: string,
    isDeleted: boolean,
    createdAt: string,
    senderName?: string,
    replyTo?: any,
    reactions?: any[],
    thumbnailUrl?: string,
  }> = [];
  formData!: FormGroup;
  groupForm!: FormGroup;

  lastSeen !: Date;

  activeGroupCalls: { [groupId: string]: ActiveGroupMeeting } = {};
  activeSection: 'chat' | 'groups' | 'contacts' = 'chat';
  callType: 'audio' | 'video' = 'video';

  username: string = this.authService.getLoggedInUser().username;
  loginUserProfile: string = this.authService.getLoggedInUser().avatar;
  groupname!: string;
  userProfile: string = '';
  previewUrl: string | null = null;
  previewType: string | null = null;
  fileName: string = '';
  receiverId!: string;
  message: string = '';
  groupAvatar: string = '';
  conversationId!: string;

  isGroupChat: boolean = false;
  isOnline: boolean = false;
  isTyping: boolean = false;
  isMobileView: boolean = false;
  isSidebarOpen: boolean = true;
  showGroupForm: boolean = false;
  showDropdown: boolean = false;
  callInProgress: boolean = false;
  isLoading: boolean = false;

  replyingTo: any = null;
  showEmojiPicker: string | null = null;
  popularEmojis: string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏', '💯'];
  highlightedMessageId: string | null = null;
  searchTerm: string = '';
  showSearch: boolean = false;

  file: File | null = null;
  selectedFile: File | null = null;

  private callListenerSub: Subscription | undefined;
  private groupCallListenerSub: Subscription | undefined;
  private callStartedSub: Subscription | undefined;
  private meetingActiveSub: Subscription | undefined;
  private groupCallEndedSub: Subscription | undefined;

  page = 1;
  pageSize = 20;
  hasMoreMessages = true;
  isFetchingOldMessages = false;
  private chatWindowObserver: IntersectionObserver | null = null;


  @ViewChild('chatWindow', { static: false }) chatWindow!: ElementRef;
  @ViewChild('topElement', { static: false }) topElement!: ElementRef;

  constructor(
    public formBuilder: FormBuilder,
    private userService: UserService,
    private socketService: SocketService,
    public authService: AuthService,
    private alertService: AlertService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private fb: FormBuilder,
    private modalService: NgbModal,
    private callHandoff: CallHandoffService
  ) {
    this.groupForm = this.fb.group({
      groupName: ['', Validators.required],
      groupDescription: [''],
      groupMembers: [[], Validators.required],
      groupAvatar: null,
    });

    this.formData = this.formBuilder.group({
      message: ['', Validators.required]
    });

    this.socketService.newMessageReceived().subscribe((data: any) => {
      if (data.conversationId !== this.conversationId) return;

      if (!this.messageArray.some(msg => msg._id === data._id)) {
        this.messageArray.push(data);
        this.referenceChatAndGroupList(this.conversationId, data, this.chatData);
      }
      this.isTyping = false;
      setTimeout(() => this.scrollToBottom(), 100);
    });

    this.socketService.onReactionUpdated().subscribe((data: any) => {
      const msg = this.messageArray.find(m => m._id === data.messageId);
      if (msg) {
        msg.reactions = data.reactions;
        this.cdr.detectChanges();
      }
    });

    this.socketService.newGroupMessageReceived().subscribe((data: any) => {
      if (data.conversationId !== this.conversationId) return;
      this.referenceChatAndGroupList(this.conversationId, data, this.groupChatData);

      if (!this.messageArray.some(msg => msg._id === data._id)) {
        if (data.user) {
          data.senderName = data.user.username;
          this.messageArray.push(data);
          this.isTyping = false;
          setTimeout(() => this.scrollToBottom(), 100);
        } else {
          this.userService.getUserById(data.userId).subscribe({
            next: (response) => {
              data.senderName = response.data.username;
              this.messageArray.push(data);
              this.isTyping = false;
              setTimeout(() => this.scrollToBottom(), 100);
            },
            error: (error) => {
              this.alertService.error(`Error fetching user: ${error || 'Unknown error'}`);
            }
          });
        }
      }
    });

    this.socketService.receivedTyping().subscribe((data: any) => {
      if (data.userId !== this.authService.getLoggedInUser()._id) {
        this.isTyping = data.isTyping;
      }
    });
  }

  setReply(message: any) {
    this.replyingTo = message;
    // Focus input
    const input = document.querySelector('.chat-input-section input');
    if (input) (input as HTMLElement).focus();
  }

  cancelReply() {
    this.replyingTo = null;
  }

  scrollToMessage(messageId: string) {
    if (!messageId) return;

    // Ensure ID is a string
    const id = messageId.toString();
    const element = document.getElementById('message-' + id);

    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.highlightedMessageId = id;

      // Remove highlight after 2 seconds
      setTimeout(() => {
        this.highlightedMessageId = null;
      }, 2000);
    }
  }

  toggleEmojiPicker(messageId: string) {
    this.showEmojiPicker = this.showEmojiPicker === messageId ? null : messageId;
  }

  addReaction(messageId: string, emoji: string) {
    this.socketService.sendReaction(messageId, emoji, this.conversationId);
    this.showEmojiPicker = null;
  }

  getReactionCount(reactions: any[], emoji: string) {
    return reactions ? reactions.filter(r => r.emoji === emoji).length : 0;
  }

  hasReacted(reactions: any[], emoji: string) {
    const myId = this.authService.getLoggedInUser()._id;
    return reactions ? reactions.some(r => r.userId === myId && r.emoji === emoji) : false;
  }

  getUniqueReactions(reactions: any[]) {
    if (!reactions) return [];
    const unique = [];
    const map = new Map();
    for (const item of reactions) {
      if (!map.has(item.emoji)) {
        map.set(item.emoji, true);
        unique.push(item.emoji);
      }
    }
    return unique;
  }

  toggleSearch() {
    this.showSearch = !this.showSearch;
    if (!this.showSearch) this.searchTerm = '';
  }

  get filteredMessages() {
    if (!this.searchTerm || this.searchTerm.length < 2) return this.messageArray;
    return this.messageArray.filter(msg =>
      msg.content?.toLowerCase().includes(this.searchTerm.toLowerCase())
    );
  }

  ngOnInit(): void {
    this.checkScreenSize();
    this.setupCallNotifications();
    this.loadChatConversations();
    this.loadGroupConversations();
    this.loadUsers();
    this.socketService.newMessageReceived().subscribe(message => {
      this.handleNewMessage(message);
    });
    this.socketService.messagesMarkedRead().subscribe(data => {
      this.handleMessagesMarkedRead(data);
    });
    document.addEventListener('paste', (event: ClipboardEvent) => this.handleClipboardFiles(event));
    window.addEventListener('resize', this.checkScreenSize.bind(this));

    this.socketService.onGroupCallParticipantJoined().subscribe((data: any) => {
      if (data?.userId) {
        this.groupCallParticipants.push(data.userId);
      }
    });

    this.socketService.onGroupCallParticipantLeft().subscribe((data: any) => {
      if (data?.userId) {
        this.groupCallParticipants = this.groupCallParticipants.filter(
          id => id !== data.userId
        );
      }
    });
  }

  checkScreenSize() {
    this.isMobileView = window.innerWidth <= 768;
    if (!this.isMobileView) {
      this.isSidebarOpen = true;
    }
  }

  ngOnDestroy() {
    this.callListenerSub?.unsubscribe();
    this.groupCallListenerSub?.unsubscribe();
    this.callStartedSub?.unsubscribe();
    this.meetingActiveSub?.unsubscribe();
    this.groupCallEndedSub?.unsubscribe();
  }

  ngAfterViewInit() {
    if (this.chatWindow)
      this.scrollToBottom();
  }

  setupInfiniteScroll() {
    if (this.chatWindowObserver) {
      this.chatWindowObserver.disconnect();
    }
    const scrollElement = this.chatWindow?.nativeElement.closest('ngx-simplebar')?.querySelector('.simplebar-content-wrapper');
    if (!scrollElement) return;

    this.chatWindowObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.hasMoreMessages && !this.isFetchingOldMessages) {
        this.fetchOldMessages();
      }
    }, {
      root: scrollElement,
      rootMargin: '0px',
      threshold: 0.1
    });

    if (this.topElement) {
      this.chatWindowObserver.observe(this.topElement.nativeElement);
    }
  }

  fetchOldMessages() {
    if (!this.conversationId || !this.hasMoreMessages) return;
    this.page++;
    this.isFetchingOldMessages = true;
    // save scroll height
    const scrollElement = this.chatWindow?.nativeElement.closest('ngx-simplebar')?.querySelector('.simplebar-content-wrapper');
    const oldScrollHeight = scrollElement?.scrollHeight || 0;

    this.userService.getMessages(this.conversationId, this.page, this.pageSize).subscribe(response => {
      if (response.success && response.data && response.data.length > 0) {
        let olderMessages = response.data;
        if (this.isGroupChat) {
          olderMessages = olderMessages.map((message: any) => {
            const sender = this.groupMembers.find(member => member._id === message.userId);
            if (sender) {
              message.senderName = sender.username;
            }
            return message;
          });
        }
        this.messageArray = [...olderMessages, ...this.messageArray];
        this.isFetchingOldMessages = false;
        if (response.data.length < this.pageSize) {
          this.hasMoreMessages = false;
        }

        this.cdr.detectChanges();
        if (scrollElement) {
          const newScrollHeight = scrollElement.scrollHeight;
          scrollElement.scrollTop = newScrollHeight - oldScrollHeight;
        }
      } else {
        this.hasMoreMessages = false;
        this.isFetchingOldMessages = false;
      }
    });
  }

  private setupCallNotifications() {
    this.callListenerSub = this.socketService.onIncomingCall().subscribe(async (data: any) => {
      const myUserId = this.authService.getLoggedInUser()._id;

      if (!data.offer || data.from === myUserId || data.to !== myUserId) return;

      if (this.callInProgress) {
        this.alertService.info('You are already in another call.');
        return;
      }

      this.userService.getUserById(data.from).subscribe({
        next: async (res) => {
          const callerName = res.data.username || 'Unknown User';
          const isVideo = data.callType === 'video';

          const result = await Swal.fire({
            title: isVideo ? 'Incoming video call' : 'Incoming audio call',
            html: `<div class="call-ring-body"><strong>${callerName}</strong> is calling you</div>`,
            icon: 'info',
            showCancelButton: true,
            confirmButtonText: 'Accept',
            cancelButtonText: 'Decline',
            confirmButtonColor: '#16a34a',
            cancelButtonColor: '#dc2626',
            allowOutsideClick: false,
            customClass: { popup: 'call-ring-popup' },
          });

          if (result.isConfirmed) {
            this.callInProgress = true;
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
    });

    // Audio / video ring for group + 1:1 (both use mediasoup now)
    this.groupCallListenerSub = this.socketService.onIncomingGroupCall().subscribe(async (data: any) => {
      if (!data?.callId || this.callInProgress) {
        return;
      }

      this.setActiveMeeting(data.groupId, {
        callId: data.callId,
        callType: data.callType || 'audio',
        mode: data.mode || 'ring',
      });

      if (data.mode === 'meetNow') {
        this.cdr.detectChanges();
        return;
      }

      const isVideo = data.callType === 'video';
      const result = await Swal.fire({
        title: isVideo ? 'Incoming video call' : 'Incoming audio call',
        text: 'Join the call?',
        icon: 'info',
        showCancelButton: true,
        confirmButtonText: 'Accept',
        cancelButtonText: 'Decline',
        confirmButtonColor: '#16a34a',
        cancelButtonColor: '#dc2626',
        allowOutsideClick: false,
        customClass: { popup: 'call-ring-popup' },
      });

      if (result.isConfirmed) {
        this.callInProgress = true;
        this.joinActiveGroupCall(data.groupId, data.callId, data.callType || 'audio');
      } else {
        this.socketService.rejectGroupCall(data.callId);
      }
    });

    this.meetingActiveSub = this.socketService.onMeetingActive().subscribe((data: any) => {
      if (!data?.groupId || !data?.callId) {
        return;
      }
      this.setActiveMeeting(data.groupId, {
        callId: data.callId,
        callType: data.callType || 'video',
        mode: 'meetNow',
      });
      this.cdr.detectChanges();
    });

    this.groupCallEndedSub = this.socketService.onGroupCallEnded().subscribe((data: any) => {
      const groupId = data?.groupId?.toString?.() || data?.groupId;
      const callId = data?.callId?.toString?.() || data?.callId;
      this.clearActiveMeeting(groupId, callId);
      this.cdr.detectChanges();
    });
  }

  get currentMeeting(): ActiveGroupMeeting | null {
    if (!this.isGroupChat || !this.conversationId) {
      return null;
    }
    return this.activeGroupCalls[this.conversationId] || null;
  }

  /** Join replaces Meet now only for an active Meet Now session */
  get activeMeetNow(): ActiveGroupMeeting | null {
    const meeting = this.currentMeeting;
    return meeting?.mode === 'meetNow' ? meeting : null;
  }

  private setActiveMeeting(groupId: string, meeting: ActiveGroupMeeting): void {
    this.activeGroupCalls = {
      ...this.activeGroupCalls,
      [groupId]: meeting,
    };
  }

  private clearActiveMeeting(groupId?: string, callId?: string): void {
    if (groupId && this.activeGroupCalls[groupId]) {
      const next = { ...this.activeGroupCalls };
      delete next[groupId];
      this.activeGroupCalls = next;
      return;
    }
    if (callId) {
      const id = callId.toString();
      const next = { ...this.activeGroupCalls };
      for (const key of Object.keys(next)) {
        if (next[key].callId?.toString() === id) {
          delete next[key];
        }
      }
      this.activeGroupCalls = next;
    }
  }

  startVideoCall(_receiverId: string) {
    if (!this.conversationId) {
      this.alertService.warning('Open the chat before starting a call');
      return;
    }
    // Use mediasoup SFU (same as group) — P2P fails across networks without TURN
    this.startGroupCall(this.conversationId, 'video', 'ring');
  }

  startAudioCall(_receiverId: string) {
    if (!this.conversationId) {
      this.alertService.warning('Open the chat before starting a call');
      return;
    }
    this.startGroupCall(this.conversationId, 'audio', 'ring');
  }

  startGroupAudioCall(conversationId: string) {
    this.startGroupCall(conversationId, 'audio', 'ring');
  }

  startMeetNow(conversationId: string) {
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
    this.callInProgress = true;
    this.joinActiveGroupCall(this.conversationId, meeting.callId, meeting.callType);
  }

  private joinActiveGroupCall(groupId: string, callId: string, callType: 'audio' | 'video') {
    this.router.navigate(['/group-call', groupId], {
      queryParams: { callId, callType },
    });
  }

  private startGroupCall(
    conversationId: string,
    callType: 'audio' | 'video',
    mode: 'ring' | 'meetNow'
  ) {
    this.callStartedSub?.unsubscribe();
    this.socketService.startGroupCall(conversationId, callType, mode);

    this.callStartedSub = this.socketService.onCallStarted().subscribe((data: any) => {
      if (data?.groupId !== conversationId) {
        return;
      }

      this.callStartedSub?.unsubscribe();
      this.setActiveMeeting(conversationId, {
        callId: data.callId,
        callType: data.callType || callType,
        mode: data.mode || mode,
      });
      this.sendCallNotificationMessage(conversationId, callType, data.callId, mode);
      this.callInProgress = true;
      this.router.navigate(['/group-call', conversationId], {
        queryParams: {
          callId: data.callId,
          callType,
        },
      });
    });
  }

  sendCallNotificationMessage(
    conversationId: string,
    callType: 'audio' | 'video',
    callId?: string,
    mode: 'ring' | 'meetNow' = 'ring'
  ) {
    const loggedInUser = this.authService.getLoggedInUser();
    const joinUrl = callId
      ? `${environment.BASE_URL}/group-call/${conversationId}?callId=${callId}&callType=${callType}`
      : `${environment.BASE_URL}/group-call/${conversationId}`;

    const messageData: any = {
      user: {
        _id: loggedInUser._id,
        username: loggedInUser.username,
        email: loggedInUser.email,
        avatar: loggedInUser.avatar,
        isOnline: loggedInUser.isOnline,
        lastSeen: loggedInUser.lastSeen,
      },
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

  loadUsers() {
    this.userService.getAllUsersExceptCurrentUser().subscribe({
      next: (response) => {
        this.users = response.data;
      },
      error: (error) => {
        this.alertService.error(`Failed to load users: ${error || 'Unknown error'}`);
      }
    });
  }

  onLogoutClick() {
    this.socketService.disconnectSocket();
    this.authService.logout();
    this.alertService.success('Logout Successfully.');
  }

  loadChatConversations() {
    this.isLoading = true;
    this.userService.getUserConversations().subscribe({
      next: (response) => {
        this.isLoading = false;
        this.chatData = response.data;
      },
      error: (error) => {
        this.isLoading = false;
        this.alertService.error(`Failed to load conversations: ${error || 'Unknown error'}`);
      }
    });
  }

  private loadGroupConversations() {
    this.userService.getUserGropuConversations().subscribe({
      next: (response) => {
        this.groupChatData = response.data;
      },
      error: (error) => {
        this.alertService.error(`Failed to load group conversations: ${error || 'Unknown error'}`);
      }
    });
  }

  startOrResumeChat(name: string, avatar: any, isOnline: boolean, conversationId: string, receiverId: string, lastSeen: Date) {
    this.cancelReply(); // Clear any active reply when switching chats
    this.isGroupChat = false;
    this.receiverId = receiverId;
    this.username = name;
    this.userProfile = avatar;
    this.isOnline = isOnline;
    this.lastSeen = lastSeen;

    this.page = 1;
    this.hasMoreMessages = true;
    this.isFetchingOldMessages = false;

    if (!conversationId) {
      this.startNewChat(receiverId, name, avatar);
    } else {
      this.conversationId = conversationId;
      this.loadMessages(this.conversationId);
      this.socketService.markMessagesAsRead(conversationId);
    }
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  startNewChat(userId: string, username: string, avatar: string) {
    this.userService.createOrGetConversation(userId).subscribe({
      next: (response) => {
        if (response && response.conversationId) {
          this.conversationId = response.conversationId;
          this.socketService.joinConversation(response.conversationId);
          this.username = username;
          this.userProfile = avatar;
          this.page = 1;
          this.hasMoreMessages = true;
          this.isFetchingOldMessages = false;
          this.loadMessages(this.conversationId);
          this.cdr.detectChanges();
        } else {
          this.alertService.error('Failed to create or retrieve conversation.');
        }
      },
      error: (error) => {
        this.alertService.error(`Failed to create or retrieve conversation: ${error || 'Unknown error'}`);
      }
    });
  }

  checkForActiveGroupCall() {
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
      this.cdr.detectChanges();
    } catch {
      this.clearActiveMeeting(groupId);
      this.cdr.detectChanges();
    }
  }

  openGroupConversation(group: any) {
    this.cancelReply(); // Clear any active reply when switching groups
    this.isGroupChat = true;
    this.groupname = group.groupName;
    this.groupAvatar = group.groupAvatar ? group.groupAvatar : '';
    this.conversationId = group._id;
    this.groupMembers = group.members;
    this.page = 1;
    this.hasMoreMessages = true;
    this.isFetchingOldMessages = false;
    this.loadMessages(this.conversationId);
    this.socketService.markMessagesAsRead(this.conversationId);
    this.isSidebarOpen = !this.isSidebarOpen;
    this.checkForActiveGroupCall();
  }

  typing(): void {
    const userId = this.authService.getLoggedInUser()._id;
    this.socketService.typing(this.conversationId, userId);
  }

  sendMessage() {
    this.message = this.formData.get('message')!.value?.trim();
    if (!this.message && !this.file) {
      return;
    }
    const loggedInUser = this.authService.getLoggedInUser();

    const messageData: any = {
      user: {
        _id: loggedInUser._id,
        username: loggedInUser.username,
        email: loggedInUser.email,
        avatar: loggedInUser.avatar,
        isOnline: loggedInUser.isOnline,
        lastSeen: loggedInUser.lastSeen
      },
      conversationId: this.conversationId,
      content: this.message,
      createdAt: new Date().toISOString(),
      replyTo: this.replyingTo ? this.replyingTo._id : null
    };
    if (this.file) {
      this.socketService.uploadFile(this.file).subscribe(response => {
        messageData.fileUrl = response.fileUrl;
        messageData.thumbnailUrl = response.thumbnailUrl;
        if (this.file?.type.startsWith("image")) {
          messageData.type = "image";
        } else if (this.file?.type.startsWith("video")) {
          messageData.type = "video";
        } else if (this.file?.type.startsWith("audio")) {
          messageData.type = "audio";
        } else if (this.file?.type === "application/pdf") {
          messageData.type = "pdf";
        } else {
          messageData.type = "unknown";
        }
        if (this.isGroupChat) {
          messageData.conversationId = this.conversationId;
          this.socketService.sendMessage(messageData);
        } else {
          this.socketService.sendMessage(messageData);
        }
        this.file = null;
        this.fileName = "";
        this.replyingTo = null;
        this.formData.reset();
        setTimeout(() => this.scrollToBottom(), 100);
      });
    } else {
      messageData.type = "text";
      this.socketService.sendMessage(messageData);

      this.replyingTo = null;
      setTimeout(() => this.scrollToBottom(), 100);
      this.formData.reset();
    }
  }

  removeSelectedImage() {
    this.fileName = "";
  }

  handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.file = input.files[0];
    }
    const reader = new FileReader();
    reader.onload = () => { this.fileName = reader.result as string; };
    reader.readAsDataURL(this.file!);
  }

  handleClipboardFiles(event: ClipboardEvent) {
    const clipboardItems: any = event.clipboardData?.items;
    for (let i = 0; i < clipboardItems?.length!; i++) {
      const item = clipboardItems[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          this.file = file;
          this.fileName = URL.createObjectURL(file);
          this.alertService.info('File copied from clipboard!');
        }
      }
    }
  }

  private loadMessages(conversationId: string): void {
    // Guard: Prevent double-loading the same conversation if a request is already in progress
    if (this.isLoading && this.conversationId === conversationId && this.page === 1) {
      return;
    }

    this.isLoading = true;
    this.isFetchingOldMessages = true; // Block infinite scroll while initial page loads

    if (this.isGroupChat) {
      this.socketService.joinGroup(conversationId);
      this.userService.getMessages(conversationId, this.page, this.pageSize).subscribe({
        next: (response) => {
          if (response.success) {
            this.messageArray = response.data.map((message: any) => {
              const sender = this.groupMembers?.find(member => member._id === message.userId);
              if (sender) {
                message.senderName = sender.username;
              }
              return message;
            });

            this.hasMoreMessages = response.data.length === this.pageSize;
            this.isLoading = false;

            this.cdr.detectChanges();
            this.setupInfiniteScroll();

            setTimeout(() => {
              this.scrollToBottom();
              this.isFetchingOldMessages = false; // Re-enable infinite scroll after rendering
            }, 500);
          }
        },
        error: () => {
          this.isLoading = false;
          this.isFetchingOldMessages = false;
        }
      });
    } else {
      this.socketService.joinConversation(conversationId);
      this.userService.getMessages(conversationId, this.page, this.pageSize).subscribe({
        next: (response) => {
          if (response.success) {
            this.messageArray = response.data;
            this.hasMoreMessages = response.data.length === this.pageSize;
            this.isLoading = false;

            this.cdr.detectChanges();
            this.setupInfiniteScroll();

            setTimeout(() => {
              this.scrollToBottom();
              this.isFetchingOldMessages = false; // Re-enable infinite scroll after rendering
            }, 500);
          }
        },
        error: () => {
          this.isLoading = false;
          this.isFetchingOldMessages = false;
        }
      });
    }
  }

  toggleGroupForm() {
    this.showGroupForm = !this.showGroupForm;
    if (this.showGroupForm) {
      this.loadUsers();
    }
  }

  onFileSelected(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length) {
      this.selectedFile = target.files[0];
    }
  }

  toggleDropdown() {
    this.showDropdown = !this.showDropdown;
  }

  selectUser(user: any) {
    if (!this.selectedMembers.find(u => u._id === user._id)) {
      this.selectedMembers.push(user);
      this.groupForm.get('groupMembers')?.setValue(this.selectedMembers.map(u => u._id));
    }
  }

  removeUser(user: any) {
    this.selectedMembers = this.selectedMembers.filter(u => u._id !== user._id);
    this.groupForm.get('groupMembers')?.setValue(this.selectedMembers.map(u => u._id));
  }

  isSelected(user: any): boolean {
    return !!this.selectedMembers.find(u => u._id === user._id);
  }

  createGroup() {
    this.isLoading = true;
    if (this.groupForm.invalid || this.selectedMembers.length < 2) {
      this.isLoading = false;
      this.alertService.error('Please provide a valid group name, description, and select at least 2 members.');
      return;
    }

    const groupData = {
      groupName: this.groupForm.get('groupName')?.value,
      groupAdmin: this.authService.getLoggedInUser()._id,
      members: this.groupForm.get('groupMembers')?.value,
      groupDescription: this.groupForm.get('groupDescription')?.value || ''
    };

    const formData = new FormData();

    formData.append('groupName', groupData.groupName);
    formData.append('groupAdmin', groupData.groupAdmin);
    formData.append('groupMembers', JSON.stringify(groupData.members));
    formData.append('groupDescription', groupData.groupDescription);

    if (this.selectedFile) {
      formData.append('image', this.selectedFile);
    }

    this.userService.createGroup(formData).subscribe({
      next: () => {
        this.isLoading = false;
        this.alertService.success('Group created successfully!');
        this.loadGroupConversations();
        this.showGroupForm = false;
        this.groupForm.reset();
        this.selectedMembers = [];
        this.selectedFile = null;
      },
      error: (error) => {
        this.isLoading = false;
        this.alertService.success(`${error || 'Group Conversation created Successfully!'}`);
      }
    });
  }


  formatTimestamp(dateString: string): string {
    if (!dateString) return '';

    const now = new Date();
    const messageDate = new Date(dateString);
    const diffMs = now.getTime() - messageDate.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffMinutes < 1) {
      return 'Just now';
    } else if (diffMinutes < 60) {
      return `${diffMinutes} min`;
    } else if (diffHours < 24) {
      return `${diffHours} Hr${diffHours > 1 ? 's' : ''}`;
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else {
      return messageDate.toLocaleDateString();
    }
  }

  openPreview(url: string, type: string) {
    this.previewUrl = url;
    this.previewType = type;
  }

  closePreview() {
    this.previewUrl = null;
    this.previewType = null;
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.chatWindow?.nativeElement) {
        const scrollElement = this.chatWindow.nativeElement.closest('ngx-simplebar')?.querySelector('.simplebar-content-wrapper');

        if (scrollElement) {
          scrollElement.scrollTop = scrollElement.scrollHeight;
        } else {
          console.error('Scrollable element not found inside ngx-simplebar');
        }
      }
    }, 50);
  }

  handleNewMessage(message: any) {
    const updateConversations = (conversations: any[]) => {
      if (!conversations) return [];
      const conversation = conversations.find(c => c._id === message.conversationId);
      if (conversation) {
        conversation.lastMessage = {
          content: message.content,
          createdAt: message.createdAt
        };

        if (this.conversationId !== message.conversationId &&
          message.userId !== this.authService.getLoggedInUser()._id) {
          conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        }
      }
      return conversations;
    };

    this.chatData = updateConversations(this.chatData);
    this.groupChatData = updateConversations(this.groupChatData);
    this.cdr.detectChanges();
  }

  handleMessagesMarkedRead(data: { conversationId: string, userId: string }) {
    const updateUnreadCount = (conversations: any[]) => {
      if (!conversations) return;
      const conversation = conversations.find(c => c._id === data.conversationId);
      if (conversation) {
        conversation.unreadCount = 0;
      }
    };

    updateUnreadCount(this.chatData);
    updateUnreadCount(this.groupChatData);
    this.cdr.detectChanges();
  }

  onCopyMessage(msg: any) {
    if (msg.type === 'image') {
      fetch(msg.fileUrl)
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
      const messageContent = msg.content;
      navigator.clipboard.writeText(messageContent).then(() => {
        this.alertService.info('Message copied!');
      }).catch((error) => {
        this.alertService.error(`Failed to copy message: ${error || 'Unknown error'}`);
      });
    }
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  deleteMessage(message: any) {
    Swal.fire({
      title: 'Are you sure?',
      text: "You won't be able to see this message again!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      cancelButtonColor: '#3085d6',
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

  deleteConversation(conversationId: string) {
    Swal.fire({
      title: 'Are you sure?',
      text: "You won't be able to see this conversation again!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      cancelButtonColor: '#3085d6',
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel'
    }).then((result) => {
      if (result.isConfirmed) {
        this.userService.deleteConversation(conversationId).subscribe({
          next: (res) => {
            this.chatData = this.chatData.filter(chat => chat._id !== conversationId);
            this.groupChatData = this.groupChatData.filter(chat => chat._id !== conversationId);
            this.alertService.success(`${res.message || 'Conversation deleted successfully!'}`);
          },
          error: (error) => {
            this.alertService.error(`${error || 'Unknown error'}`);
          }
        });
      }
    });
  }

  openUserProfile(userId: string) {
    const modalRef = this.modalService.open(ProfileComponent, {
      windowClass: 'custom-modal'
    });

    const loggedInUser = this.authService.getLoggedInUser();
    modalRef.componentInstance.userId = userId;

    // Only pass conversationId if we are viewing someone else's profile in a private chat
    if (userId !== loggedInUser?._id && !this.isGroupChat) {
      modalRef.componentInstance.conversationId = this.conversationId;
    }

    modalRef.componentInstance.modalRef = modalRef;
  }

  openGroupInfo(groupId: string) {
    const modalRef = this.modalService.open(GroupInfoComponent);
    modalRef.componentInstance.groupId = groupId;
    modalRef.componentInstance.modalRef = modalRef;
  }

  hasError(controlName: string, errorName: string): boolean {
    return this.groupForm.controls[controlName].touched && this.groupForm.controls[controlName].hasError(errorName);
  }

  referenceChatAndGroupList(conversationId: string, newMessage: any, chatListData: any[]) {
    if (!chatListData) return;
    const chatIndex = chatListData.findIndex(chat => chat._id === conversationId);

    if (chatIndex !== -1) {
      const updatedChat = { ...chatListData[chatIndex] };
      updatedChat.lastMessage = {
        ...updatedChat.lastMessage,
        content: newMessage.content,
        createdAt: newMessage.createdAt
      };

      chatListData.splice(chatIndex, 1);
      chatListData.unshift(updatedChat);
    }
  }

  saveMessage(message: any) {
    this.alertService.info("This feature is currently under development.");
  }

  forwardMessage(message: any) {
    this.alertService.info("This feature is currently under development.");
  }

  editCurrentUserProfile(userId: string) {
    this.alertService.info("This feature is currently under development.");
  }

}