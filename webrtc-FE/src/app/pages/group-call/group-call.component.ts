import { AlertService } from 'src/app/_shared/alert/alert.service';
import { avatarColors, avatarInitials } from 'src/app/core/utils/avatar.util';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
  NgZone,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { normalizeMediaError } from '../../core/errors/app-error';
import { LobbyEntry, MeetingRole, MeetingSettings } from '../../core/services/socket.service';
import { AuthService } from '../../core/services/auth.service';
import { CallStateSnapshot, SocketService } from '../../core/services/socket.service';
import { MediasoupService } from '../../core/services/mediasoup.service';
import { UserService } from '../../core/services/user.service';
import { CallPipHandlers, CallPipService } from '../../core/services/call-pip.service';
import {
  listMediaDevices,
  supportsAudioOutputSelection,
  supportsScreenShare,
} from '../../core/utils/media-devices.util';
import { CALL_REACTIONS, CallLaunch, PrejoinResult, StageItem } from './call.models';
import { VIDEO_EFFECTS, VideoEffect } from '../../core/services/video-effects.service';

interface RemoteParticipant {
  userId: string;
  name: string;
  avatar?: string;
  /** Combined stream from MediasoupService (audio + camera) */
  stream: MediaStream | null;
  /** Stable per-kind streams bound to <video>/<audio> — re-creating them causes stuck tiles */
  displayVideo: MediaStream;
  displayAudio: MediaStream;
  audioOn: boolean;
  videoOn: boolean;
  /** Received their call:media-state, i.e. their client is in the call */
  mediaKnown: boolean;
  handRaised: boolean;
  joinedAt: number;
}

interface FloatingReaction {
  id: number;
  emoji: string;
  name: string;
  left: number;
}

interface PersonRow {
  userId: string;
  name: string;
  /** Name without the "(You)" label, for the generated avatar. */
  avatarName: string;
  avatar?: string;
  isSelf: boolean;
  isHost: boolean;
  audioOn: boolean;
  videoOn: boolean;
  speaking: boolean;
  handRaised: boolean;
  connecting: boolean;
}

type CallPhase = 'prejoin' | 'joining' | 'lobby' | 'live' | 'ended';
/** solo = alone · pip = 2 people (P2P) · speaker = main + side strip · gallery = grid */
type StageLayout = 'solo' | 'pip' | 'speaker' | 'gallery';
type ViewMode = 'gallery' | 'speaker';

/** Profiles survive across calls so re-joins don't refetch everyone. */
const profileCache = new Map<string, { name: string; avatar?: string }>();

