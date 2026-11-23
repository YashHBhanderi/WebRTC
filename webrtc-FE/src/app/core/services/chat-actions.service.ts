import { Injectable } from '@angular/core';
import { UserService } from './user.service';
import { E2eeService } from '../crypto/e2ee.service';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SocketService } from './socket.service';
import { ChatState, GroupSummary, PinnedMessage, SearchCursor, SearchResult, SearchPage } from '../interfaces/chat';

/**
 * Chat state, contact and group administration, and server-side message search.
 * Mutations go over acknowledged socket events (chat:*, group:*); reads use REST.
 * The server re-checks every permission — this service only carries intent.
 */
const SEARCH_PAGE_SIZE = 50;
const SEARCH_SCAN_PAGES = 40;

@Injectable({ providedIn: 'root' })
export class ChatActionsService {
  private readonly api = environment.apiUrl;

  constructor(private socket: SocketService, private http: HttpClient, private e2ee: E2eeService, private users: UserService) {}

  // ---------------------------------------------------------------- per-user chat state
  archive(conversationId: string, archived: boolean): Promise<{ state: ChatState }> {
    return this.socket.request(archived ? 'chat:archive' : 'chat:unarchive', { conversationId });
  }

  /** Favorites: pinned to the top of my chat list (any chat, group or channel I belong to) */
  favorite(conversationId: string, favorite: boolean): Promise<{ state: ChatState }> {
    return this.socket.request(favorite ? 'chat:favorite' : 'chat:unfavorite', { conversationId });
  }

  clear(conversationId: string): Promise<{ state: ChatState }> {
    return this.socket.request('chat:clear', { conversationId });
  }

  setBlocked(userId: string, blocked: boolean): Promise<{ blocked: boolean }> {
    return this.socket.request(blocked ? 'chat:block' : 'chat:unblock', { userId });
  }

  async state(conversationId: string): Promise<ChatState> {
    const res = await firstValueFrom(this.http.get<{ data: ChatState }>(`${this.api}/conversations/${conversationId}/state`));
    return res.data;
  }

  // ---------------------------------------------------------------- groups
  updateGroup(groupId: string, changes: { groupName?: string; groupDescription?: string; groupAvatarKey?: string }): Promise<{ group: GroupSummary }> {
    return this.socket.request('group:update', { groupId, ...changes });
  }

  addMembers(groupId: string, userIds: string[]): Promise<{ group: GroupSummary; added: string[] }> {
    return this.socket.request('group:add-member', { groupId, userIds });
  }

  removeMember(groupId: string, userId: string): Promise<{ group: GroupSummary }> {
    return this.socket.request('group:remove-member', { groupId, userId });
  }

  setAdmin(groupId: string, userId: string, admin: boolean): Promise<{ group: GroupSummary }> {
    return this.socket.request(admin ? 'group:promote-admin' : 'group:remove-admin', { groupId, userId });
  }

  leaveGroup(groupId: string): Promise<{ groupId: string }> {
    return this.socket.request('group:leave', { groupId });
  }

  // ---------------------------------------------------------------- message actions
  /** The edited text is encrypted for the conversation like a new message (never sent in plaintext). */
  async editMessage(messageId: string, conversationId: string, text: string, mentions: string[]): Promise<{ success: boolean }> {
    const e2ee = await this.e2ee.encrypt(conversationId, { text });
    return this.socket.request('message:edit', { messageId, e2ee, mentions });
  }

  setPinned(messageId: string, pinned: boolean): Promise<{ pins: PinnedMessage[] }> {
    return this.socket.request('message:pin', { messageId, pinned });
  }

  async setSaved(messageId: string, saved: boolean): Promise<void> {
    await firstValueFrom(this.http.put(`${this.api}/messages/${messageId}/save`, { saved }));
  }

  async savedMessages(before?: string | null): Promise<{ items: any[]; nextCursor: string | null }> {
    let params = new HttpParams();
    if (before) {
      params = params.set('before', before);
    }
    const res = await firstValueFrom(this.http.get<{ data: { items: any[]; nextCursor: string | null } }>(`${this.api}/saved-messages`, { params }));
    for (const item of res.data.items) await this.e2ee.revealRef(item);
    return res.data;
  }

  // ---------------------------------------------------------------- search / jump
  /**
   * Search a conversation ON THIS DEVICE: messages are end-to-end encrypted, so the server can't search
   * them. History is fetched page by page (decrypted in memory by UserService) and matched here; nothing
   * decrypted is stored. The cursor is the next history page. Scans at most SEARCH_SCAN_PAGES pages per
   * call so a long history stays responsive ("Load more" continues).
   */
  async search(conversationId: string, query: string, cursor: SearchCursor | null, limit: number): Promise<SearchPage> {
    const needle = query.trim().toLowerCase();
    const results: SearchResult[] = [];
    if (!needle) return { results, nextCursor: null };
    let page = cursor ? Number(cursor.before) || 1 : 1;
    for (let scanned = 0; scanned < SEARCH_SCAN_PAGES; scanned++, page++) {
      const res: any = await firstValueFrom(this.users.getMessages(conversationId, page, SEARCH_PAGE_SIZE));
      const items: any[] = res?.data || [];
      for (const m of [...items].reverse()) {
        if (m.isDeleted || m.type === 'system' || (m.e2ee && m.e2eeState !== 'ok')) continue;
        const haystack = `${m.content || ''} ${m.fileName || ''}`.toLowerCase();
        if (haystack.includes(needle)) {
          results.push({ _id: String(m._id), content: m.content || m.fileName || '', type: m.type, createdAt: m.createdAt, user: { _id: String(m.user?._id || m.userId), username: m.user?.username, avatar: m.user?.avatar } });
        }
      }
      if (items.length < SEARCH_PAGE_SIZE) return { results, nextCursor: null };
      if (results.length >= limit) return { results, nextCursor: { before: String(page + 1), beforeId: '' } };
    }
    return { results, nextCursor: { before: String(page), beforeId: '' } };
  }

  /** Number of newer messages, so the history can be loaded down to this message. */
  async position(conversationId: string, messageId: string): Promise<number> {
    const res = await firstValueFrom(
      this.http.get<{ data: { newerCount: number } }>(`${this.api}/messages/${conversationId}/position/${messageId}`)
    );
    return res.data.newerCount;
  }
}
