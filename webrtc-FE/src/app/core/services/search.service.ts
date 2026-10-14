import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';

export type SearchCategory = 'users' | 'chats' | 'messages' | 'files' | 'meetings';

export interface SearchUser {
  _id: string;
  username: string;
  avatar?: string;
  isOnline?: boolean;
  status?: string;
  statusMessage?: string;
  autoAway?: boolean;
}

export interface SearchChat {
  _id: string;
  isGroup: boolean;
  title: string;
  avatar?: string;
  memberCount?: number;
  isOnline?: boolean;
}

export interface SearchMessage {
  _id: string;
  conversationId: string;
  conversationTitle: string;
  isGroup: boolean;
  content: string;
  type: string;
  createdAt: string;
  user: { _id: string; username?: string; avatar?: string };
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  downloadUrl?: string;
}

export interface SearchMeeting {
  _id: string;
  title: string;
  startAt: string;
  endAt: string;
  recurring: boolean;
  conversationId: string;
  code: string;
}

export interface SearchResults {
  users: SearchUser[];
  chats: SearchChat[];
  messages: SearchMessage[];
  files: SearchMessage[];
  meetings?: SearchMeeting[];
}

export interface SearchFilters {
  types?: SearchCategory[];
  from?: Date | null;
  to?: Date | null;
  senderId?: string | null;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class SearchService {
  constructor(private http: HttpClient) {}

  search(q: string, filters: SearchFilters = {}): Observable<SearchResults> {
    let params = new HttpParams().set('q', q);
    if (filters.types?.length) params = params.set('types', filters.types.join(','));
    if (filters.from) params = params.set('from', filters.from.toISOString());
    if (filters.to) params = params.set('to', filters.to.toISOString());
    if (filters.senderId) params = params.set('sender', filters.senderId);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http
      .get<{ data: SearchResults }>(`${environment.apiUrl}/search`, {
        params,
        // The search panel shows its own inline error state
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      })
      .pipe(map((res) => res.data));
  }
}