@Component({
  selector: 'app-group-call',
  templateUrl: './group-call.component.html',
  styleUrls: ['./group-call.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupCallComponent implements OnInit, OnDestroy {
  @Input() launch!: CallLaunch;
  /** Minimized = the call continues in the browser's Picture-in-Picture window. */
  @Input() set minimized(value: boolean) {
    this.isMinimized = value;
    if (!value) {
      this.pip?.exit();
    }
  }
  get minimized(): boolean {
    return this.isMinimized;
  }
  @Output() minimizedChange = new EventEmitter<boolean>();
  private isMinimized = false;

  @Output() closed = new EventEmitter<void>();

  @HostBinding('class.is-minimized') get hostMinimized(): boolean {
    return this.minimized;
  }

  readonly reactionsList = CALL_REACTIONS;
  readonly canShareScreen = supportsScreenShare();
  readonly canPickSpeaker = supportsAudioOutputSelection();

  phase: CallPhase = 'joining';
  endMessage = '';
  callId = '';
  callType: 'audio' | 'video' = 'video';
  /** ring = invitees get an incoming-call screen; meetNow = soft "Join" in the chat */
  mode: 'ring' | 'meetNow' = 'ring';
  isGroup = false;
  myUserId = '';
  myName = 'You';
  myAvatar = '';

  // Local media
  localStream: MediaStream | null = null;
  localScreenStream: MediaStream | null = null;
  isMuted = false;
  /** Speaking while muted (Teams-style hint) */
  talkingWhileMuted = false;
  private muteWatch: { ctx: AudioContext; track: MediaStreamTrack; timer: ReturnType<typeof setInterval> } | null = null;
  private lastMutedHint = 0;
  /** Presenter toolbar position (px from top-left), remembered per browser */
  presenterPos = this.readPresenterPos();
  private presenterDrag: { dx: number; dy: number } | null = null;
  isVideoEnabled = true;
  isScreenSharing = false;
  /** monitor = entire screen (call PiP would be captured); window/browser = safe to float the call */
  shareDisplaySurface: 'monitor' | 'window' | 'browser' | '' = '';
  hasAudioDevice = false;
  hasVideoDevice = false;
  handRaised = false;

  // Remote state
  private remotes = new Map<string, RemoteParticipant>();
  private remoteScreen: { userId: string; stream: MediaStream } | null = null;
  activeScreenUserId: string | null = null;
  hostIds = new Set<string>();
  cohostIds = new Set<string>();
  myRole: MeetingRole = 'attendee';
  meetingSettings: MeetingSettings = { lobby: false, allowUnmute: true, allowShare: true };
  lobbyWaiting: LobbyEntry[] = [];
  /** Recording in progress: when it started (for the REC timer) */
  recordingSince: number | null = null;
  recordingAvailable = false;
  recordingBusy = false;
  showOptions = false;
  private admission: { resolve: () => void; reject: (e: Error) => void } | null = null;
  startedAt: number | null = null;
  private speaking = new Set<string>();
  activeSpeakerId: string | null = null;
  private speakerCandidate: string | null = null;
  private speakerCandidateSince = 0;
  pinnedKey: string | null = null;

  // Connectivity
  private mediaDown = false;
  private socketDown = false;
  networkQuality: 'good' | 'fair' | 'poor' | null = null;
  private readonly onDeviceChange = () => void this.handleDeviceChange();

  // Derived view state (recomputed on change, never in template getters)
  mainItem: StageItem | null = null;
  sideItems: StageItem[] = [];
  remoteAudio: RemoteParticipant[] = [];
  layout: StageLayout = 'solo';
  /** Chosen view for 3+ participants (2 people always use the P2P layout). */
  viewMode: ViewMode = 'gallery';
  galleryItems: StageItem[] = [];
  galleryPage = 0;
  galleryPages = 1;
  galleryCount = 0;
  audioLayout = false;
  statusLabel = '';
  people: PersonRow[] = [];
  participantCount = 1;
  mediaKick = 0;
  sinkId = '';

  // Panels / menus
  showPeople = false;
  showMore = false;
  showReactions = false;
  /** Teams-style split buttons: device/effect menus next to Mic and Camera. */
  showAudioMenu = false;
  showVideoMenu = false;
  showInfo = false;
  showView = false;
  showChat = false;
  chatUnread = 0;
  isFullscreen = false;
  peopleSearch = '';
  reactions: FloatingReaction[] = [];
  notice: string | null = null;

  microphones: MediaDeviceInfo[] = [];
  cameras: MediaDeviceInfo[] = [];
  speakers: MediaDeviceInfo[] = [];
  selectedMic = '';
  selectedCam = '';
  readonly videoEffects = VIDEO_EFFECTS;
  /** Effect being switched to (model download / pipeline start). */
  effectBusy: VideoEffect | null = null;
  noiseBusy = false;

  private subs = new Subscription();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private stateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reactionSeq = 0;
  private lastReactionSent = 0;
  private everHadRemote = false;
  private finished = false;
  private destroyed = false;

  constructor(
    private authService: AuthService,
    private socketService: SocketService,
    private mediasoupService: MediasoupService,
    private userService: UserService,
    public pip: CallPipService,
    private cdr: ChangeDetectorRef,
    private host: ElementRef<HTMLElement>,
    private zone: NgZone,
    private alertService: AlertService,
  ) { }

  // ---------------------------------------------------------------- lifecycle

  ngOnInit(): void {
    const me = this.authService.getLoggedInUser();
    this.myUserId = me?._id || '';
    this.myAvatar = me?.avatar || '';
    this.callId = this.launch.callId;
    this.callType = this.launch.callType || 'video';
    this.isGroup = !!this.launch.isGroup;
    this.isVideoEnabled = this.callType === 'video';
    (this.launch.members || []).forEach((m) => {
      if (m?._id && m.username && !profileCache.has(m._id)) {
        profileCache.set(m._id, { name: m.username, avatar: m.avatar });
      }
    });

    void this.unlockAudioPlayback();
    this.bindEvents();

    if (this.launch.prejoin) {
      this.phase = 'prejoin';
      this.render();
    } else {
      void this.enterCall(null);
    }
  }

  // ---------------------------------------------------------------- muted hint / presenter bar

  /** While muted, listen locally (a clone of the mic track; nothing is sent) to hint "You're muted". */
  private syncMutedWatch(): void {
    const want = this.isMuted && this.hasAudioDevice && this.phase === 'live' && !this.destroyed;
    if (want && !this.muteWatch) {
      this.startMutedWatch();
    } else if (!want && this.muteWatch) {
      this.stopMutedWatch();
    }
  }

  private startMutedWatch(): void {
    const source = this.mediasoupService.getLocalStream()?.getAudioTracks()[0];
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!source || !Ctx || source.readyState !== 'live') {
      return;
    }
    try {
      const track = source.clone();
      track.enabled = true;
      const ctx: AudioContext = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let loudFor = 0;
      const timer = this.zone.runOutsideAngular(() => setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / data.length);
        loudFor = rms > 0.06 ? loudFor + 200 : 0;
        const show = loudFor >= 800 && Date.now() - this.lastMutedHint > 20_000;
        if (show) {
          this.lastMutedHint = Date.now();
          this.talkingWhileMuted = true;
          this.zone.run(() => this.render());
          this.timers.add(setTimeout(() => this.zone.run(() => {
            this.talkingWhileMuted = false;
            this.render();
          }), 6000));
        }
      }, 200));
      this.muteWatch = { ctx, track, timer };
    } catch {
      // Hint is optional
    }
  }

  private stopMutedWatch(): void {
    if (!this.muteWatch) {
      return;
    }
    clearInterval(this.muteWatch.timer);
    this.muteWatch.track.stop();
    void this.muteWatch.ctx.close().catch(() => undefined);
    this.muteWatch = null;
    this.talkingWhileMuted = false;
  }

  private readPresenterPos(): { x: number; y: number } | null {
    try {
      const raw = localStorage.getItem('call.presenterBar');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  onPresenterDragStart(event: PointerEvent, bar: HTMLElement): void {
    const rect = bar.getBoundingClientRect();
    this.presenterDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  onPresenterDragMove(event: PointerEvent, bar: HTMLElement): void {
    if (!this.presenterDrag) {
      return;
    }
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    this.presenterPos = {
      x: Math.min(Math.max(8, event.clientX - this.presenterDrag.dx), window.innerWidth - w - 8),
      y: Math.min(Math.max(8, event.clientY - this.presenterDrag.dy), window.innerHeight - h - 8),
    };
    this.render();
  }

  onPresenterDragEnd(): void {
    if (!this.presenterDrag) {
      return;
    }
    this.presenterDrag = null;
    try {
      localStorage.setItem('call.presenterBar', JSON.stringify(this.presenterPos));
    } catch {
      // ignore
    }
  }

  /** Keyboard users move the bar with the arrow keys on the handle. */
  nudgePresenter(event: KeyboardEvent, bar: HTMLElement): void {
    const step = event.shiftKey ? 40 : 12;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[event.key];
    if (!d) {
      return;
    }
    event.preventDefault();
    const rect = bar.getBoundingClientRect();
    this.presenterPos = {
      x: Math.min(Math.max(8, rect.left + d[0]), window.innerWidth - rect.width - 8),
      y: Math.min(Math.max(8, rect.top + d[1]), window.innerHeight - rect.height - 8),
    };
    this.onPresenterDragEnd();
    this.presenterDrag = null;
    this.render();
  }

  ngOnDestroy(): void {
    this.stopMutedWatch();
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.destroyed = true;
    this.subs.unsubscribe();
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    if (this.stateRefreshTimer) {
      clearTimeout(this.stateRefreshTimer);
    }
    this.pip.release();
    if (!this.finished && this.callId) {
      this.finished = true;
      this.socketService.leaveGroupCall(this.callId);
      void this.mediasoupService.close();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (this.minimized || this.phase !== 'live') {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && event.shiftKey && key === 'm') {
      event.preventDefault();
      this.toggleMute();
    } else if (mod && event.shiftKey && key === 'o') {
      event.preventDefault();
      void this.toggleVideo();
    } else if (key === 'escape') {
      this.closeMenus();
    }
  }

  // ---------------------------------------------------------------- joining

  onPrejoinJoin(result: PrejoinResult): void {
    void this.enterCall(result);
  }

  onPrejoinCancel(): void {
    void this.finish('', true, 0);
  }

  private async enterCall(pre: PrejoinResult | null): Promise<void> {
    this.phase = 'joining';
    this.render();
    if (!(await this.claimCallForThisDevice())) {
      return;
    }
    try {
      const acceptResult = await this.socketService.acceptGroupCall(this.callId);
      if (acceptResult?.error) {
        throw new Error(acceptResult.error);
      }

      await this.mediasoupService.initialize();
      let response = await this.mediasoupService.joinCall(this.callId, this.callType);
      // Lobby: wait here until a host / co-host lets us in (or denies / we leave)
      while (response.lobby) {
        this.phase = 'lobby';
        this.render();
        await this.waitForAdmission();
        if (this.finished) {
          return;
        }
        this.phase = 'joining';
        this.render();
        response = await this.mediasoupService.joinCall(this.callId, this.callType);
      }

      let localStream: MediaStream;
      try {
        localStream = await this.mediasoupService.startLocalMedia(this.callType, { stream: pre?.stream });
      } catch (mediaErr: any) {
        if (mediaErr?.name === 'NotAllowedError') {
          localStream = new MediaStream();
          this.showNotice('Media permission denied. You joined without mic/camera.');
        } else {
          throw mediaErr;
        }
      }
      if (this.finished) {
        return;
      }

      this.hasAudioDevice = this.mediasoupService.hasAudioDevice;
      this.hasVideoDevice = this.mediasoupService.hasVideoDevice;
      this.isMuted = !this.hasAudioDevice || (pre ? !pre.micOn : false);
      if (this.hasAudioDevice && this.isMuted) {
        this.mediasoupService.setAudioEnabled(false);
      }
      this.isVideoEnabled = this.hasVideoDevice && (pre ? pre.camOn : this.callType === 'video');
      this.localStream = localStream;
      this.phase = 'live';
      this.broadcastMediaState();
      this.render();

      // Consume existing + future producers in the background
      void this.consumeExistingProducers(response.producers || []);
      await this.refreshCallState();
    } catch (error: any) {
      if (this.finished) {
        // The call already ended (e.g. declined) while joining; that outcome is shown instead
        return;
      }
      console.error('Failed to join call:', error);
      const insecure =
        typeof window !== 'undefined' &&
        !window.isSecureContext &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1';
      const message = insecure
        ? 'Camera/mic need HTTPS. Run npm run dev and open the https URL.'
        : "We couldn't connect the call. Please check your connection and try again.";
      await this.finish(message, false, 2200);
    }
  }

  /**
   * One call per user: when this user is live in a call on another device, ask before moving it
   * here. Cancel leaves the other device untouched. Returns false when this device must not join.
   */
  private async claimCallForThisDevice(): Promise<boolean> {
    const session = await this.socketService.getCallSession();
    if (!session.elsewhere) {
      return true;
    }
    const choice = await this.alertService.confirm({ title: "You're already in a call on another device.", confirmText: 'End call on other device & join here', cancelText: 'Cancel' });
    if (this.finished) {
      return false;
    }
    if (!choice) {
      // Joining the call the other device is in: just don't join. A different (e.g. just
      // started) call: leave it so it doesn't keep ringing.
      await this.finish('', !!session.callId && String(session.callId) !== String(this.callId), 0);
      return false;
    }
    const res = await this.socketService.takeoverCall(this.callId);
    if (res.error) {
      await this.finish(`Couldn't join: ${res.error}`, false, 2200);
      return false;
    }
    return true;
  }

  private async consumeExistingProducers(
    producers: { producerId: string; userId: string; kind: 'audio' | 'video'; source?: string }[]
  ): Promise<void> {
    for (const producer of producers) {
      try {
        await Promise.race([
          this.mediasoupService.consumeProducer(
            producer.producerId,
            producer.userId,
            producer.kind,
            producer.source || 'camera'
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('consume timeout')), 12000)),
        ]);
      } catch (err) {
        console.warn('Failed to consume producer', producer.producerId, err);
      }
    }
  }

  private async refreshCallState(): Promise<void> {
    const state = await this.socketService.getCallState(this.callId);
    if (state && !this.finished) {
      this.applyState(state);
    }
  }

  /** Debounced: several joins in a burst cause one state fetch. */
  private scheduleStateRefresh(): void {
    if (this.stateRefreshTimer) {
      clearTimeout(this.stateRefreshTimer);
    }
    this.stateRefreshTimer = setTimeout(() => {
      this.stateRefreshTimer = null;
      void this.refreshCallState();
    }, 400);
  }

  private applyState(state: CallStateSnapshot): void {
    this.hostIds = new Set(state.hostIds || []);
    this.cohostIds = new Set(state.cohostIds || []);
    this.myRole = state.myRole || (this.isGroup ? 'attendee' : 'host');
    if (state.settings) {
      this.meetingSettings = state.settings;
    }
    this.lobbyWaiting = state.lobby || [];
    this.recordingAvailable = !!state.recordingAvailable;
    this.recordingSince = state.recording ? state.recording.startedAt : null;
    this.isGroup = state.isGroup;
    this.applyStartTime(state);
    if (state.callType) {
      this.callType = state.callType;
    }
    this.mode = state.mode || this.mode;
    (state.participants || []).forEach((id) => {
      if (id !== this.myUserId) {
        this.ensureRemote(id);
      }
    });
    Object.entries(state.media || {}).forEach(([id, media]) => {
      const p = this.remotes.get(id);
      if (p) {
        p.audioOn = media.audio;
        p.videoOn = media.video;
        p.mediaKnown = true;
      }
    });
    const hands = new Set(state.hands || []);
    this.remotes.forEach((p) => (p.handRaised = hands.has(p.userId)));
    if (state.screenSharerUserId && state.screenSharerUserId !== this.myUserId) {
      this.activeScreenUserId = state.screenSharerUserId;
      const existing = this.mediasoupService.getRemoteScreenStream(state.screenSharerUserId);
      if (existing) {
        this.remoteScreen = { userId: state.screenSharerUserId, stream: existing };
      }
    }
    this.render();
  }

  /**
   * The timer counts from `startedAt` on this device's clock. Device clocks are often minutes off
   * from the server's (a clock behind the server froze the timer at 00:00; one ahead started it
   * at minutes), so the start is derived from the server-measured elapsed time instead.
   */
  private applyStartTime(state: CallStateSnapshot): void {
    let start: number | null = null;
    if (typeof state.elapsedMs === 'number' && state.elapsedMs >= 0) {
      start = Date.now() - state.elapsedMs;
    } else if (state.startedAt) {
      start = new Date(state.startedAt).getTime(); // older server: best effort
    }
    // Ignore sub-second network jitter on repeated refreshes so the timer doesn't jump
    if (start !== null && (this.startedAt === null || Math.abs(start - this.startedAt) > 1500)) {
      this.startedAt = start;
    }
  }

  // ---------------------------------------------------------------- events

  private bindEvents(): void {
    const sameCall = (data: any) => data?.callId != null && String(data.callId) === String(this.callId);

    // Unread badge on the Chat button while the meeting chat is closed
    this.subs.add(this.socketService.newMessageReceived().subscribe((data: any) => {
      const fromOther = String(data?.user?._id || data?.userId || '') !== this.myUserId;
      if (!this.showChat && fromOther && String(data?.conversationId) === String(this.launch.groupId) && data?.type !== 'system') {
        this.chatUnread++;
        this.render();
      }
    }));

    const onFullscreen = () => {
      this.isFullscreen = !!document.fullscreenElement;
      this.render();
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    this.subs.add(() => document.removeEventListener('fullscreenchange', onFullscreen));

    this.subs.add(this.mediasoupService.remoteStream$.subscribe((data) => {
      // Delayed re-emits can arrive after someone left; never resurrect them as a dead tile
      const live = data.stream?.getTracks().some((t) => t.readyState === 'live');
      if (!live && !this.remotes.has(data.userId) && data.source !== 'screen') {
        return;
      }
      if (data.source === 'screen') {
        this.remoteScreen = { userId: data.userId, stream: data.stream };
        this.activeScreenUserId = data.userId;
      } else {
        const p = this.ensureRemote(data.userId);
        p.stream = data.stream;
        this.syncDisplayStreams(p);
      }
      this.mediaKick++;
      this.render();
    }));

    this.subs.add(this.mediasoupService.screenClosed$.subscribe((userId) => {
      if (this.remoteScreen?.userId === userId) {
        this.remoteScreen = null;
      }
      if (this.activeScreenUserId === userId) {
        this.activeScreenUserId = null;
      }
      this.render();
    }));

    this.subs.add(this.mediasoupService.localScreenEnded$.subscribe(() => {
      if (this.isScreenSharing) {
        void this.finishScreenShareUi();
      }
    }));

    this.subs.add(this.mediasoupService.connectionState$.subscribe((state) => {
      const down = state === 'disconnected' || state === 'failed';
      if (down !== this.mediaDown) {
        this.mediaDown = down;
        this.render();
      }
    }));

    this.subs.add(this.mediasoupService.networkQuality$.subscribe((quality) => {
      if (quality !== this.networkQuality) {
        this.networkQuality = quality;
        this.render();
      }
    }));

    // A headset / camera plugged in or removed mid-call
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);

    this.subs.add(this.mediasoupService.audioOutput$.subscribe((id) => {
      this.sinkId = id;
      this.render();
    }));

    this.subs.add(this.socketService.onDisconnect().subscribe(() => {
      this.socketDown = true;
      this.render();
    }));

    this.subs.add(this.socketService.onConnect().subscribe(() => {
      if (!this.socketDown) {
        return;
      }
      this.socketDown = false;
      if (this.phase === 'live') {
        // A new socket is not in the call's room yet; rejoin it and resync
        this.socketService.joinScreenRoom(this.callId);
        void this.mediasoupService.syncProducers(this.callId);
        this.broadcastMediaState();
        this.scheduleStateRefresh();
      }
      this.render();
    }));

    this.subs.add(this.socketService.onGroupCallEnded().subscribe((data: any) => {
      if (!sameCall(data)) {
        return;
      }
      const message =
        data.reason === 'declined' ? 'Call declined'
          : data.reason === 'no-answer' ? 'No answer'
            : this.isGroup ? 'Meeting ended' : 'Call ended';
      void this.finish(message, false);
    }));

    this.subs.add(this.socketService.onGroupCallParticipantJoined().subscribe((data: any) => {
      if (!sameCall(data) || !data.userId || String(data.userId) === this.myUserId) {
        return;
      }
      const isNew = !this.remotes.has(String(data.userId));
      const p = this.ensureRemote(String(data.userId));
      if (!this.isGroup && !this.startedAt) {
        this.startedAt = Date.now();
      }
      if (isNew && this.isGroup && this.phase === 'live') {
        this.showNotice(`${p.name} joined`);
      }
      this.scheduleStateRefresh();
      this.render();
    }));

    this.subs.add(this.socketService.onGroupCallParticipantLeft().subscribe((data: any) => {
      if (!sameCall(data) || !data.userId || String(data.userId) === this.myUserId) {
        return;
      }
      this.removeRemote(String(data.userId), data.removed ? 'was removed' : 'left');
    }));

    this.subs.add(this.socketService.onGroupCallParticipantRejected().subscribe((data: any) => {
      if (sameCall(data) && this.isGroup && data.userId) {
        this.showNotice(`${this.nameOf(String(data.userId))} declined`);
      }
    }));

    this.subs.add(this.socketService.onCallMediaUpdated().subscribe((data: any) => {
      if (sameCall(data) && data.callType) {
        this.callType = data.callType;
        this.render();
      }
    }));

    this.subs.add(this.socketService.onScreenStarted().subscribe((data: any) => {
      if (!sameCall(data)) {
        return;
      }
      this.activeScreenUserId = data.userId;
      if (data.userId !== this.myUserId) {
        this.showNotice(`${this.nameOf(data.userId)} started presenting`);
      }
      this.render();
    }));

    this.subs.add(this.socketService.onScreenStopped().subscribe((data: any) => {
      if (!sameCall(data)) {
        return;
      }
      if (this.isScreenSharing && data.userId === this.myUserId) {
        return;
      }
      if (data.userId && data.userId !== this.myUserId) {
        this.mediasoupService.dropRemoteScreen(data.userId);
      }
      this.activeScreenUserId = null;
      this.remoteScreen = null;
      this.render();
    }));

    this.subs.add(this.socketService.onCallMediaState().subscribe((data: any) => {
      if (!sameCall(data) || !data.userId || data.userId === this.myUserId) {
        return;
      }
      const p = this.ensureRemote(data.userId);
      p.audioOn = !!data.audio;
      p.videoOn = !!data.video;
      p.mediaKnown = true;
      this.render();
    }));

    this.subs.add(this.socketService.onCallReaction().subscribe((data: any) => {
      if (sameCall(data) && data.userId !== this.myUserId) {
        this.spawnReaction(data.userId, data.emoji);
      }
    }));

    this.subs.add(this.socketService.onCallHand().subscribe((data: any) => {
      if (!sameCall(data) || data.userId === this.myUserId) {
        return;
      }
      const p = this.ensureRemote(data.userId);
      p.handRaised = !!data.raised;
      if (p.handRaised) {
        this.showNotice(`✋ ${p.name} raised their hand`);
      }
      this.render();
    }));

    this.subs.add(this.socketService.onCallAudioLevels().subscribe((data: any) => {
      if (sameCall(data)) {
        this.onAudioLevels(data.levels || []);
      }
    }));

    this.subs.add(this.socketService.onCallForceMuted().subscribe((data: any) => {
      if (!sameCall(data)) {
        return;
      }
      if (!this.isMuted && this.hasAudioDevice) {
        this.isMuted = true;
        this.mediasoupService.setAudioEnabled(false);
        this.broadcastMediaState();
        this.render();
      }
      this.showNotice(data?.locked
        ? 'The organizer muted attendees. You can unmute when they allow it.'
        : data?.all ? 'The organizer muted everyone' : 'The host muted your microphone');
    }));

    // The same user took this call over on another device: leave quietly (no "left" for others)
    this.subs.add(this.socketService.onCallForceLeave().subscribe((data) => {
      if (sameCall(data)) {
        void this.finish('Your call continued on another device', false, 2200);
      }
    }));

    // ---- recording (always visible to everyone in the call)
    this.subs.add(this.socketService.onCallRecording().subscribe((data) => {
      if (!sameCall(data)) {
        return;
      }
      if (data.active) {
        // This device's clock: the REC timer starts now, whatever the server's clock says
        this.recordingSince = Date.now();
        this.showNotice(`${data.byName || 'The organizer'} started recording. Everyone in the meeting can see this.`);
      } else {
        this.recordingSince = null;
        this.showNotice(data.reason === 'limit' ? 'Recording stopped (time limit reached)' : 'Recording stopped. It will be ready after processing.');
      }
      this.render();
    }));

    // ---- meeting controls
    this.subs.add(this.socketService.onCallLobby().subscribe((data) => {
      if (!sameCall(data)) {
        return;
      }
      const before = new Set(this.lobbyWaiting.map((w) => w.userId));
      this.lobbyWaiting = data.waiting || [];
      const arrived = this.lobbyWaiting.find((w) => !before.has(w.userId));
      if (arrived && this.isModerator) {
        this.showNotice(`${arrived.username} is waiting in the lobby`);
      }
      this.render();
    }));
    this.subs.add(this.socketService.onCallSettings().subscribe((data) => {
      if (!sameCall(data)) {
        return;
      }
      const wasModerator = this.isModerator;
      this.meetingSettings = data.settings;
      this.cohostIds = new Set(data.cohostIds || []);
      if (this.isGroup && !this.hostIds.has(this.myUserId)) {
        this.myRole = this.cohostIds.has(this.myUserId) ? 'cohost' : 'attendee';
      }
      if (this.isModerator !== wasModerator) {
        this.showNotice(this.isModerator ? 'You are now a co-host' : 'You are no longer a co-host');
        void this.refreshCallState();
      }
      this.render();
    }));
    this.subs.add(this.socketService.onCallAdmitted().subscribe((data) => {
      if (sameCall(data)) {
        this.admission?.resolve();
        this.admission = null;
      }
    }));
    this.subs.add(this.socketService.onCallDenied().subscribe((data) => {
      if (sameCall(data)) {
        this.admission?.reject(new Error('denied'));
        this.admission = null;
        void this.finish("You weren't admitted to the meeting", true, 2500);
      }
    }));
    this.subs.add(this.socketService.onShareStopped().subscribe((data) => {
      if (sameCall(data) && this.isScreenSharing) {
        void this.finishScreenShareUi();
        this.showNotice('The organizer turned off screen sharing for attendees');
      }
    }));

    this.subs.add(this.socketService.onCallRemoved().subscribe((data: any) => {
      if (sameCall(data)) {
        void this.finish('You were removed from the call', false, 2200);
      }
    }));
  }

  private onAudioLevels(levels: { userId: string; volume: number }[]): void {
    let changed = false;
    const next = new Set(levels.map((l) => l.userId));
    if (next.size !== this.speaking.size || [...next].some((id) => !this.speaking.has(id))) {
      this.speaking = next;
      changed = true;
    }

    // Sticky active speaker: switch only after ~1.2s as the loudest remote
    const loudest = levels.find((l) => l.userId !== this.myUserId && this.remotes.has(l.userId))?.userId;
    if (loudest && loudest !== this.activeSpeakerId) {
      const now = Date.now();
      if (!this.activeSpeakerId) {
        this.activeSpeakerId = loudest;
        changed = true;
      } else if (this.speakerCandidate !== loudest) {
        this.speakerCandidate = loudest;
        this.speakerCandidateSince = now;
      } else if (now - this.speakerCandidateSince >= 1200) {
        this.activeSpeakerId = loudest;
        this.speakerCandidate = null;
        changed = true;
      }
    } else if (loudest) {
      this.speakerCandidate = null;
    }

    if (changed) {
      this.render();
    }
  }

  // ---------------------------------------------------------------- participants

  private ensureRemote(userId: string): RemoteParticipant {
    let p = this.remotes.get(userId);
    if (!p) {
      const cached = profileCache.get(userId);
      p = {
        userId,
        name: cached?.name || 'Participant',
        avatar: cached?.avatar,
        stream: null,
        displayVideo: new MediaStream(),
        displayAudio: new MediaStream(),
        audioOn: true,
        videoOn: true,
        mediaKnown: false,
        handRaised: false,
        joinedAt: Date.now(),
      };
      this.remotes.set(userId, p);
      this.everHadRemote = true;
      if (!cached) {
        this.fetchProfile(userId);
      }
    }
    return p;
  }

  private removeRemote(userId: string, verb: 'left' | 'was removed'): void {
    const p = this.remotes.get(userId);
    if (!p) {
      return;
    }
    this.remotes.delete(userId);
    this.mediasoupService.dropUser(userId);
    p.displayVideo.getTracks().forEach((t) => p.displayVideo.removeTrack(t));
    p.displayAudio.getTracks().forEach((t) => p.displayAudio.removeTrack(t));
    if (this.pinnedKey === `u:${userId}`) {
      this.pinnedKey = null;
    }
    if (this.activeSpeakerId === userId) {
      this.activeSpeakerId = null;
    }
    if (this.remoteScreen?.userId === userId) {
      this.remoteScreen = null;
    }
    if (this.activeScreenUserId === userId) {
      this.activeScreenUserId = null;
    }
    this.speaking.delete(userId);

    // A 1:1 call is over when the other person hangs up
    if (!this.isGroup && this.remotes.size === 0 && this.phase === 'live') {
      void this.finish('Call ended', true);
      return;
    }
    if (this.isGroup) {
      this.showNotice(`${p.name} ${verb}`);
    }
    this.render();
  }

  private fetchProfile(userId: string): void {
    this.userService.getUserById(userId).subscribe({
      next: (res) => {
        const name = res?.data?.username || 'Participant';
        profileCache.set(userId, { name, avatar: res?.data?.avatar });
        const p = this.remotes.get(userId);
        if (p) {
          p.name = name;
          p.avatar = res?.data?.avatar;
          this.render();
        }
      },
      error: () => undefined,
    });
  }

  private nameOf(userId: string): string {
    if (userId === this.myUserId) {
      return 'You';
    }
    return this.remotes.get(userId)?.name || profileCache.get(userId)?.name || 'Someone';
  }

  /** Keep element.srcObject identity stable so browsers keep decoding */
  private syncDisplayStreams(p: RemoteParticipant): void {
    const sync = (target: MediaStream, tracks: MediaStreamTrack[]) => {
      const want = new Set(tracks.filter((t) => t.readyState !== 'ended'));
      target.getTracks().forEach((t) => {
        if (!want.has(t)) {
          target.removeTrack(t);
        }
      });
      want.forEach((t) => {
        if (!target.getTracks().includes(t)) {
          target.addTrack(t);
        }
      });
    };
    sync(p.displayVideo, p.stream?.getVideoTracks() || []);
    sync(p.displayAudio, p.stream?.getAudioTracks() || []);
  }

  // ---------------------------------------------------------------- stage

  /** Rebuild every derived view model, then run change detection for this subtree. */
  private render(): void {
    this.syncMutedWatch();
    if (this.destroyed) {
      return;
    }
    this.recompute();
    this.cdr.detectChanges();
    if (this.phase === 'live' && !this.finished) {
      this.pip.prepare(this.pipHandlers());
    }
  }

  private recompute(): void {
    const liveVideo = (s: MediaStream | null | undefined) =>
      !!s?.getVideoTracks().some((t) => t.readyState === 'live');

    const self: StageItem = {
      key: 'self',
      kind: 'self',
      userId: this.myUserId,
      name: 'You',
      avatarName: this.authService.getLoggedInUser()?.username || 'You',
      avatar: this.myAvatar,
      stream: this.localStream,
      // Camera and screen share run together: your camera tile stays live while presenting
      showVideo: this.isVideoEnabled && this.hasVideoDevice && liveVideo(this.localStream),
      mirror: true,
      audioOn: !this.isMuted && this.hasAudioDevice,
      speaking: this.speaking.has(this.myUserId),
      handRaised: this.handRaised,
      connecting: false,
      isHost: this.isGroup && this.hostIds.has(this.myUserId),
    };

    const ordered = [...this.remotes.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const remoteItems: StageItem[] = ordered.map((p) => ({
      key: `u:${p.userId}`,
      kind: 'remote',
      userId: p.userId,
      name: p.name,
      avatar: p.avatar,
      stream: p.displayVideo,
      showVideo: liveVideo(p.displayVideo) && (!p.mediaKnown || p.videoOn),
      mirror: false,
      audioOn: !p.mediaKnown || p.audioOn,
      speaking: this.speaking.has(p.userId),
      handRaised: p.handRaised,
      connecting: !p.stream?.getTracks().length && !p.mediaKnown,
      isHost: this.isGroup && this.hostIds.has(p.userId),
    }));

    let screenItem: StageItem | null = null;
    if (this.isScreenSharing && this.localScreenStream) {
      screenItem = this.screenItem(this.myUserId, 'You are presenting', this.localScreenStream);
    } else if (this.remoteScreen) {
      screenItem = this.screenItem(this.remoteScreen.userId, `${this.nameOf(this.remoteScreen.userId)} is presenting`, this.remoteScreen.stream);
    }

    const all = [...(screenItem ? [screenItem] : []), self, ...remoteItems];
    if (this.pinnedKey && !all.some((i) => i.key === this.pinnedKey)) {
      this.pinnedKey = null;
    }

    let mainKey: string;
    if (this.pinnedKey) {
      mainKey = this.pinnedKey;
    } else if (screenItem) {
      mainKey = screenItem.key;
    } else if (!remoteItems.length) {
      mainKey = 'self';
    } else if (this.isGroup && remoteItems.length > 1 && this.activeSpeakerId && this.remotes.has(this.activeSpeakerId)) {
      mainKey = `u:${this.activeSpeakerId}`;
    } else {
      mainKey = remoteItems[0].key;
    }

    this.mainItem = all.find((i) => i.key === mainKey) || self;
    this.sideItems = all.filter((i) => i.key !== this.mainItem!.key);
    const people = [self, ...remoteItems];
    if (all.length === 1) {
      this.layout = 'solo';
    } else if (screenItem || this.pinnedKey || this.viewMode === 'speaker') {
      // Presenting always uses speaker layout (never the 1:1 pip chrome)
      this.layout = 'speaker';
    } else if (all.length === 2) {
      this.layout = 'pip'; // two people: person-to-person view
    } else {
      this.layout = 'gallery';
    }

    // Gallery pages (people only; a shared screen always uses the speaker view)
    this.galleryCount = people.length;
    const perPage = this.galleryPageSize();
    this.galleryPages = Math.max(1, Math.ceil(people.length / perPage));
    this.galleryPage = Math.min(this.galleryPage, this.galleryPages - 1);
    this.galleryItems = this.layout === 'gallery'
      ? people.slice(this.galleryPage * perPage, (this.galleryPage + 1) * perPage)
      : [];
    this.audioLayout =
      !this.isGroup && !screenItem && this.phase !== 'prejoin' && ![self, ...remoteItems].some((i) => i.showVideo);
    this.remoteAudio = ordered;
    this.participantCount = this.remotes.size + 1;

    // Simulcast: the main remote gets the top layer; thumbnails get the lowest
    const main = this.mainItem;
    const focus = this.layout === 'gallery'
      ? null
      : main.kind === 'remote' ? main.userId : this.layout === 'speaker' ? `stage:${main.key}` : null;
    this.mediasoupService.setFocusedUser(focus);

    this.statusLabel = this.computeStatus(remoteItems);
    this.people = this.buildPeople(self, remoteItems);
  }

  /** Up to 5x3 tiles per gallery page, fewer on smaller screens. */
  private galleryPageSize(): number {
    const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
    if (width >= 1200) return 15;
    if (width >= 900) return 12;
    if (width >= 600) return 9;
    return 6;
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.layout === 'gallery') {
      this.render();
    }
  }

  /** Generated avatar for people without a picture (same initials/colour as the chat). */
  readonly initialsOf = avatarInitials;
  readonly avatarColorsOf = avatarColors;

  get meetingTitle(): string {
    return this.isGroup ? `Meeting in ${this.launch.title}` : this.launch.title;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.pinnedKey = null;
    this.showView = false;
    this.render();
  }

  galleryPrev(): void {
    this.galleryPage = Math.max(0, this.galleryPage - 1);
    this.render();
  }

  galleryNext(): void {
    this.galleryPage = Math.min(this.galleryPages - 1, this.galleryPage + 1);
    this.render();
  }

  async toggleFullscreen(): Promise<void> {
    this.showMore = false;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.host.nativeElement.requestFullscreen();
      }
    } catch {
      this.showNotice('Full screen is not available here');
    }
    this.render();
  }

  private screenItem(userId: string, name: string, stream: MediaStream): StageItem {
    return {
      key: 'screen',
      kind: 'screen',
      userId,
      name,
      stream,
      showVideo: true,
      mirror: false,
      audioOn: true,
      speaking: false,
      handRaised: false,
      connecting: false,
      isHost: false,
    };
  }

  private computeStatus(remoteItems: StageItem[]): string {
    if (this.phase === 'joining') {
      return 'Connecting…';
    }
    if (this.isReconnecting) {
      return 'Reconnecting…';
    }
    if (this.isGroup) {
      // Group ring nobody has answered yet; meetings show the duration instead
      return !this.startedAt && this.mode === 'ring' && !remoteItems.length && this.launch.isInitiator ? 'Ringing…' : '';
    }
    if (!remoteItems.length) {
      if (this.everHadRemote) {
        return 'Connecting…';
      }
      return this.launch.isInitiator ? (this.launch.peerOnline ? 'Ringing…' : 'Calling…') : 'Connecting…';
    }
    return remoteItems[0].connecting ? 'Connecting…' : '';
  }

  private buildPeople(self: StageItem, remoteItems: StageItem[]): PersonRow[] {
    const row = (i: StageItem): PersonRow => ({
      userId: i.userId,
      name: i.kind === 'self' ? `${this.authService.getLoggedInUser()?.username || 'You'} (You)` : i.name,
      avatarName: i.avatarName || i.name,
      avatar: i.avatar,
      isSelf: i.kind === 'self',
      isHost: i.isHost,
      audioOn: i.audioOn,
      videoOn: i.kind === 'self' ? this.isVideoEnabled && this.hasVideoDevice : (this.remotes.get(i.userId)?.videoOn ?? true),
      speaking: i.speaking,
      handRaised: i.handRaised,
      connecting: i.connecting,
    });
    const others = remoteItems.map(row).sort((a, b) => {
      if (a.handRaised !== b.handRaised) {
        return a.handRaised ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return [row(self), ...others];
  }

  get isReconnecting(): boolean {
    return this.mediaDown || this.socketDown;
  }

  get isHost(): boolean {
    return this.isGroup && this.hostIds.has(this.myUserId);
  }

  /** Host or co-host (may admit, mute, remove attendees, change meeting options). */
  get isModerator(): boolean {
    return this.isGroup && (this.hostIds.has(this.myUserId) || this.cohostIds.has(this.myUserId));
  }

  get unmuteLocked(): boolean {
    return this.isGroup && !this.isModerator && !this.meetingSettings.allowUnmute;
  }

  get shareLocked(): boolean {
    return this.isGroup && !this.isModerator && !this.meetingSettings.allowShare;
  }

  isCohost(userId: string): boolean {
    return this.cohostIds.has(userId);
  }

  private waitForAdmission(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.admission = { resolve, reject };
    });
  }

  async admit(userId: string | 'all'): Promise<void> {
    try {
      await this.socketService.admitFromLobby(this.callId, userId);
    } catch (error: any) {
      this.showNotice(error?.message || 'Please try again.');
    }
  }

  async deny(userId: string): Promise<void> {
    try {
      await this.socketService.denyFromLobby(this.callId, userId);
    } catch (error: any) {
      this.showNotice(error?.message || 'Please try again.');
    }
  }

  async setOption(key: keyof MeetingSettings, value: boolean): Promise<void> {
    const before = { ...this.meetingSettings };
    this.meetingSettings = { ...this.meetingSettings, [key]: value };
    this.render();
    try {
      const res = await this.socketService.setMeetingSettings(this.callId, { [key]: value });
      this.meetingSettings = res.settings;
    } catch (error: any) {
      this.meetingSettings = before;
      this.showNotice(error?.message || "We couldn't change the meeting options.");
    }
    this.render();
  }

  async muteEveryone(): Promise<void> {
    try {
      await this.socketService.muteEveryone(this.callId);
      this.showNotice('Everyone else was muted');
    } catch (error: any) {
      this.showNotice(error?.message || "We couldn't mute everyone.");
    }
  }

  async toggleCohost(userId: string): Promise<void> {
    const make = !this.cohostIds.has(userId);
    try {
      await this.socketService.setCohost(this.callId, userId, make);
      this.showNotice(make ? `${this.nameOf(userId)} is now a co-host` : `${this.nameOf(userId)} is no longer a co-host`);
    } catch (error: any) {
      this.showNotice(error?.message || "We couldn't change the role.");
    }
  }

  /** Hosts / co-hosts in meetings, either person in a 1:1 call (the server decides). */
  get canRecord(): boolean {
    return this.recordingAvailable && this.phase === 'live' && (!this.isGroup || this.isModerator);
  }

  async toggleRecording(): Promise<void> {
    this.showMore = false;
    if (this.recordingBusy) {
      return;
    }
    if (!this.recordingSince) {
      const ok = await this.alertService.confirm({
        title: 'Start recording?',
        text: 'Everyone in the meeting will see that it is being recorded. The recording and its transcript are available to the members of this chat.',
        confirmText: 'Start recording',
      });
      if (!ok) {
        return;
      }
    }
    this.recordingBusy = true;
    this.render();
    try {
      if (this.recordingSince) {
        await this.socketService.stopRecording(this.callId);
      } else {
        await this.socketService.startRecording(this.callId);
      }
    } catch (error: any) {
      this.showNotice(error?.message || "We couldn't change the recording. Please try again.");
    } finally {
      this.recordingBusy = false;
      this.render();
    }
  }

  leaveLobby(): void {
    this.admission?.reject(new Error('left'));
    this.admission = null;
    void this.finish('', true, 0);
  }

  get filteredPeople(): PersonRow[] {
    const q = this.peopleSearch.trim().toLowerCase();
    return q ? this.people.filter((p) => p.name.toLowerCase().includes(q)) : this.people;
  }

  get raisedHandCount(): number {
    return this.people.filter((p) => p.handRaised).length;
  }

  get speakerName(): string {
    const id = [...this.speaking].find((s) => s !== this.myUserId) || (this.speaking.has(this.myUserId) ? this.myUserId : null);
    return id ? this.nameOf(id) : '—';
  }

  get presenterName(): string {
    if (this.isScreenSharing) {
      return 'You';
    }
    return this.activeScreenUserId ? this.nameOf(this.activeScreenUserId) : '';
  }

  /** The other person in a 1:1 call (for the audio-call / ringing screen). */
  get peer(): { name: string; avatar?: string; speaking: boolean } {
    const p = [...this.remotes.values()][0];
    return {
      name: p?.name || this.launch.title || 'Call',
      avatar: p?.avatar || this.launch.avatar,
      speaking: !!p && this.speaking.has(p.userId),
    };
  }

  trackByKey(_: number, item: StageItem): string {
    return item.key;
  }

  trackByUser(_: number, p: { userId: string }): string {
    return p.userId;
  }

  trackById(_: number, r: FloatingReaction): number {
    return r.id;
  }

  /** Click a PiP / strip tile → it becomes the main view (swap). */
  pin(key: string): void {
    this.pinnedKey = key;
    this.render();
  }

  unpin(): void {
    this.pinnedKey = null;
    this.render();
  }

  pinPerson(userId: string): void {
    this.pin(userId === this.myUserId ? 'self' : `u:${userId}`);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      this.showPeople = false;
      this.render();
    }
  }

  // ---------------------------------------------------------------- controls

  toggleMute(): void {
    if (!this.hasAudioDevice) {
      this.showNotice('No microphone available');
      return;
    }
    if (this.isMuted && this.unmuteLocked) {
      this.showNotice("The organizer has turned off unmuting for attendees. Raise your hand to ask to speak.");
      return;
    }
    this.isMuted = !this.isMuted;
    this.mediasoupService.setAudioEnabled(!this.isMuted);
    this.pip.refresh();
    this.broadcastMediaState();
    this.render();
  }

  async toggleVideo(): Promise<void> {
    // Audio call (or joined camera-off) → start the camera now
    if (this.callType === 'audio' || (!this.isVideoEnabled && !this.mediasoupService.hasVideoDevice)) {
      try {
        const stream = await this.mediasoupService.enableCamera();
        this.hasVideoDevice = true;
        this.isVideoEnabled = true;
        this.callType = 'video';
        this.localStream = stream;
        this.mediaKick++;
        this.broadcastMediaState();
        this.pip.refresh();
        this.render();
        await this.socketService.upgradeGroupCall(this.callId, 'video');
      } catch (error: any) {
        this.showNotice(this.deviceError(error, 'camera'));
      }
      return;
    }

    if (!this.hasVideoDevice) {
      this.showNotice('No camera available');
      return;
    }
    this.isVideoEnabled = !this.isVideoEnabled;
    this.mediasoupService.setVideoEnabled(this.isVideoEnabled);
    this.broadcastMediaState();
    this.pip.refresh();
    this.render();
  }

  async toggleScreenShare(): Promise<void> {
    if (this.isScreenSharing) {
      await this.stopLocalScreenShare();
      return;
    }

    if (this.shareLocked) {
      this.showNotice('The organizer has turned off screen sharing for attendees.');
      return;
    }
    if (this.activeScreenUserId && this.activeScreenUserId !== this.myUserId) {
      this.showNotice('Only one person can present at a time.');
      return;
    }

    let picked: MediaStream | null = null;
    try {
      picked = await this.mediasoupService.pickScreen();
      const lock = await this.socketService.requestScreenShare(this.callId);
      if (lock.error) {
        picked.getTracks().forEach((t) => t.stop());
        this.showNotice(lock.error);
        return;
      }

      const screenStream = await this.mediasoupService.publishScreen(picked);
      this.isScreenSharing = true;
      this.activeScreenUserId = this.myUserId;
      this.localScreenStream = screenStream;
      this.shareDisplaySurface = this.mediasoupService.getScreenDisplaySurface(screenStream);
      this.pinnedKey = null;
      this.broadcastMediaState();
      this.render();
      // Do NOT open call PiP here: it races Chrome tab/window capture (black) and is
      // captured into entire-screen shares so remotes see the floating call window.
    } catch (error: any) {
      console.error('Screen share failed:', error);
      picked?.getTracks().forEach((t) => t.stop());
      if (picked) {
        await this.socketService.stopScreenShareLock(this.callId);
      }
      this.isScreenSharing = false;
      this.localScreenStream = null;
      this.shareDisplaySurface = '';
      // Cancelling the browser picker is not an error worth shouting about
      if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
        console.warn('[call] screen share failed', error);
        this.showNotice(error?.name === 'NotAllowedError' ? 'Screen sharing was blocked. Check your browser permissions and try again.' : "We couldn't start screen sharing. Please try again.");
      }
      this.render();
    }
  }

  // ---------------------------------------------------------------- floating window (Picture-in-Picture)

  /** Opens the floating call window. Call only from a click (browsers require a user action). */
  openPip(): Promise<boolean> {
    return this.pip.enter().then((opened) => {
      this.render();
      return opened;
    });
  }

  private pipHandlers(): CallPipHandlers {
    return {
      state: () => {
        const item = this.pipStageItem();
        const name = item?.avatarName || item?.name || this.peer.name;
        return {
          title: this.meetingTitle,
          status: this.isScreenSharing ? 'Presenting' : this.statusLabel || (this.phase === 'live' ? 'In call' : 'Connecting…'),
          muted: this.isMuted || !this.hasAudioDevice,
          videoOn: this.isVideoEnabled && this.hasVideoDevice,
          stage: {
            stream: item?.stream || null,
            showVideo: !!item?.showVideo,
            name: item?.name || name,
            initials: avatarInitials(name),
            colors: avatarColors(name),
          },
        };
      },
      toggleMute: () => this.toggleMute(),
      toggleVideo: () => this.toggleVideo(),
      leave: () => this.leaveCall(),
      // Closing the floating window / "back to tab" brings the full call back
      left: () => {
        if (this.minimized && !this.finished) {
          this.minimizedChange.emit(false);
        }
        this.render();
      },
    };
  }

  /** Who the window shows: while presenting, the other person (never your own screen). */
  private pipStageItem(): StageItem | null {
    if (!this.isScreenSharing) {
      return this.mainItem?.kind === 'screen' && this.mainItem.userId === this.myUserId ? this.sideItems.find((i) => i.kind === 'remote') || this.mainItem : this.mainItem;
    }
    const all = [this.mainItem, ...this.sideItems].filter((i): i is StageItem => !!i);
    const others = all.filter((i) => i.kind === 'remote');
    return others.find((i) => i.showVideo) || others[0] || all.find((i) => i.kind === 'self') || null;
  }

  toggleHand(): void {
    this.handRaised = !this.handRaised;
    this.socketService.setCallHand(this.callId, this.handRaised);
    this.showMore = false;
    this.render();
  }

  sendReaction(emoji: string): void {
    const now = Date.now();
    if (now - this.lastReactionSent < 350) {
      return;
    }
    this.lastReactionSent = now;
    this.socketService.sendCallReaction(this.callId, emoji);
    this.spawnReaction(this.myUserId, emoji);
  }

  async muteParticipant(userId: string): Promise<void> {
    const res = await this.socketService.muteCallParticipant(this.callId, userId);
    this.showNotice(res.error || `Asked ${this.nameOf(userId)} to mute`);
  }

  async removeParticipant(userId: string): Promise<void> {
    const name = this.nameOf(userId);
    const confirm = await this.alertService.confirm({ title: `Remove ${name}?`, text: 'They will be disconnected and cannot rejoin this call.', confirmText: 'Remove', danger: true });
    if (!confirm) {
      return;
    }
    const res = await this.socketService.removeCallParticipant(this.callId, userId);
    if (res.error) {
      this.showNotice(res.error);
    }
  }

  async endForEveryone(): Promise<void> {
    this.showMore = false;
    const confirm = await this.alertService.confirm({ title: 'End meeting for everyone?', confirmText: 'End meeting', danger: true });
    if (!confirm) {
      return;
    }
    const res = await this.socketService.endGroupCall(this.callId);
    if (res.error) {
      this.showNotice(res.error);
      return;
    }
    void this.finish('Meeting ended', false);
  }

  leaveCall(): void {
    void this.finish(this.isGroup ? 'You left the meeting' : 'Call ended', true);
  }

  setMinimized(value: boolean): void {
    this.closeMenus();
    if (!value) {
      this.minimizedChange.emit(false);
      return;
    }
    if (this.phase === 'ended') {
      return;
    }
    // Same click: the call moves into the browser's floating window (stays above other apps).
    // Browsers without Picture-in-Picture keep the call on screen instead of hiding it.
    void this.pip.enter().then((opened) => {
      if (opened) {
        this.minimizedChange.emit(true);
      } else {
        this.showNotice("This browser can't show the call in a floating window");
      }
      this.render();
    });
  }

  /** Popovers are exclusive; the People and Chat side panels are exclusive with each other. */
  toggleMenu(menu: 'more' | 'reactions' | 'people' | 'info' | 'view' | 'chat' | 'audio' | 'video'): void {
    const wasOpen = {
      more: this.showMore, reactions: this.showReactions, info: this.showInfo, view: this.showView,
      audio: this.showAudioMenu, video: this.showVideoMenu,
    };
    this.showMore = menu === 'more' && !wasOpen.more;
    this.showReactions = menu === 'reactions' && !wasOpen.reactions;
    this.showInfo = menu === 'info' && !wasOpen.info;
    this.showView = menu === 'view' && !wasOpen.view;
    this.showAudioMenu = menu === 'audio' && !wasOpen.audio;
    this.showVideoMenu = menu === 'video' && !wasOpen.video;
    if (this.showAudioMenu || this.showVideoMenu) {
      void this.loadDevices();
    }
    if (menu === 'people') {
      this.showPeople = !this.showPeople;
      this.showChat = this.showChat && !this.showPeople;
    }
    if (menu === 'chat') {
      this.showChat = !this.showChat;
      this.showPeople = this.showPeople && !this.showChat;
      if (this.showChat) {
        this.chatUnread = 0;
      }
    }
    this.render();
  }

  closeMenus(): void {
    this.showMore = false;
    this.showReactions = false;
    this.showInfo = false;
    this.showView = false;
    this.showAudioMenu = false;
    this.showVideoMenu = false;
    this.render();
  }

  /** Browser device errors → the standard, actionable wording (never the raw DOMException text). */
  private deviceError(error: unknown, kind: 'camera' | 'microphone'): string {
    console.warn(`[call] ${kind} error`, error);
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return normalizeMediaError(error, `${kind === 'camera' ? 'Camera' : 'Microphone'} unavailable. Check your ${kind} permissions or select another ${kind}.`, kind).message;
    }
    return `${kind === 'camera' ? 'Camera' : 'Microphone'} unavailable. Check your ${kind} permissions or select another ${kind}.`;
  }

  get networkLabel(): string {
    switch (this.networkQuality) {
      case 'good': return 'Good';
      case 'fair': return 'Fair';
      case 'poor': return 'Poor';
      default: return 'Measuring…';
    }
  }

  /**
   * Devices changed. If the microphone / camera / speaker in use disappeared, move to what the
   * system offers now, without reconnecting the call (the producer track is replaced).
   */
  private async handleDeviceChange(): Promise<void> {
    if (this.destroyed || this.phase !== 'live') {
      return;
    }
    const lists = await listMediaDevices();
    this.microphones = lists.microphones;
    this.cameras = lists.cameras;
    this.speakers = lists.speakers;

    const currentMic = this.mediasoupService.currentDeviceId('audio');
    if (currentMic && lists.microphones.length && !lists.microphones.some((d) => d.deviceId === currentMic)) {
      const next = lists.microphones.find((d) => d.deviceId === 'default') || lists.microphones[0];
      try {
        await this.mediasoupService.switchMicrophone(next.deviceId);
        this.selectedMic = next.deviceId;
        this.showNotice(`Microphone disconnected. Using ${next.label || 'another microphone'}.`);
      } catch {
        this.showNotice('Microphone unavailable. Check your microphone permissions or select another microphone.');
      }
    }

    const currentCam = this.mediasoupService.currentDeviceId('video');
    if (currentCam && this.isVideoEnabled && !lists.cameras.some((d) => d.deviceId === currentCam)) {
      if (lists.cameras.length) {
        try {
          await this.mediasoupService.switchCamera(lists.cameras[0].deviceId);
          this.selectedCam = lists.cameras[0].deviceId;
          this.showNotice(`Camera disconnected. Using ${lists.cameras[0].label || 'another camera'}.`);
        } catch {
          this.showNotice('Camera unavailable. Check your camera permissions or select another camera.');
        }
      } else {
        this.showNotice('Camera disconnected.');
      }
    }

    if (this.sinkId && this.sinkId !== 'default' && !lists.speakers.some((d) => d.deviceId === this.sinkId)) {
      this.mediasoupService.setAudioOutput('default');
      this.showNotice('Speaker disconnected. Using the system default.');
    }
    this.render();
  }

  /** Device lists for the Mic / Camera menus (labels need a granted permission, so read them late). */
  private async loadDevices(): Promise<void> {
    const lists = await listMediaDevices();
    this.microphones = lists.microphones;
    this.cameras = lists.cameras;
    this.speakers = lists.speakers;
    this.selectedMic = this.mediasoupService.currentDeviceId('audio');
    this.selectedCam = this.mediasoupService.currentDeviceId('video');
    this.render();
  }

  get noiseSuppression(): boolean {
    return this.mediasoupService.noiseSuppression;
  }

  async toggleNoiseSuppression(): Promise<void> {
    this.noiseBusy = true;
    this.render();
    try {
      await this.mediasoupService.setNoiseSuppression(!this.noiseSuppression);
      this.localStream = this.mediasoupService.getLocalStream();
      this.showNotice(this.noiseSuppression ? 'Noise suppression on' : 'Noise suppression off');
    } catch (error: any) {
      this.showNotice(error?.message || 'Could not change noise suppression');
    }
    this.noiseBusy = false;
    this.render();
  }

  get videoEffect(): VideoEffect {
    return this.mediasoupService.videoEffect;
  }

  get effectsSupported(): boolean {
    return this.mediasoupService.videoEffectsSupported;
  }

  get backgroundBlurOn(): boolean {
    return this.videoEffect === 'blur' || this.videoEffect === 'blur-strong';
  }

  async selectEffect(effect: VideoEffect): Promise<void> {
    if (this.effectBusy || effect === this.videoEffect) {
      return;
    }
    this.effectBusy = effect;
    this.render();
    try {
      await this.mediasoupService.setVideoEffect(effect);
      this.localStream = this.mediasoupService.getLocalStream();
      this.mediaKick++;
    } catch (error: any) {
      this.showNotice(error?.message || 'Could not apply the background effect');
    }
    this.effectBusy = null;
    this.render();
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    // Only float the call when sharing a tab/window (not the whole screen — PiP would be captured).
    if (
      document.visibilityState === 'hidden' &&
      this.isScreenSharing &&
      this.shareDisplaySurface !== 'monitor' &&
      this.phase === 'live' &&
      !this.minimized &&
      !this.finished
    ) {
      this.setMinimized(true);
    }
  }

  async onMicChange(deviceId: string): Promise<void> {
    try {
      await this.mediasoupService.switchMicrophone(deviceId);
      this.selectedMic = deviceId;
      this.hasAudioDevice = true;
      this.localStream = this.mediasoupService.getLocalStream();
      this.broadcastMediaState();
    } catch (error: any) {
      this.showNotice(this.deviceError(error, 'microphone'));
    }
    this.render();
  }

  async onCamChange(deviceId: string): Promise<void> {
    try {
      await this.mediasoupService.switchCamera(deviceId);
      this.selectedCam = deviceId;
      this.localStream = this.mediasoupService.getLocalStream();
      this.mediaKick++;
    } catch (error: any) {
      this.showNotice(this.deviceError(error, 'camera'));
    }
    this.render();
  }

  onSpeakerChange(deviceId: string): void {
    this.mediasoupService.setAudioOutput(deviceId);
  }

  get canFlipCamera(): boolean {
    return this.isVideoEnabled && this.hasVideoDevice && this.cameras.length > 1;
  }

  /** Phones: cycle front/back camera. */
  async flipCamera(): Promise<void> {
    this.showMore = false;
    if (!this.cameras.length) {
      this.cameras = (await listMediaDevices()).cameras;
    }
    if (this.cameras.length < 2) {
      this.showNotice('No other camera found');
      return;
    }
    const current = this.mediasoupService.currentDeviceId('video');
    const index = this.cameras.findIndex((c) => c.deviceId === current);
    await this.onCamChange(this.cameras[(index + 1) % this.cameras.length].deviceId);
  }

  // ---------------------------------------------------------------- helpers

  private broadcastMediaState(): void {
    if (this.phase !== 'live') {
      return;
    }
    this.socketService.sendCallMediaState(
      this.callId,
      !this.isMuted && this.hasAudioDevice,
      this.isVideoEnabled && this.hasVideoDevice
    );
  }

  private spawnReaction(userId: string, emoji: string): void {
    if (!CALL_REACTIONS.includes(emoji as any)) {
      return;
    }
    const id = ++this.reactionSeq;
    this.reactions = [
      ...this.reactions.slice(-14),
      { id, emoji, name: this.nameOf(userId), left: 8 + Math.random() * 72 },
    ];
    this.later(() => {
      this.reactions = this.reactions.filter((r) => r.id !== id);
      this.render();
    }, 3200);
    this.render();
  }

  private showNotice(text: string): void {
    this.notice = text;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      this.render();
    }, 3500);
    this.render();
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private async unlockAudioPlayback(): Promise<void> {
    try {
      const silent = new Audio(
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
      );
      silent.volume = 0.01;
      await silent.play();
      silent.pause();
    } catch {
      // ignore
    }

    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        await ctx.close();
      }
    } catch {
      // ignore
    }
  }

  private async stopLocalScreenShare(): Promise<void> {
    await this.mediasoupService.stopScreenShare();
    await this.finishScreenShareUi();
  }

  private async finishScreenShareUi(): Promise<void> {
    this.isScreenSharing = false;
    this.localScreenStream = null;
    this.shareDisplaySurface = '';
    this.activeScreenUserId = null;
    await this.socketService.stopScreenShareLock(this.callId);
    this.broadcastMediaState();
    this.render();
  }

  /**
   * Single exit path: tear media down, show a short end screen, then tell the host.
   * Idempotent — server "ended" events can race a local hang-up.
   */
  private async finish(message: string, notifyServer: boolean, delayMs = 1400): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.endMessage = message;
    this.phase = 'ended';
    this.closeMenus();
    this.render();

    if (this.isScreenSharing) {
      await this.mediasoupService.stopScreenShare();
      await this.socketService.stopScreenShareLock(this.callId);
    }
    this.pip.release();
    if (notifyServer && this.callId) {
      this.socketService.leaveGroupCall(this.callId);
    }
    await this.mediasoupService.close();
    this.localStream = null;
    this.localScreenStream = null;

    if (delayMs > 0) {
      this.later(() => this.closed.emit(), delayMs);
    } else {
      this.closed.emit();
    }
  }
}
