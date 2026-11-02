import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { MessageDraft } from '../interfaces/chat';
import { E2eeService, SecureContent } from '../crypto/e2ee.service';
import { encryptFile } from '../crypto/attachment-crypto';

/** Media kind the server files an encrypted attachment under (size limits / folders); visible metadata. */
export function mediaKind(mime: string): 'image' | 'video' | 'audio' | 'pdf' | 'file' {
  if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

/** Upload (if any) + sendMessage. Shared by the chat and the in-meeting chat panel. */
@Injectable({ providedIn: 'root' })
export class MessageSenderService {
  constructor(private socket: SocketService, private auth: AuthService, private e2ee: E2eeService) {}

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

  /**
   * Resolves once the message was handed to the socket; rejects if encryption or the upload failed.
   * Everything is encrypted on this device first; there is no plaintext fallback.
   */
  async send(conversationId: string, draft: MessageDraft): Promise<void> {
    const text = (draft.text || '').trim();
    const files = draft.files?.length ? draft.files : draft.file ? [draft.file] : [];
    if (files.length > 1) {
      // One message per file; the caption / reply / mentions go with the first
      for (const [i, file] of files.entries()) {
        await this.send(conversationId, i === 0 ? { ...draft, file, files: [file] } : { text: '', file, files: [file] });
      }
      return;
    }
    if (!text && !draft.file) {
      return;
    }
    const secure: SecureContent = { text };
    const payload: any = {
      user: this.currentUserPayload(),
      conversationId,
      content: '',
      createdAt: new Date().toISOString(),
      replyTo: draft.replyToId || null,
      mentions: draft.mentionIds?.length ? draft.mentionIds : undefined,
      type: 'text',
    };
    if (draft.file) {
      const kind = mediaKind(draft.file.type);
      const { ciphertext, info } = await encryptFile(draft.file);
      const uploaded = await firstValueFrom(this.socket.uploadEncrypted(ciphertext, conversationId, kind));
      payload.storageKey = uploaded.storageKey;
      payload.type = uploaded.type;
      secure.file = { ...info, storageKey: uploaded.storageKey };
    }
    payload.e2ee = await this.e2ee.encrypt(conversationId, secure);
    this.socket.sendMessage(payload);
  }

}
