import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';
import { IUser } from '../interfaces/user';
import { IConversation } from '../interfaces/conversation';
import { IApiResponse } from '../interfaces/apiResponse';
import { Router } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
@Injectable({
  providedIn: 'root'
})
export class UserService {
  private apiUrl = environment.apiUrl;
  private tokenKey = 'auth_token';

  constructor(
    private http: HttpClient,
    private router: Router,
    private alertService: AlertService,

  ) { }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  getHeaders(): HttpHeaders {
    const token = this.getToken();
    if (!token) {
      this.router.navigate(['/auth/login']);
      this.alertService.error('You need to be logged in to access this page.');
    }
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'skipInterceptorToast': 'true'
    });
  }

  groupCreatHeaders(): HttpHeaders {
    const token = this.getToken();
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  getUsers(): Observable<IUser[]> {
    return this.http.get<IUser[]>(`${this.apiUrl}/web/users`, { headers: this.getHeaders() });
  }

  getUserConversations(): Observable<IApiResponse<IConversation[]>> {
    return this.http.get<IApiResponse<IConversation[]>>(`${this.apiUrl}/conversations`, { headers: this.getHeaders() });
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

  getUserGropuConversations(): Observable<IApiResponse<IConversation[]>> {
    return this.http.get<IApiResponse<IConversation[]>>(`${this.apiUrl}/groupConversations`, { headers: this.getHeaders() });
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

  getJitsiToken(roomName: string): Observable<{ status: boolean, allowed: boolean, jwt: string, roomName: string }> {
    return this.http.get<any>(`${this.apiUrl}/jitsi-room/${roomName}`, { headers: this.getHeaders() });
  }

  updateProfile(formData: FormData): Observable<IApiResponse<IUser>> {
    return this.http.patch<IApiResponse<IUser>>(`${this.apiUrl}/web/user/profile`, formData, { headers: this.groupCreatHeaders() });
  }

  getSharedMedia(conversationId: string): Observable<IApiResponse<any[]>> {
    return this.http.get<IApiResponse<any[]>>(`${this.apiUrl}/conversations/${conversationId}/media`, { headers: this.getHeaders() });
  }

}
