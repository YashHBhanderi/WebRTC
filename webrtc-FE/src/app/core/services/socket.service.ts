import { Injectable } from '@angular/core';
import { Socket } from 'ngx-socket-io';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';
import { environment } from 'src/environments/environment';
import { AlertService } from 'src/app/_shared/alert/alert.service';
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

  uploadFile(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.http.post<{ fileUrl: string, thumbnailUrl: string }>(`${environment.apiUrl}/upload`, formData);
  }

  sendMessage(messageData: { user: string | any, conversationId: string, content: string, fileUrl?: string, thumbnailUrl?: string, type: string, replyTo?: string }) {
    this.socket.emit('sendMessage', messageData);
  }

  sendReaction(messageId: string, emoji: string, conversationId: string) {
    this.socket.emit('reactToMessage', { messageId, emoji, conversationId });
  }

  onReactionUpdated() {
    return this.socket.fromEvent('messageReactionUpdated');
  }

  typing(conversationId: string, userId: string): void {
    this.socket.emit('typing', conversationId, userId);

    setTimeout(() => {
      this.socket.emit('stopTyping', conversationId, userId);
    }, 20000);
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

  endGroupCall(callId: string) {
    this.socket.emit('call:end', { callId });
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
}
