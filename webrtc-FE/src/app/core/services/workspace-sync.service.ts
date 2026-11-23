import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Observable, Subject, Subscription, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { RAW_ERRORS } from '../interceptors/error.interceptor';
import { ClerkService, WORKSPACE_KEY } from './clerk.service';
import { clearStoredSession } from './auth.service';
import { SocketService } from './socket.service';

/**
 * Keeps organization views current without reloads, and keeps the tab in a workspace it may see.
 *
 * Server events are invalidation signals (ids only); views refetch through the REST API, which applies
 * the caller's permissions. A view says which topics it shows and refetches when one changes.
 *   org            overview (name, description, settings, policies, permissions, member count)
 *   members        member list           invitations / requests   admin lists
 *   teams          team list             team:<id> / teamMembers:<id> / channels:<teamId>
 *   mine           my organizations (switcher)   myInvitations / myRequests   join page
 *   *              everything (after a socket reconnect: events may have been missed)
 *
 * Leaving the workspace (removed, organization deleted, access refused after a server disconnect,
 * switched in another tab) always ends in a full page load, so no data from it stays in memory.
 */
export type SyncTopic = string;

const EVENT_TOPICS: Record<string, (p: { teamId?: string }) => SyncTopic[]> = {
  'org:updated': () => ['org', 'mine'],
  'org:members-changed': () => ['members', 'org'],
  'org:role-changed': () => ['org', 'members', 'mine', 'teams', 'invitations', 'requests'],
  'org:invitations-changed': () => ['invitations'],
  'org:join-request-created': () => ['requests'],
  'org:join-requests-changed': () => ['requests'],
  'org:joined': () => ['mine', 'myInvitations', 'myRequests'],
  'org:invitation': () => ['myInvitations'],
  'org:invitation-revoked': () => ['myInvitations'],
  'org:join-request': () => ['myRequests', 'mine'],
  'team:changed': (p) => ['teams', `team:${p.teamId}`, `channels:${p.teamId}`],
  'team:members-changed': (p) => ['teams', `team:${p.teamId}`, `teamMembers:${p.teamId}`],
  'team:channels-changed': (p) => [`channels:${p.teamId}`],
  'team:joined': (p) => ['teams', `team:${p.teamId}`, `teamMembers:${p.teamId}`, `channels:${p.teamId}`],
  'team:removed': (p) => ['teams', `team:${p.teamId}`, `teamMembers:${p.teamId}`, `channels:${p.teamId}`],
  'channel:created': (p) => [`channels:${p.teamId}`],
  'channel:joined': (p) => [`channels:${p.teamId}`],
  'channel:members-changed': (p) => [`channels:${p.teamId}`],
  'channel:removed': (p) => [`channels:${p.teamId}`],
};

const WORKSPACE_EVENTS = new Set(['org:updated', 'org:members-changed', 'org:role-changed', 'org:invitations-changed', 'org:join-request-created', 'org:join-requests-changed']);

/** Message shown once after the reload (read by the shell). */
export const NOTICE_KEY = 'spreewe.notice';

/** Full-page navigation, replaceable in tests. */
export const workspaceNavigation = { assign: (url: string) => window.location.assign(url) };

@Injectable({ providedIn: 'root' })
export class WorkspaceSyncService implements OnDestroy {
  private readonly topics$ = new Subject<SyncTopic>();
  /** Topics whose data changed on the server ('*' = everything). */
  readonly changes$: Observable<SyncTopic> = this.topics$.asObservable();

  /** Organization (tenant) id of the active workspace, once known; null in the personal context. */
  activeOrganizationId: string | null = null;

  private subs: Subscription | null = null;
  private leaving = false;
  private onStorage = (e: StorageEvent) => this.zone.run(() => this.storageChanged(e));

  constructor(private socket: SocketService, private clerk: ClerkService, private http: HttpClient, private zone: NgZone) {}

  /** Called once by the shell. Idempotent. */
  start(): void {
    if (this.subs) return;
    this.subs = new Subscription();
    for (const [event, toTopics] of Object.entries(EVENT_TOPICS)) {
      this.subs.add(this.socket.onEvent<{ organizationId?: string; teamId?: string }>(event).subscribe((p) => {
        // Workspace events must be about the workspace this tab shows (the server only sends them there;
        // this is the second check). Notices about my own memberships may name any organization.
        if (WORKSPACE_EVENTS.has(event) && this.activeOrganizationId && p?.organizationId !== this.activeOrganizationId) {
          return;
        }
        toTopics(p || {}).forEach((t) => this.topics$.next(t));
      }));
    }
    // Own membership ended: leave this workspace (only when it is the one this tab shows)
    for (const event of ['org:removed', 'org:deleted']) {
      this.subs.add(this.socket.onEvent<{ organizationId: string; reason?: string }>(event).subscribe((p) => {
        this.topics$.next('mine');
        if (this.clerk.pinnedOrganization && p?.organizationId && p.organizationId === this.activeOrganizationId) {
          void this.leaveWorkspace(event === 'org:deleted'
            ? 'This organization was deleted, so you\'re in your personal workspace.'
            : p.reason === 'left' ? 'You left the organization.' : 'You were removed from the organization, so you\'re in your personal workspace.');
        }
      }));
    }
    // After a reconnect, events may have been missed: every open view refetches
    let connectedBefore = false;
    this.subs.add(this.socket.onConnect().subscribe(() => {
      if (connectedBefore) this.topics$.next('*');
      connectedBefore = true;
    }));
    // The server closed the socket (removed, organization deleted, revoked): find out where we stand
    this.subs.add(this.socket.onDisconnect().subscribe((reason) => {
      if (reason === 'io server disconnect') void this.recheckAccess();
    }));
    this.subs.add(this.clerk.workspaceChanged$.subscribe(() => this.reloadForWorkspaceChange()));
    this.subs.add(this.clerk.accountChanged$.subscribe(() => this.restartForAccount('You switched account.')));
    window.addEventListener('storage', this.onStorage);
  }

