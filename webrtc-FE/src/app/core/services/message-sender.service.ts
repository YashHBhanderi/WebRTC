import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { MessageDraft } from '../interfaces/chat';

/** Upload (if any) + sendMessage. Shared by the chat and the in-meeting chat panel. */
@Injectable({ providedIn: 'root' })
export class MessageSenderService {
  constructor(private socket: SocketService, private auth: AuthService) {}

  currentUserPayload() {
    const me = this.auth.getLoggedInUser();
    return {
      _id: me._id,
      username: me.username,
      email: me.email,
      avatar: me.avatar,
      isOnline: me.isOnline,
      lastSeen: me.lastSeen,
    };
  }

  /** Resolves once the message was handed to the socket; rejects if the upload failed. */
  async send(conversationId: string, draft: MessageDraft): Promise<void> {
    const text = (draft.text || '').trim();
    if (!text && !draft.file) {
      return;
    }
    const payload: any = {
      user: this.currentUserPayload(),
      conversationId,
      content: text,
      createdAt: new Date().toISOString(),
      replyTo: draft.replyToId || null,
      type: 'text',
    };
    if (draft.file) {
      const uploaded = await firstValueFrom(this.socket.uploadFile(draft.file, { purpose: 'message', conversationId }));
      payload.storageKey = uploaded.storageKey;
      payload.type = uploaded.type;
    }
    this.socket.sendMessage(payload);
  }

}
