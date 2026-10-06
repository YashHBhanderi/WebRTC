import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SocketService } from './socket.service';
import { ChatState, GroupSummary, SearchCursor, SearchPage } from '../interfaces/chat';

/**
 * Chat state, contact and group administration, and server-side message search.
 * Mutations go over acknowledged socket events (chat:*, group:*); reads use REST.
 * The server re-checks every permission — this service only carries intent.
 */
@Injectable({ providedIn: 'root' })
export class ChatActionsService {
  private readonly api = environment.apiUrl;

  constructor(private socket: SocketService, private http: HttpClient) {}

  // ---------------------------------------------------------------- per-user chat state
  archive(conversationId: string, archived: boolean): Promise<{ state: ChatState }> {
    return this.socket.request(archived ? 'chat:archive' : 'chat:unarchive', { conversationId });
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

  // ---------------------------------------------------------------- search / jump
  async search(conversationId: string, query: string, cursor: SearchCursor | null, limit: number): Promise<SearchPage> {
    let params = new HttpParams().set('q', query).set('limit', String(limit));
    if (cursor) {
      params = params.set('before', cursor.before).set('beforeId', cursor.beforeId);
    }
    const res = await firstValueFrom(this.http.get<{ data: SearchPage }>(`${this.api}/messages/${conversationId}/search`, { params }));
    return res.data;
  }

  /** Number of newer messages, so the history can be loaded down to this message. */
  async position(conversationId: string, messageId: string): Promise<number> {
    const res = await firstValueFrom(
      this.http.get<{ data: { newerCount: number } }>(`${this.api}/messages/${conversationId}/position/${messageId}`)
    );
    return res.data.newerCount;
  }
}