  ngOnDestroy(): void {
    this.subs?.unsubscribe();
    this.subs = null;
    window.removeEventListener('storage', this.onStorage);
  }

  /** Leave the current organization view: personal workspace, full reload, notice shown once. */
  async leaveWorkspace(notice: string): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    setNotice(notice);
    await this.clerk.setActiveOrganization(null).catch(() => undefined);
    workspaceNavigation.assign('/chat');
  }

  private async recheckAccess(): Promise<void> {
    if (!this.clerk.pinnedOrganization) {
      this.socket.connectWithToken();
      return;
    }
    try {
      await firstValueFrom(this.http.get(`${environment.apiUrl}/v1/workspace`, { context: new HttpContext().set(RAW_ERRORS, true) }));
      this.socket.connectWithToken();
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      // A network problem is not a refusal: the socket's own retry handles it
      if (status === 0 || status === undefined) {
        this.socket.connectWithToken();
        return;
      }
      await this.leaveWorkspace('You no longer have access to that organization, so you\'re in your personal workspace.');
    }
  }

  private storageChanged(e: StorageEvent): void {
    if (e.key !== WORKSPACE_KEY || !e.newValue) return;
    try {
      const { organizationId } = JSON.parse(e.newValue) as { organizationId: string | null };
      if ((organizationId ?? null) !== this.clerk.pinnedOrganization) this.reloadForWorkspaceChange();
    } catch {
      // ignore malformed values
    }
  }

  /**
   * The browser now uses another account (added, switched or signed out, here or in another tab):
   * forget this account's cached user and restart, so nothing of it (chats, keys, socket) stays in memory.
   */
  restartForAccount(notice: string): void {
    if (this.leaving) return;
    this.leaving = true;
    clearStoredSession();
    setNotice(notice);
    workspaceNavigation.assign('/chat');
  }

  /** The session now belongs to another workspace (switched in another tab): show nothing more from this one. */
  private reloadForWorkspaceChange(): void {
    if (this.leaving) return;
    this.leaving = true;
    setNotice('Your workspace was switched in another tab.');
    workspaceNavigation.assign('/');
  }
}

function setNotice(text: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, text);
  } catch {
    // no storage: the reload still happens
  }
}

/** The pending notice, removed as it is read. */
export function takeNotice(): string | null {
  try {
    const text = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return text;
  } catch {
    return null;
  }
}

/**
 * Per-view refetch coordinator. Changes are coalesced (one load per burst); while the view's own
 * mutation is in flight, signals wait and the view reloads once after it (success or failure), so a
 * mutation's response and its echoing socket event cost one request and leave no stale state.
 * Lists are always replaced from the server, never appended to, so nothing is duplicated.
 */
export class ViewRefresher {
  private pending = new Set<SyncTopic>();
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private destroyed = false;

  constructor(private readonly load: (topics: Set<SyncTopic>) => Promise<void>, private readonly delayMs = 120) {}

  notify(topic: SyncTopic): void {
    if (this.destroyed) return;
    this.pending.add(topic);
    if (this.inFlight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Run a mutation; afterwards the given topics (and anything signalled meanwhile) are reloaded once. */
  async mutate<T>(action: () => Promise<T>, topics: SyncTopic[]): Promise<T> {
    this.inFlight++;
    try {
      return await action();
    } finally {
      topics.forEach((t) => this.pending.add(t));
      this.inFlight--;
      if (!this.inFlight) await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
    }
    if (this.destroyed || !this.pending.size) return;
    const topics = new Set(this.pending);
    this.pending.clear();
    this.running = this.load(topics).catch(() => undefined).finally(() => (this.running = null));
    await this.running;
    if (this.pending.size && !this.inFlight) await this.flush();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
  }
}

/** Does a set of changed topics touch any of these (prefix match for per-id topics, '*' = all)? */
export function touches(topics: Set<SyncTopic>, ...wanted: SyncTopic[]): boolean {
  return topics.has('*') || wanted.some((w) => topics.has(w));
}
