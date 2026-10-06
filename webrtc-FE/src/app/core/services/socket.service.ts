import { Injectable } from '@angular/core';
import { Socket } from 'ngx-socket-io';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';
import { environment } from 'src/environments/environment';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { Observable } from 'rxjs';
import { UploadResult, UploadTarget } from '../interfaces/chat';

/** Snapshot returned by `call:getState` for the meeting UI. */
export interface CallStateSnapshot {
  callId: string;
  groupId: string;
  callType: 'audio' | 'video';
  mode: 'ring' | 'meetNow';
  callStatus: string;
  startedAt: string | null;
  isGroup: boolean;
  hostIds: string[];
  participants: string[];
  screenSharerUserId: string | null;
  media: Record<string, { audio: boolean; video: boolean }>;
  hands: string[];
}

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  constructor(
    private socket: Socket,
    private http: HttpClient,
    private authService: AuthService,
    private alertService: AlertService,

  ) {
    this.autoReconnect();
  }

  on(
    event: string,
    callback: (...args: any[]) => void
  ): void {
    this.socket.on(event, callback);
  }

  connectWithToken() {
    const token = this.authService.getToken();
    if (!token) {
      this.alertService.error('No token found for WebSocket connection');
      return;
    }

    this.socket.disconnect();
    this.socket.io.opts.query = { token };
    this.socket.connect();
  }
  autoReconnect() {
    const token = this.authService.getToken();
    if (token) {
      this.connectWithToken();
    }
  }

  joinConversation(conversationId: string): void {
    this.socket.emit('joinConversation', conversationId);
  }

  /** Stores a chat attachment or group photo; the returned storageKey is what gets sent back. */
  uploadFile(file: File, target: UploadTarget) {
    const formData = new FormData();
    formData.append('purpose', target.purpose);
    if (target.purpose === 'message') {
      formData.append('conversationId', target.conversationId);
    } else {
      formData.append('groupId', target.groupId);
    }
    formData.append('file', file);
    return this.http.post<UploadResult>(`${environment.apiUrl}/upload`, formData);
  }

  /** Media: pass the storageKey from uploadFile. Forward: pass forwardOf (source message id). */
  sendMessage(messageData: { user: string | any, conversationId: string, content: string, fileUrl?: string, type: string, replyTo?: string | null, storageKey?: string, forwardOf?: string }) {
    this.socket.emit('sendMessage', messageData);
  }

  sendReaction(messageId: string, emoji: string, conversationId: string) {
    this.socket.emit('reactToMessage', { messageId, emoji, conversationId });
  }

  onReactionUpdated() {
    return this.socket.fromEvent('messageReactionUpdated');
  }

  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingConversationId: string | null = null;

  /** Emits `typing` once per burst and `stopTyping` 3s after the last keystroke. */
  typing(conversationId: string, userId: string): void {
    if (this.typingConversationId && this.typingConversationId !== conversationId) {
      this.stopTyping(userId);
    }
    if (!this.typingTimer) {
      this.socket.emit('typing', conversationId, userId);
    } else {
      clearTimeout(this.typingTimer);
    }
    this.typingConversationId = conversationId;
    this.typingTimer = setTimeout(() => this.stopTyping(userId), 3000);
  }

  stopTyping(userId: string): void {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.typingConversationId) {
      this.socket.emit('stopTyping', this.typingConversationId, userId);
      this.typingConversationId = null;
    }
  }

  onPresence() {
    return this.socket.fromEvent('user:presence');
  }

  /** Fires on every (re)connect of the underlying socket. */
  onConnect(): Observable<unknown> {
    return this.socket.fromEvent('connect');
  }

  onDisconnect(): Observable<unknown> {
    return this.socket.fromEvent('disconnect');
  }

  receivedTyping() {
    return this.socket.fromEvent('userTyping');
  }

  newMessageReceived() {
    return this.socket.fromEvent('receiveMessage');
  }
  messagesMarkedRead() {
    return this.socket.fromEvent("messagesMarkedRead");
  }

  markMessagesAsRead(conversationId: string) {
    const userId = this.authService.getLoggedInUser()._id;
    this.socket.emit("markMessagesRead", conversationId, userId);
  }

  disconnectSocket() {
    this.socket.disconnect();
  }

  callUser(userToCall: string, signalData: any, from: string, callType: 'audio' | 'video') {
    this.socket.emit("callUser", { userToCall, signalData, from, callType });
  }

  answerCall(to: string, signal: any) {
    this.socket.emit("answerCall", { to, signal });
  }

  onIncomingCall() {
    return this.socket.fromEvent("incomingCall");
  }

  onCallAccepted() {
    return this.socket.fromEvent("callAccepted");
  }

  sendIceCandidate(userToCall: string, candidate: any) {
    this.socket.emit("iceCandidate", { userToCall, candidate });
  }

  onIceCandidate() {
    return this.socket.fromEvent("iceCandidate");
  }
  endCall(receiverId: string) {
    this.socket.emit('call-ended', { to: receiverId });
  }

  onCallEnded() {
    return this.socket.fromEvent("callEnded");
  }

  joinGroup(conversationId: string): void {
    this.socket.emit('joinConversation', conversationId);
  }

  sendGroupMessage(messageData: { user: string, conversationId: string, content: string, fileUrl?: string, type: string }) {
    this.socket.emit('sendMessage', messageData);
  }

  newGroupMessageReceived() {
    return this.socket.fromEvent('receiveMessage');
  }

  startGroupCall(groupId: string, callType: 'audio' | 'video', mode?: 'ring' | 'meetNow') {
    this.socket.emit('call:start', {
      groupId,
      callType,
      mode: mode || (callType === 'video' ? 'meetNow' : 'ring'),
    });
  }

  getActiveGroupCall(groupId: string): Promise<{
    call: {
      callId: string;
      groupId: string;
      callType: 'audio' | 'video';
      mode: 'ring' | 'meetNow';
      callStatus: string;
      initiatedBy: string;
    } | null;
  }> {
    return new Promise((resolve) => {
      this.socket.emit('call:getActive', { groupId }, (response: any) => {
        resolve(response || { call: null });
      });
    });
  }

  upgradeGroupCall(callId: string, callType: 'audio' | 'video' = 'video'): Promise<any> {
    return new Promise((resolve) => {
      this.socket.emit('call:upgrade', { callId, callType }, (response: any) => {
        resolve(response || {});
      });
    });
  }

  onCallStarted() {
    return this.socket.fromEvent('call:started');
  }

  onIncomingGroupCall() {
    return this.socket.fromEvent('call:incoming');
  }

  onMeetingActive() {
    return this.socket.fromEvent('call:meeting-active');
  }

  onCallMediaUpdated() {
    return this.socket.fromEvent('call:media-updated');
  }

  acceptGroupCall(callId: string): Promise<{ success?: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('call:accept', { callId }, (response: any) => {
        resolve(response || { success: true });
      });
    });
  }

  rejectGroupCall(callId: string) {
    this.socket.emit('call:reject', { callId });
  }

  leaveGroupCall(callId: string) {
    this.socket.emit('call:leave', { callId });
  }

  /** End for everyone (host in groups, either side in 1:1). */
  endGroupCall(callId: string): Promise<{ success?: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('call:end', { callId }, (response: any) => {
        resolve(response || {});
      });
    });
  }

  onGroupCallParticipantRejected() {
    return this.socket.fromEvent('call:participant-rejected');
  }

  getCallState(callId: string): Promise<CallStateSnapshot | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      this.socket.emit('call:getState', { callId }, (response: any) => {
        clearTimeout(timer);
        resolve(response && !response.error ? response : null);
      });
    });
  }

  sendCallMediaState(callId: string, audio: boolean, video: boolean) {
    this.socket.emit('call:media-state', { callId, audio, video });
  }

  sendCallReaction(callId: string, emoji: string) {
    this.socket.emit('call:reaction', { callId, emoji });
  }

  setCallHand(callId: string, raised: boolean) {
    this.socket.emit('call:hand', { callId, raised });
  }

  muteCallParticipant(callId: string, userId: string): Promise<{ success?: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('call:mute-participant', { callId, userId }, (response: any) => resolve(response || {}));
    });
  }

  removeCallParticipant(callId: string, userId: string): Promise<{ success?: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('call:remove-participant', { callId, userId }, (response: any) => resolve(response || {}));
    });
  }

  onCallMediaState() {
    return this.socket.fromEvent('call:media-state');
  }

  onCallReaction() {
    return this.socket.fromEvent('call:reaction');
  }

  onCallHand() {
    return this.socket.fromEvent('call:hand');
  }

  onCallAudioLevels() {
    return this.socket.fromEvent('call:audio-levels');
  }

  onCallForceMuted() {
    return this.socket.fromEvent('call:force-muted');
  }

  onCallRemoved() {
    return this.socket.fromEvent('call:removed');
  }

  onGroupCallEnded() {
    return this.socket.fromEvent('call:ended');
  }

  onGroupCallParticipantJoined() {
    return this.socket.fromEvent('call:participant-joined');
  }

  onGroupCallParticipantLeft() {
    return this.socket.fromEvent('call:participant-left');
  }

  joinScreenRoom(callId: string) {
    this.socket.emit('screen:join', { callId });
  }

  requestScreenShare(callId: string): Promise<{ success?: boolean; error?: string; sharerUserId?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('screen:start', { callId }, (response: any) => {
        resolve(response || {});
      });
    });
  }

  stopScreenShareLock(callId: string): Promise<void> {
    return new Promise((resolve) => {
      this.socket.emit('screen:stop', { callId }, () => resolve());
    });
  }

  getScreenShareState(callId: string): Promise<{ sharerUserId: string | null }> {
    return new Promise((resolve) => {
      this.socket.emit('screen:getState', { callId }, (response: any) => {
        resolve(response || { sharerUserId: null });
      });
    });
  }

  onScreenStarted() {
    return this.socket.fromEvent('screen:started');
  }

  onScreenStopped() {
    return this.socket.fromEvent('screen:stopped');
  }

  emitWithAck(
    event: string,
    data: any,
    callback: (response: any) => void
  ): void {
    this.socket.emit(event, data, callback);
  }

  /** Acknowledged request; rejects with the server's message on `{ error }` or after a timeout. */
  request<T = any>(event: string, data: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The server did not respond. Check your connection.')), timeoutMs);
      this.socket.emit(event, data, (response: any) => {
        clearTimeout(timer);
        if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response as T);
        }
      });
    });
  }

  onGroupUpdated() {
    return this.socket.fromEvent('group:updated');
  }

  onGroupAdded() {
    return this.socket.fromEvent('group:added');
  }

  onGroupRemoved() {
    return this.socket.fromEvent('group:removed');
  }

  /** Someone changed their name / picture / bio. */
  onUserUpdated(): Observable<{ _id: string; username: string; avatar: string; bio?: string; status?: string }> {
    return this.socket.fromEvent('user:updated');
  }

  onMessageRejected() {
    return this.socket.fromEvent('message:rejected');
  }

  onCallError() {
    return this.socket.fromEvent('call:error');
  }

  private iceConfigCache: { value: RTCConfiguration; fetchedAt: number } | null = null;

  /**
   * STUN/TURN config from the server (short-lived TURN creds, never baked into the bundle).
   * Resolves to an empty config after 5s so a slow socket never blocks call setup.
   */
  getIceConfig(): Promise<RTCConfiguration> {
    const cached = this.iceConfigCache;
    if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
      return Promise.resolve(cached.value);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ iceServers: [] }), 5000);
      this.socket.emit('ice:getServers', {}, (response: any) => {
        clearTimeout(timer);
        const value: RTCConfiguration = {
          iceServers: response?.iceServers || [],
          iceTransportPolicy: response?.iceTransportPolicy === 'relay' ? 'relay' : 'all',
        };
        this.iceConfigCache = { value, fetchedAt: Date.now() };
        resolve(value);
      });
    });
  }
}
