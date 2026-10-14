import { Injectable, NgZone } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { BehaviorSubject, Subject, Subscription, filter, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { CallLaunch, CallMember } from 'src/app/pages/group-call/call.models';
import type { IncomingCall } from 'src/app/pages/chat/incoming-call/incoming-call.component';
import { CallNotificationService } from './call-notification.service';
import { MessageSenderService } from './message-sender.service';
import { SocketService } from './socket.service';
import { UserService } from './user.service';

export interface ActiveGroupMeeting {
  callId: string;
  callType: 'audio' | 'video';
  mode: 'ring' | 'meetNow';
}

interface PendingUrlCall {
  callId: string;
  groupId: string;
  callType: 'audio' | 'video';
  join: boolean;
}

/**
 * Owns the call surface for the whole app (it used to live inside the chat page): the active
 * call, the incoming ring, live meetings per conversation, starting / accepting / declining,
 * and mirroring the active call in the URL (`?call=…&g=…&t=…`) so a refresh rejoins it.
 *
 * Rendered by the application shell, so navigating between Chat / Calls / Calendar / … never
 * tears down the mediasoup session.
 */
@Injectable({ providedIn: 'root' })
export class CallManagerService {
  activeCall: CallLaunch | null = null;
  incomingCall: IncomingCall | null = null;
  minimized = false;
  meetings: { [groupId: string]: ActiveGroupMeeting } = {};

  /** Fires whenever any of the state above changes (for OnPush / markForCheck consumers). */
  readonly changed$ = new Subject<void>();
  /** Live meetings changed (chat list badges). */
  readonly meetings$ = new BehaviorSubject<{ [groupId: string]: ActiveGroupMeeting }>({});

  private directs: any[] = [];
  private groups: any[] = [];
  private directoryLoaded = false;
  private directoryLoading: Promise<void> | null = null;

  private subs = new Subscription();
  private started = false;
  private callStartedSub?: Subscription;
  private callStartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socket: SocketService,
    private users: UserService,
    private sender: MessageSenderService,
    private notifications: CallNotificationService,
    private alert: AlertService,
    private router: Router,
    private zone: NgZone,
  ) {}

  /** Called once by the shell after sign-in. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // Accept / Decline pressed on the system notification (service-worker notifications)
    this.subs.add(this.notifications.actions$.subscribe(({ callId, action }) => {
      if (!this.incomingCall || this.incomingCall.callId !== callId) {
        return;
      }
      if (action === 'accept') {
        this.acceptIncoming();
      } else if (action === 'decline') {
        this.declineIncoming();
      }
    }));

    // Audio / video ring for group + 1:1 (both use mediasoup)
    this.subs.add(this.socket.onIncomingGroupCall().subscribe((data: any) => {
      if (!data?.callId) {
        return;
      }
      this.setMeeting(String(data.groupId), { callId: String(data.callId), callType: data.callType || 'audio', mode: data.mode || 'ring' });
      if (data.mode === 'meetNow' || this.activeCall || this.incomingCall) {
        return;
      }
      void this.ring(data);
    }));

    this.subs.add(this.socket.onMeetingActive().subscribe((data: any) => {
      if (data?.groupId && data?.callId) {
        this.setMeeting(String(data.groupId), { callId: String(data.callId), callType: data.callType || 'video', mode: 'meetNow' });
      }
    }));

    this.subs.add(this.socket.onGroupCallEnded().subscribe((data: any) => {
      const groupId = data?.groupId != null ? String(data.groupId) : undefined;
      const callId = data?.callId != null ? String(data.callId) : undefined;
      this.clearMeeting(groupId, callId);
      if (this.incomingCall && this.incomingCall.callId === callId) {
        this.incomingCall = null;
        this.emit();
      }
    }));

    this.subs.add(this.socket.onCallError().subscribe((data: any) => {
      // Only surface errors for a call we are trying to start (in-call errors are shown by the call UI)
      if (this.callStartTimer) {
        this.cancelStartWait();
        this.alert.error(data?.message || "We couldn't start the call. Please try again.");
      }
    }));

    // `?call=…` on any page → open (or after a refresh, rejoin) that call
    const readUrl = () => {
      const tree = this.router.parseUrl(this.router.url);
      const callId = tree.queryParams['call'];
      const groupId = tree.queryParams['g'];
      if (!callId || !groupId || this.activeCall?.callId === callId) {
        return;
      }
      void this.openFromUrl({
        callId,
        groupId,
        callType: tree.queryParams['t'] === 'audio' ? 'audio' : 'video',
        join: tree.queryParams['join'] === '1',
      });
    };
    this.subs.add(this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(readUrl));
    readUrl();
  }

  stop(): void {
    this.subs.unsubscribe();
    this.subs = new Subscription();
    this.started = false;
    this.cancelStartWait();
    this.activeCall = null;
    this.incomingCall = null;
    this.meetings = {};
    this.meetings$.next({});
    this.directs = [];
    this.groups = [];
    this.directoryLoaded = false;
    this.directoryLoading = null;
  }

  // ---------------------------------------------------------------- conversation directory

  /** The chat page shares the lists it already loaded, so calls don't refetch them. */
  setConversations(directs: any[], groups: any[]): void {
    this.directs = directs;
    this.groups = groups;
    this.directoryLoaded = true;
  }

  isGroupConversation(conversationId: string): boolean {
    return this.groups.some((g) => String(g._id) === String(conversationId));
  }

  private async ensureDirectory(conversationId?: string): Promise<void> {
    const known = conversationId && (
      this.groups.some((g) => String(g._id) === conversationId) ||
      this.directs.some((c) => String(c._id) === conversationId));
    if (known || (this.directoryLoaded && !conversationId)) {
      return;
    }
    if (!this.directoryLoading) {
      this.directoryLoading = (async () => {
        try {
          const [d, da, g, ga] = await Promise.all([
            firstValueFrom(this.users.getUserConversations()),
            firstValueFrom(this.users.getUserConversations(true)),
            firstValueFrom(this.users.getUserGropuConversations()),
            firstValueFrom(this.users.getUserGropuConversations(true)),
          ]);
          this.directs = [...(d?.data || []), ...(da?.data || [])];
          this.groups = [...(g?.data || []), ...(ga?.data || [])];
          this.directoryLoaded = true;
        } catch {
          // Calls still work with generic titles
        } finally {
          this.directoryLoading = null;
        }
      })();
    }
    await this.directoryLoading;
  }

  // ---------------------------------------------------------------- meetings

  meetingFor(groupId: string | null | undefined): ActiveGroupMeeting | null {
    return groupId ? this.meetings[groupId] || null : null;
  }

  isLive(callId: string | null | undefined): boolean {
    return !!callId && Object.values(this.meetings).some((m) => String(m.callId) === String(callId));
  }

  inCall(groupId: string | null | undefined): boolean {
    return !!groupId && !!this.activeCall && this.activeCall.groupId === groupId;
  }

  async refreshMeeting(groupId: string): Promise<void> {
    try {
      const res = await this.socket.getActiveGroupCall(groupId);
      if (res?.call) {
        this.setMeeting(groupId, { callId: String(res.call.callId), callType: res.call.callType, mode: res.call.mode || 'ring' });
      } else {
        this.clearMeeting(groupId);
      }
    } catch {
      this.clearMeeting(groupId);
    }
  }

  private setMeeting(groupId: string, meeting: ActiveGroupMeeting): void {
    this.meetings = { ...this.meetings, [groupId]: meeting };
    this.meetings$.next(this.meetings);
    this.emit();
  }

  private clearMeeting(groupId?: string, callId?: string): void {
    const next = { ...this.meetings };
    if (groupId && next[groupId]) {
      delete next[groupId];
    } else if (callId) {
      for (const key of Object.keys(next)) {
        if (String(next[key].callId) === callId) {
          delete next[key];
        }
      }
    }
    this.meetings = next;
    this.meetings$.next(next);
    this.emit();
  }

  // ---------------------------------------------------------------- start / join

  /** Ring a 1:1 / group, or start a group "Meet now". */
  startCall(conversationId: string, callType: 'audio' | 'video', mode: 'ring' | 'meetNow'): void {
    if (this.activeCall) {
      if (this.activeCall.groupId === conversationId) {
        this.restore();
      } else {
        this.alert.info('Leave your current call before starting another one.');
      }
      return;
    }
    if (mode === 'meetNow' && this.meetings[conversationId]) {
      void this.joinMeeting(conversationId);
      return;
    }

    this.cancelStartWait();
    this.socket.startGroupCall(conversationId, callType, mode);

    this.callStartTimer = setTimeout(() => {
      this.cancelStartWait();
      this.alert.error("We couldn't connect the call. Please check your connection and try again.");
    }, 10000);

    this.callStartedSub = this.socket.onCallStarted().subscribe(async (data: any) => {
      if (String(data?.groupId) !== String(conversationId)) {
        return;
      }
      this.cancelStartWait();
      const effectiveType: 'audio' | 'video' = data.callType || callType;
      const effectiveMode: 'ring' | 'meetNow' = data.mode || mode;
      this.setMeeting(conversationId, { callId: String(data.callId), callType: effectiveType, mode: effectiveMode });
      // Group "Meet now" posts a Join message. Calls get a chat message only once they connected
      // and ended (the server writes it); missed / declined calls appear in Call History only.
      if (!data.resumed && effectiveMode === 'meetNow') {
        this.postCallMessage(conversationId, effectiveType, String(data.callId), effectiveMode);
      }
      await this.ensureDirectory(conversationId);
      const isGroup = this.isGroupConversation(conversationId);
      this.open(this.buildLaunch(conversationId, String(data.callId), effectiveType, {
        prejoin: isGroup && effectiveMode === 'meetNow',
        isInitiator: !data.resumed,
      }));
    });
  }

  /** Join the live meeting / call of a conversation (lobby for groups). */
  async joinMeeting(groupId: string, callId?: string): Promise<void> {
    const meeting = this.meetings[groupId];
    const id = callId || meeting?.callId;
    if (!id) {
      this.alert.info('This call has ended.');
      return;
    }
    await this.ensureDirectory(groupId);
    this.open(this.buildLaunch(groupId, id, meeting?.callType || 'video', { prejoin: this.isGroupConversation(groupId) }));
  }

  /** Join a call referenced by its id only (e.g. a call message). */
  async joinByCallId(callId: string): Promise<void> {
    const entry = Object.entries(this.meetings).find(([, m]) => String(m.callId) === String(callId));
    if (!entry) {
      this.alert.info('This call has ended.');
      return;
    }
    await this.joinMeeting(entry[0], callId);
  }

  open(launch: CallLaunch): void {
    if (this.activeCall) {
      if (this.activeCall.callId === launch.callId) {
        this.restore();
      } else {
        this.alert.info('You are already in another call.');
      }
      return;
    }
    if (this.incomingCall?.callId === launch.callId) {
      this.incomingCall = null;
    }
    this.activeCall = launch;
    this.minimized = false;
    this.emit();
    // Mirror the call in the URL so a refresh rejoins it
    void this.router.navigate([], {
      queryParams: { call: launch.callId, g: launch.groupId, t: launch.callType, join: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** The call surface closed (left / ended / failed). */
  closed(): void {
    const groupId = this.activeCall?.groupId;
    this.activeCall = null;
    this.minimized = false;
    this.emit();
    void this.router.navigate([], {
      queryParams: { call: null, g: null, t: null, join: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (groupId && this.isGroupConversation(groupId)) {
      void this.refreshMeeting(groupId);
    }
  }

  setMinimized(value: boolean): void {
    if (this.minimized !== value) {
      this.minimized = value;
      this.emit();
    }
  }

  restore(): void {
    this.setMinimized(false);
  }

  // ---------------------------------------------------------------- incoming

  acceptIncoming(): void {
    const call = this.incomingCall;
    if (!call) {
      return;
    }
    this.incomingCall = null;
    this.open(this.buildLaunch(call.groupId, call.callId, call.callType, { prejoin: false }));
  }

  declineIncoming(): void {
    if (this.incomingCall) {
      this.socket.rejectGroupCall(this.incomingCall.callId);
      this.incomingCall = null;
      this.emit();
    }
  }

  private async ring(data: any): Promise<void> {
    const groupId = String(data.groupId);
    const callerId = String(data.initiatedBy || '');
    const callId = String(data.callId);
    // Show the ring immediately; fill in names once known
    this.incomingCall = {
      callId,
      groupId,
      callType: data.callType === 'video' ? 'video' : 'audio',
      isGroup: this.isGroupConversation(groupId),
      callerId,
      callerName: 'Someone',
    };
    this.applyCallerDetails(callerId);
    this.emit();

    await this.ensureDirectory(groupId);
    if (this.incomingCall?.callId !== callId) {
      return;
    }
    this.applyCallerDetails(callerId);
    this.emit();

    if (this.incomingCall.callerName === 'Someone' && callerId) {
      try {
        const res = await firstValueFrom(this.users.getUserById(callerId));
        if (this.incomingCall?.callId === callId) {
          this.incomingCall = {
            ...this.incomingCall,
            callerName: res.data.username || 'Someone',
            avatar: this.incomingCall.isGroup ? this.incomingCall.avatar : res.data.avatar,
          };
          this.emit();
        }
      } catch {
        // keep the generic name
      }
    }
  }

  private applyCallerDetails(callerId: string): void {
    const call = this.incomingCall;
    if (!call) {
      return;
    }
    const group = this.groups.find((g) => String(g._id) === call.groupId);
    const direct = this.directs.find((c) => String(c._id) === call.groupId);
    const caller =
      group?.members?.find((m: any) => String(m._id) === callerId) ||
      (direct?.receiver && String(direct.receiver._id) === callerId ? direct.receiver : null);
    this.incomingCall = {
      ...call,
      isGroup: !!group,
      callerName: caller?.username || call.callerName,
      avatar: group ? group.groupAvatar : caller?.avatar || call.avatar,
      groupName: group?.groupName,
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Everything the call surface needs, resolved from the known conversations. */
  buildLaunch(groupId: string, callId: string, callType: 'audio' | 'video', opts: { prejoin?: boolean; isInitiator?: boolean } = {}): CallLaunch {
    const group = this.groups.find((g) => String(g._id) === String(groupId));
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
    const peer = this.directs.find((c) => String(c._id) === String(groupId))?.receiver;
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

  private async openFromUrl(pending: PendingUrlCall): Promise<void> {
    await this.ensureDirectory(pending.groupId);
    if (this.activeCall) {
      return;
    }
    const isGroup = this.isGroupConversation(pending.groupId);
    this.open(this.buildLaunch(pending.groupId, pending.callId, pending.callType, {
      // From a join link → lobby; from a refresh → straight back in
      prejoin: isGroup && pending.join,
    }));
  }

  private postCallMessage(conversationId: string, callType: 'audio' | 'video', callId: string, mode: 'ring' | 'meetNow'): void {
    const joinUrl = `${environment.BASE_URL}/group-call/${conversationId}?callId=${callId}&callType=${callType}`;
    this.socket.sendGroupMessage({
      user: this.sender.currentUserPayload(),
      conversationId,
      content: mode === 'meetNow' ? 'Meeting started — tap Join to enter.' : callType === 'video' ? 'Video call started.' : 'Audio call started.',
      fileUrl: joinUrl,
      type: 'call',
      createdAt: new Date().toISOString(),
    } as any);
  }

  private cancelStartWait(): void {
    this.callStartedSub?.unsubscribe();
    this.callStartedSub = undefined;
    if (this.callStartTimer) {
      clearTimeout(this.callStartTimer);
      this.callStartTimer = null;
    }
  }

  private emit(): void {
    this.zone.run(() => this.changed$.next());
  }
}
