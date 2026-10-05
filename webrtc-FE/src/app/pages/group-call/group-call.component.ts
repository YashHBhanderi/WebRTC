import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { AuthService } from '../../core/services/auth.service';
import { CallStateSnapshot, SocketService } from '../../core/services/socket.service';
import { MediasoupService } from '../../core/services/mediasoup.service';
import { UserService } from '../../core/services/user.service';
import { ScreenShareOverlayService } from '../../core/services/screen-share-overlay.service';
import {
  listMediaDevices,
  supportsAudioOutputSelection,
  supportsScreenShare,
} from '../../core/utils/media-devices.util';
import { CALL_REACTIONS, CallLaunch, PrejoinResult, StageItem } from './call.models';

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
  avatar?: string;
  isSelf: boolean;
  isHost: boolean;
  audioOn: boolean;
  videoOn: boolean;
  speaking: boolean;
  handRaised: boolean;
  connecting: boolean;
}

type CallPhase = 'prejoin' | 'joining' | 'live' | 'ended';
type StageLayout = 'solo' | 'pip' | 'sidebar';

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
  @Input() minimized = false;
  @Output() minimizedChange = new EventEmitter<boolean>();
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
  isVideoEnabled = true;
  isScreenSharing = false;
  hasAudioDevice = false;
  hasVideoDevice = false;
  handRaised = false;

  // Remote state
  private remotes = new Map<string, RemoteParticipant>();
  private remoteScreen: { userId: string; stream: MediaStream } | null = null;
  activeScreenUserId: string | null = null;
  hostIds = new Set<string>();
  startedAt: number | null = null;
  private speaking = new Set<string>();
  activeSpeakerId: string | null = null;
  private speakerCandidate: string | null = null;
  private speakerCandidateSince = 0;
  pinnedKey: string | null = null;

  // Connectivity
  private mediaDown = false;
  private socketDown = false;

  // Derived view state (recomputed on change, never in template getters)
  mainItem: StageItem | null = null;
  sideItems: StageItem[] = [];
  remoteAudio: RemoteParticipant[] = [];
  layout: StageLayout = 'solo';
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
  showSettings = false;
  showInfo = false;
  peopleSearch = '';
  reactions: FloatingReaction[] = [];
  notice: string | null = null;

  microphones: MediaDeviceInfo[] = [];
  cameras: MediaDeviceInfo[] = [];
  speakers: MediaDeviceInfo[] = [];
  selectedMic = '';
  selectedCam = '';

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
    private screenOverlay: ScreenShareOverlayService,
    private cdr: ChangeDetectorRef,
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

  ngOnDestroy(): void {
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
    void this.screenOverlay.hide();
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
    try {
      const acceptResult = await this.socketService.acceptGroupCall(this.callId);
      if (acceptResult?.error) {
        throw new Error(acceptResult.error);
      }

      await this.mediasoupService.initialize();
      const response = await this.mediasoupService.joinCall(this.callId, this.callType);

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
      console.error('Failed to join call:', error);
      const insecure =
        typeof window !== 'undefined' &&
        !window.isSecureContext &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1';
      const message = insecure
        ? 'Camera/mic need HTTPS. Run npm run dev and open the https URL.'
        : `Couldn't join: ${error?.message || error}`;
      await this.finish(message, false, 2200);
    }
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
    this.isGroup = state.isGroup;
    if (state.startedAt) {
      this.startedAt = new Date(state.startedAt).getTime();
    }
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

  // ---------------------------------------------------------------- events

  private bindEvents(): void {
    const sameCall = (data: any) => data?.callId != null && String(data.callId) === String(this.callId);

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
        this.toggleMute();
      }
      this.showNotice('The host muted your microphone');
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
    if (this.destroyed) {
      return;
    }
    this.recompute();
    this.cdr.detectChanges();
  }

  private recompute(): void {
    const liveVideo = (s: MediaStream | null | undefined) =>
      !!s?.getVideoTracks().some((t) => t.readyState === 'live');

    const self: StageItem = {
      key: 'self',
      kind: 'self',
      userId: this.myUserId,
      name: 'You',
      avatar: this.myAvatar,
      stream: this.localStream,
      showVideo: this.isVideoEnabled && this.hasVideoDevice && !this.isScreenSharing && liveVideo(this.localStream),
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
    this.layout = all.length === 1 ? 'solo' : all.length === 2 ? 'pip' : 'sidebar';
    this.audioLayout =
      !this.isGroup && !screenItem && this.phase !== 'prejoin' && ![self, ...remoteItems].some((i) => i.showVideo);
    this.remoteAudio = ordered;
    this.participantCount = this.remotes.size + 1;

    // Simulcast: the main remote gets the top layer; thumbnails get the lowest
    const main = this.mainItem;
    const focus = main.kind === 'remote' ? main.userId : this.layout === 'sidebar' ? `stage:${main.key}` : null;
    this.mediasoupService.setFocusedUser(focus);

    this.statusLabel = this.computeStatus(remoteItems);
    this.people = this.buildPeople(self, remoteItems);
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
    this.isMuted = !this.isMuted;
    this.mediasoupService.setAudioEnabled(!this.isMuted);
    this.screenOverlay.refresh();
    this.broadcastMediaState();
    this.render();
  }

  async toggleVideo(): Promise<void> {
    if (this.isScreenSharing) {
      return;
    }

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
        this.render();
        await this.socketService.upgradeGroupCall(this.callId, 'video');
      } catch (error: any) {
        this.showNotice(error?.message || 'Could not enable camera');
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
    this.render();
  }

  async toggleScreenShare(): Promise<void> {
    if (this.isScreenSharing) {
      await this.stopLocalScreenShare();
      return;
    }

    if (this.activeScreenUserId && this.activeScreenUserId !== this.myUserId) {
      this.showNotice('Only one person can present at a time.');
      return;
    }

    try {
      const lock = await this.socketService.requestScreenShare(this.callId);
      if (lock.error) {
        this.showNotice(lock.error);
        return;
      }

      const screenStream = await this.mediasoupService.startScreenShare();
      this.isScreenSharing = true;
      this.activeScreenUserId = this.myUserId;
      this.localScreenStream = screenStream;
      this.pinnedKey = null;
      this.broadcastMediaState();
      this.render();
      await this.openShareOverlay();
    } catch (error: any) {
      console.error('Screen share failed:', error);
      await this.socketService.stopScreenShareLock(this.callId);
      this.isScreenSharing = false;
      this.localScreenStream = null;
      // Cancelling the browser picker is not an error worth shouting about
      if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
        this.showNotice(`Screen share failed: ${error?.message || error}`);
      }
      this.render();
    }
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
    const confirm = await Swal.fire({
      title: `Remove ${name}?`,
      text: 'They will be disconnected and cannot rejoin this call.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Remove',
      confirmButtonColor: '#dc2626',
    });
    if (!confirm.isConfirmed) {
      return;
    }
    const res = await this.socketService.removeCallParticipant(this.callId, userId);
    if (res.error) {
      this.showNotice(res.error);
    }
  }

  async endForEveryone(): Promise<void> {
    this.showMore = false;
    const confirm = await Swal.fire({
      title: 'End meeting for everyone?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'End meeting',
      confirmButtonColor: '#dc2626',
    });
    if (!confirm.isConfirmed) {
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
    this.minimizedChange.emit(value);
  }

  toggleMenu(menu: 'more' | 'reactions' | 'people' | 'info'): void {
    const next = {
      more: !this.showMore && menu === 'more',
      reactions: !this.showReactions && menu === 'reactions',
      people: menu === 'people' ? !this.showPeople : this.showPeople,
      info: !this.showInfo && menu === 'info',
    };
    this.showMore = next.more;
    this.showReactions = next.reactions;
    this.showPeople = next.people;
    this.showInfo = next.info;
    this.render();
  }

  closeMenus(): void {
    this.showMore = false;
    this.showReactions = false;
    this.showInfo = false;
    this.showSettings = false;
    this.render();
  }

  async openSettings(): Promise<void> {
    this.showMore = false;
    const lists = await listMediaDevices();
    this.microphones = lists.microphones;
    this.cameras = lists.cameras;
    this.speakers = lists.speakers;
    this.selectedMic = this.mediasoupService.currentDeviceId('audio');
    this.selectedCam = this.mediasoupService.currentDeviceId('video');
    this.showSettings = true;
    this.render();
  }

  async onMicChange(deviceId: string): Promise<void> {
    try {
      await this.mediasoupService.switchMicrophone(deviceId);
      this.selectedMic = deviceId;
      this.hasAudioDevice = true;
      this.localStream = this.mediasoupService.getLocalStream();
      this.broadcastMediaState();
    } catch (error: any) {
      this.showNotice(error?.message || 'Could not switch microphone');
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
      this.showNotice(error?.message || 'Could not switch camera');
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
      this.isVideoEnabled && this.hasVideoDevice && !this.isScreenSharing
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
    this.activeScreenUserId = null;
    await this.socketService.stopScreenShareLock(this.callId);
    await this.screenOverlay.hide();
    this.broadcastMediaState();
    this.render();
  }

  private async openShareOverlay(): Promise<void> {
    await this.screenOverlay.show({
      onToggleMute: () => this.toggleMute(),
      onStopShare: () => {
        void this.stopLocalScreenShare();
      },
      onLeave: () => this.leaveCall(),
      isMuted: () => this.isMuted,
      hasAudio: () => this.hasAudioDevice,
    });
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
      await this.screenOverlay.hide();
    }
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
