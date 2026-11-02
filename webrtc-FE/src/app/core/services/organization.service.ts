import { Injectable } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';

/**
 * SpreeWe-managed organizations, teams and channels (/v1). Every permission is enforced by the server;
 * the UI only hides what the server would refuse. See docs/organizations/organization-api.md.
 */
export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type JoinPolicy = 'invite' | 'request' | 'open';

export interface OrgCard {
  organizationId: string;
  clerkOrgId: string;
  name: string;
  slug: string;
  description: string;
  avatar: string;
  discoverable: boolean;
  joinPolicy: JoinPolicy;
}

export interface OrgSettings {
  discoverable: boolean;
  joinPolicy: JoinPolicy;
  allowedEmailDomains: string[];
  membersCanInvite: boolean;
  membersCanCreateTeams: boolean;
  guestAccess: boolean;
  joinCodeEnabled: boolean;
  joinCodeSet?: boolean;
}

export interface OrgOverview extends OrgCard {
  role: OrgRole;
  memberCount: number;
  policies: Record<string, boolean>;
  settings?: OrgSettings;
  permissions: Record<string, boolean>;
  invitableRoles: OrgRole[];
}

export interface OrgMember { userId: string; username: string; avatar: string; role: OrgRole; status: string; joinedAt: string; source: string | null }
export interface OrgInvitation { invitationId: string; email: string; role: OrgRole; status: string; expiresAt: string; createdAt: string; sentCount: number }
export interface InviteResult { email: string; status: 'invited' | 'already_member' | 'domain_not_allowed'; invitationId?: string; link?: string; emailed?: boolean }
export interface JoinRequestRow { requestId: string; userId: string; username: string; email: string; message: string; status: string; createdAt: string }
export interface Team { teamId: string; name: string; description: string; avatar: string; visibility: 'public' | 'private'; memberCount?: number; myRole: string | null; canManage?: boolean; settings?: { membersCanCreateChannels: boolean; membersCanAddMembers: boolean } }
export interface Channel { channelId: string; name: string; description: string; type: 'standard' | 'private' | 'shared'; external: boolean; memberCount: number; isMember: boolean; isFavorite?: boolean }

@Injectable({ providedIn: 'root' })
export class OrganizationService {
  private readonly api = `${environment.apiUrl}/v1`;

  constructor(private http: HttpClient) {}

  /** quiet = the caller shows the error inline (no toast) */
  private async get<T>(path: string, quiet = true): Promise<T> {
    const res = await firstValueFrom(this.http.get<{ data: T }>(`${this.api}${path}`, quiet ? { context: new HttpContext().set(SKIP_ERROR_TOAST, true) } : {}));
    return res.data;
  }

