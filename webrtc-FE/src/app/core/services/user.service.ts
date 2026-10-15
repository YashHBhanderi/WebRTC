import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, filter, share, switchMap, take } from 'rxjs';
import { environment } from 'src/environments/environment';
import { IUser } from '../interfaces/user';
import { IConversation } from '../interfaces/conversation';
import { IApiResponse } from '../interfaces/apiResponse';
import { Router } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
@Injectable({
  providedIn: 'root'
})
export class UserService {
  private apiUrl = environment.apiUrl;

  /** Accounts created while the app is open (never me); merge with `withUser` to stay duplicate-free. */
  readonly newUsers$: Observable<IUser>;
  /**
   * The socket came back after a disconnect: events may have been missed, so user lists should
   * reload from the API. (Not emitted for the first connect.)
   */
  readonly reconnected$: Observable<unknown>;

  constructor(
    private http: HttpClient,
    private router: Router,
    private alertService: AlertService,
    private socket: SocketService,
    private auth: AuthService,
  ) {
    this.newUsers$ = this.socket.onUserCreated().pipe(
      filter((u: IUser) => !!u?._id && String(u._id) !== String(this.auth.getLoggedInUser()?._id || '')),
      share(),
    );
    this.reconnected$ = this.socket.onDisconnect().pipe(
      switchMap(() => this.socket.onConnect().pipe(take(1))),
      share(),
    );
  }

  /** `list` with `user` added (or updated in place when already there) — safe for repeated events. */
  static withUser<T extends { _id?: string }>(list: T[], user: T): T[] {
    const id = String(user._id);
    const index = list.findIndex((u) => String(u._id) === id);
    if (index === -1) {
      return [...list, user];
    }
    const next = [...list];
    next[index] = { ...next[index], ...user };
    return next;
  }

  // The Clerk session token is added by AuthInterceptor
  getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'skipInterceptorToast': 'true'
    });
  }

  groupCreatHeaders(): HttpHeaders {
    return new HttpHeaders();
  }

  getUsers(): Observable<IUser[]> {
    return this.http.get<IUser[]>(`${this.apiUrl}/web/users`, { headers: this.getHeaders() });
  }

  getUserConversations(archived = false): Observable<IApiResponse<IConversation[]>> {
    return this.http.get<IApiResponse<IConversation[]>>(`${this.apiUrl}/conversations${archived ? '?archived=true' : ''}`, { headers: this.getHeaders() });
  }

  getMessages(conversationId: string, page: number = 1, pageSize: number = 20): Observable<any> {
    return this.http.get(`${this.apiUrl}/messages/${conversationId}?page=${page}&limit=${pageSize}`, { headers: this.getHeaders() });
  }

  getUserById(userId: string): Observable<IApiResponse<IUser>> {
    return this.http.get<IApiResponse<IUser>>(`${this.apiUrl}/web/user/${userId}`, { headers: this.getHeaders() });
  }

  getAllUsersExceptCurrentUser(): Observable<IApiResponse<IUser[]>> {
    return this.http.get<IApiResponse<IUser[]>>(`${this.apiUrl}/web/users/except-current`, { headers: this.getHeaders() });
  }

  createOrGetConversation(receiverId: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/conversations`, { receiverId }, { headers: this.getHeaders() });
  }

  createGroup(formData: FormData): Observable<IApiResponse<IConversation>> {
    return this.http.post<IApiResponse<IConversation>>(`${this.apiUrl}/conversations/group`, formData, { headers: this.groupCreatHeaders() });
  }

  addMembersToGroup(conversationId: string, userIds: string[]): Observable<any> {
    return this.http.put(`${this.apiUrl}/conversations/group/${conversationId}/add-member`, { userIds }, { headers: this.getHeaders() });
  }

  removeMemberFromGroup(conversationId: string, userId: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/conversations/group/${conversationId}/remove-member`, { userId }, { headers: this.getHeaders() });
  }

  getUserGropuConversations(archived = false): Observable<IApiResponse<IConversation[]>> {
    return this.http.get<IApiResponse<IConversation[]>>(`${this.apiUrl}/groupConversations${archived ? '?archived=true' : ''}`, { headers: this.getHeaders() });
  }

  getGroupInfo(conversationId: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/conversations/${conversationId}/group`, { headers: this.getHeaders() });
  }

  deleteMessage(messageId: string): Observable<IApiResponse<null>> {
    return this.http.delete<IApiResponse<null>>(`${this.apiUrl}/messages/${messageId}`, { headers: this.getHeaders() });
  }

  deleteConversation(conversationId: string): Observable<IApiResponse<null>> {
    return this.http.delete<IApiResponse<null>>(`${this.apiUrl}/conversations/${conversationId}`, { headers: this.getHeaders() });
  }

  updateProfile(formData: FormData): Observable<IApiResponse<IUser>> {
    return this.http.patch<IApiResponse<IUser>>(`${this.apiUrl}/web/user/profile`, formData, { headers: this.groupCreatHeaders() });
  }

  getSharedMedia(conversationId: string): Observable<IApiResponse<any[]>> {
    return this.http.get<IApiResponse<any[]>>(`${this.apiUrl}/conversations/${conversationId}/media`, { headers: this.getHeaders() });
  }

}