  private async page<T>(path: string): Promise<T[]> {
    const res = await firstValueFrom(this.http.get<{ data: T[] }>(`${this.api}${path}`, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }));
    return res.data;
  }

  private async send<T>(method: 'post' | 'patch', path: string, body: unknown = {}): Promise<T> {
    const res = await firstValueFrom(this.http.request<{ data: T }>(method.toUpperCase(), `${this.api}${path}`, { body, context: new HttpContext().set(SKIP_ERROR_TOAST, true) }));
    return res.data;
  }

  // ---- any context
  create = (body: { name: string; slug: string; description?: string; discoverable?: boolean; joinPolicy?: JoinPolicy; allowExternalChat?: boolean }) =>
    this.send<{ organizationId: string; clerkOrgId: string; name: string; slug: string }>('post', '/organizations', body);
  mine = () => this.get<(OrgCard & { role: OrgRole; managedBy: string; status: string; active: boolean })[]>('/organizations/mine');
  discover = (q: string) => this.get<(OrgCard & { myStatus: 'member' | 'requested' | 'none' })[]>(`/organizations/discover?q=${encodeURIComponent(q)}`);
  join = (organizationId: string, code?: string) => this.send<OrgCard & { role: OrgRole; outcome: string }>('post', `/organizations/${organizationId}/join`, code ? { code } : {});
  requestToJoin = (organizationId: string, message?: string) => this.send<{ requestId: string }>('post', `/organizations/${organizationId}/join-requests`, message ? { message } : {});
  myRequests = () => this.get<{ requestId: string; status: string; createdAt: string; organization: OrgCard }[]>('/me/join-requests');
  cancelRequest = (requestId: string) => this.send<{ cancelled: boolean }>('post', `/me/join-requests/${requestId}/cancel`);
  myInvitations = () => this.get<(OrgCard & { invitationId: string; role: OrgRole; expiresAt: string })[]>('/me/organization-invitations');
  previewInvitation = (ref: { token?: string; invitationId?: string }) => this.send<OrgCard & { invitationId: string; role: OrgRole; expiresAt: string }>('post', '/organization-invitations/preview', ref);
  acceptInvitation = (ref: { token?: string; invitationId?: string }) => this.send<OrgCard & { role: OrgRole; outcome: string }>('post', '/organization-invitations/accept', ref);

  // ---- active organization
  overview = () => this.get<OrgOverview>('/workspace/organization');
  update = (body: Partial<{ name: string; description: string; slug: string; settings: Partial<OrgSettings> }>) => this.send<OrgOverview>('patch', '/workspace/organization', body);
  updatePolicies = (body: Record<string, boolean>) => this.send<unknown>('patch', '/workspace/policies', body);
  remove = (confirm: string) => this.send<{ deleted: boolean }>('post', '/workspace/organization/delete', { confirm });
  transfer = (userId: string) => this.send<{ owner: string }>('post', '/workspace/organization/transfer', { userId });
  leave = () => this.send<{ left: boolean }>('post', '/workspace/leave');
  members = () => this.page<OrgMember>('/workspace/organization/members?limit=100');
  setRole = (userId: string, role: OrgRole) => this.send<{ role: OrgRole }>('patch', `/workspace/organization/members/${userId}`, { role });
  removeMember = (userId: string) => this.send<{ removed: boolean }>('post', `/workspace/organization/members/${userId}/remove`);
  invite = (emails: string[], role: OrgRole, expiresInDays?: number) => this.send<{ results: InviteResult[] }>('post', '/workspace/invitations', { emails, role, ...(expiresInDays ? { expiresInDays } : {}) });
  invitations = (status?: string) => this.page<OrgInvitation>(`/workspace/invitations?limit=100${status ? `&status=${status}` : ''}`);
  resendInvitation = (id: string) => this.send<{ link: string; emailed: boolean }>('post', `/workspace/invitations/${id}/resend`);
  revokeInvitation = (id: string) => this.send<{ revoked: boolean }>('post', `/workspace/invitations/${id}/revoke`);
  joinRequests = (status = 'pending') => this.get<JoinRequestRow[]>(`/workspace/join-requests?status=${status}`);
  decide = (requestId: string, approve: boolean) => this.send<{ status: string }>('post', `/workspace/join-requests/${requestId}/${approve ? 'approve' : 'reject'}`);
  setJoinCode = (enable: boolean) => this.send<{ enabled: boolean; code?: string; link?: string }>('post', '/workspace/join-code', { enable });
  audit = () => this.page<{ id: string; action: string; actorId: string | null; target: Record<string, unknown>; at: string }>('/workspace/audit?limit=100');

  // ---- teams & channels
  teams = () => this.get<Team[]>('/teams');
  createTeam = (body: { name: string; description?: string; visibility?: 'public' | 'private' }) => this.send<{ teamId: string }>('post', '/teams', body);
  team = (teamId: string) => this.get<Team>(`/teams/${teamId}`);
  updateTeam = (teamId: string, body: Partial<Team>) => this.send<Team>('patch', `/teams/${teamId}`, body);
  archiveTeam = (teamId: string) => this.send<{ archived: boolean }>('post', `/teams/${teamId}/archive`);
  joinTeam = (teamId: string) => this.send<{ joined: boolean }>('post', `/teams/${teamId}/join`);
  teamMembers = (teamId: string) => this.get<{ userId: string; username: string; avatar: string; role: string }[]>(`/teams/${teamId}/members`);
  addTeamMembers = (teamId: string, userIds: string[], role = 'member') => this.send<{ added: number }>('post', `/teams/${teamId}/members`, { userIds, role });
  setTeamRole = (teamId: string, userId: string, role: string) => this.send<unknown>('patch', `/teams/${teamId}/members/${userId}`, { role });
  removeTeamMember = (teamId: string, userId: string) => this.send<unknown>('post', `/teams/${teamId}/members/${userId}/remove`);
  channels = (teamId: string) => this.get<Channel[]>(`/teams/${teamId}/channels`);
  createChannel = (teamId: string, body: { name: string; description?: string; type: Channel['type']; memberIds?: string[]; externalUserIds?: string[] }) => this.send<Channel>('post', `/teams/${teamId}/channels`, body);
  addChannelMembers = (teamId: string, channelId: string, userIds: string[]) => this.send<unknown>('post', `/teams/${teamId}/channels/${channelId}/members`, { userIds });
  removeChannelMember = (teamId: string, channelId: string, userId: string) => this.send<unknown>('post', `/teams/${teamId}/channels/${channelId}/members/${userId}/remove`);
  deleteChannel = (teamId: string, channelId: string) => this.send<unknown>('post', `/teams/${teamId}/channels/${channelId}/delete`);
}

/** The human message of an error thrown by the HTTP layer (the interceptor rethrows safe strings). */
export function errorText(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (typeof e === 'string' && e.trim()) return e;
  const anyE = e as { error?: { error?: { message?: string }; message?: string }; message?: string };
  return anyE?.error?.error?.message || anyE?.error?.message || fallback;
}
